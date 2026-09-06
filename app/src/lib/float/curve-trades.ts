/**
 * Price history for a launched token, read from the chain's own logs.
 *
 * Why this exists at all: the token page asks `/candles`, that path falls
 * through to the indexer proxy, and the indexer on this venue does not index
 * `CurveBuy` or `CurveSell`. It answers `[]` for every token, and `[]` is
 * indistinguishable from "this token has never traded", so the chart printed
 * "Chart will appear after first trade" over tokens whose first trade is on
 * chain and findable. SNOOZE's is at block 54508853. That is the whole bug: a
 * dependency that cannot answer the question, answering it anyway with a zero.
 *
 * So the price comes from the events themselves. A curve trade is denominated
 * in USDG on this venue, which makes it exact: no oracle, no cross-rate, no
 * mark. `usdgIn / tokensOut` is what the buyer actually paid per token, in
 * dollars, in that transaction.
 *
 * The one judgement here is gross vs net of fee. These prints are GROSS, what
 * the trader paid, because that is what the event states and what a chart of
 * "what did it cost" should show. Netting the fee out would need `feeBps` as it
 * was at that block, not as it is now, and would put the fee split in a second
 * home. See the 7d-fees finding: the same number can be right about the wrong
 * subject.
 */

import type { Address } from "viem";
import { CURVEFUNDER_ABI } from "./abi";
import { publicClient } from "./chain";
import { launcherHolding } from "./token-owner";
import type { CurveFunderCurve } from "./curve-funder";
import { resolve } from "./registry";
import { withRetry, mapLimited, isRateLimited } from "./retry";
import { poolsForToken, type TokenPool } from "./token-pools";
import { cfCurve } from "./curve-funder";
import fs from "node:fs";
import os from "node:os";

export interface PricePoint {
  /** Block timestamp, unix seconds. */
  ts: number;
  block: number;
  /** USD per token. Exact: the curve is quoted in USDG. */
  priceUsd: number;
  /** USDG moved in this trade, whole dollars. */
  volumeUsd: number;
  side: "buy" | "sell";
  /** Which market the print came from. */
  venue: "curve" | "pool";
  txHash: `0x${string}`;
  /**
   * Who traded. On the curve this is the event's own `who`. In a v4 pool the
   * Swap event's `sender` is the ROUTER, not the person, so the transaction's
   * sender is read instead: naming the router as the trader would be a real
   * address about the wrong subject, and every holder row would say the same
   * thing.
   */
  trader: `0x${string}`;
  /** Tokens moved, whole units. */
  tokens: number;
}

export interface PriceHistory {
  points: PricePoint[];
  /**
   * Why a source could not be read, so a caller can say "we could not ask"
   * rather than rendering an empty chart that means "never traded". An
   * unreachable RPC and a token with no trades must not look the same.
   */
  unreadable: string[];
  /** Which launcher holds this token, once resolved. */
  launcher: Address | null;
  /** The curve as read while resolving the launcher, so callers need not re-read it. */
  curve: CurveFunderCurve | null;
  /**
   * The price this curve opened at, and when.
   *
   * A constant-product curve with virtual reserves quotes a real price from the
   * moment it exists: at launch `rQuote` and `sold` are both zero, so the price
   * is exactly `vQuote / vToken`, and the virtual reserves never change. That
   * is a genuine quote anyone could have bought at, not a modelled number.
   *
   * It is kept OUT of `points` deliberately. `points` are prints, and they feed
   * the trade counts, the buys/sells bars and the Transactions tab; putting a
   * non-trade in there would fabricate a trade that never happened. It seeds
   * the chart's opening candle and nothing else.
   */
  launch: { ts: number; priceUsd: number } | null;
  /** The block this series was scanned up to, so a refresh can start after it. */
  head?: bigint;
}

/** USDG is 6dp, the launched token is 18dp. */
const USDG_UNIT = 1e6;
const TOKEN_UNIT = 1e18;

const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

/**
 * All history for one address-and-topic filter.
 *
 * Measured against this chain's public RPC: block 0 to latest for one address
 * and one topic comes back in a single call in about 250ms. So the default is
 * one call, and there is deliberately no start-block constant. This repo has
 * already paid for one of those: the mainnet indexer carried START_BLOCK
 * 54796533 against a first log at 54401768 and reported zero listings on a
 * chain holding four. A start block that is too high does not fail, it silently
 * truncates history.
 *
 * Bisecting `eth_getCode` for the launcher's deployment block was the first
 * attempt and it does not work here: this node is not archival, and a
 * historical state read answers `metadata is not found` rather than a value.
 * Logs are served over the full range regardless, because they are indexed
 * separately from state. That asymmetry is the reason this reads logs and never
 * asks for historical state.
 *
 * The windowed path is the fallback for a node that refuses a wide range. It
 * runs in sequence, since the throttling on this RPC has already killed a
 * backfill process in this project with a single 429.
 */
const WINDOW = 250_000n;

async function allLogs<T>(
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
  head: bigint,
  start: bigint = 0n,
): Promise<T[]> {
  try {
    return await withRetry(() => fetch(start, head), "getLogs full range");
  } catch (e) {
    // Windowing a rate-limited node turns one refused call into hundreds of
    // them. The fallback is for a node that will not serve a WIDE range, which
    // is a different complaint from one that will not serve any more calls.
    if (isRateLimited(e)) throw e;
    const out: T[] = [];
    for (let from = start; from <= head; from += WINDOW + 1n) {
      const end = from + WINDOW > head ? head : from + WINDOW;
      out.push(...(await withRetry(() => fetch(from, end), `getLogs ${from}-${end}`)));
    }
    return out;
  }
}

/**
 * Block timestamps, fetched once ever.
 *
 * A mined block's timestamp cannot change, so this cache has no TTL and needs
 * none: the answer for block N is the same answer forever. It was the single
 * largest cost in a cold chart. getBlock runs 0.26s to 1.29s on this RPC and
 * ran once per unique block on every load, sequentially behind the retry gate,
 * while the getLogs that found those blocks took 0.34s for the whole chain.
 * The scan was never the slow part; asking what time it was, over and over,
 * was.
 *
 * Shared across tokens as well as loads, because two markets that traded in
 * the same block ask the same question.
 */
const blockTsCache = new Map<string, number>();

/**
 * And once ever across process lifetimes, not just within one.
 *
 * A block timestamp is immutable, so it is safe to keep on disk with no
 * invalidation at all. Without this every deploy and every dev-server restart
 * re-buys the same answers, which is the whole of a cold chart's cost. Lives
 * in the temp dir because that is the one writable path both locally and on a
 * serverless host, and losing it is merely slow, never wrong.
 */
const BLOCK_TS_FILE = `${os.tmpdir()}/float-block-times.json`;
let blockTsLoaded = false;
let blockTsDirty = false;

function loadBlockTs() {
  if (blockTsLoaded) return;
  blockTsLoaded = true;
  try {
    const raw = fs.readFileSync(BLOCK_TS_FILE, "utf8");
    for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, number>)) {
      if (typeof v === "number" && v > 0) blockTsCache.set(k, v);
    }
  } catch {
    /* no cache yet, or unreadable. Either way we just fetch. */
  }
}

function saveBlockTs() {
  if (!blockTsDirty) return;
  blockTsDirty = false;
  try {
    fs.writeFileSync(BLOCK_TS_FILE, JSON.stringify(Object.fromEntries(blockTsCache)));
  } catch {
    /* a cache we cannot write is a slower path, not a broken one */
  }
}

async function blockTimes(blocks: bigint[]): Promise<Map<bigint, number>> {
  loadBlockTs();
  const pc = publicClient();
  const unique = [...new Set(blocks.map((b) => b.toString()))].map(BigInt);
  const known = new Map<bigint, number>();
  const missing: bigint[] = [];
  for (const b of unique) {
    const hit = blockTsCache.get(b.toString());
    if (hit !== undefined) known.set(b, hit);
    else missing.push(b);
  }
  if (missing.length) {
    const entries = await mapLimited(missing, async (b) => {
      const block = await withRetry(() => pc.getBlock({ blockNumber: b }), `getBlock(${b})`).catch(
        () => null,
      );
      return [b, block ? Number(block.timestamp) : 0] as const;
    });
    for (const [b, ts] of entries) {
      if (ts > 0) {
        // Only a real answer is remembered. Caching a failed read would pin a
        // zero timestamp on that block for the life of the process.
        blockTsCache.set(b.toString(), ts);
        blockTsDirty = true;
        known.set(b, ts);
      }
    }
    saveBlockTs();
  }
  return known;
}

/**
 * Every curve trade for one token, oldest first.
 *
 * The launcher matters. Three of the four mainnet launches live on the
 * superseded 0xD55E56Be, and reading a legacy token against the current
 * launcher returns a zero struct rather than reverting, so "which contract
 * holds this token" has to be answered before anything is read from it.
 */
export async function curvePriceHistory(
  token: Address,
  /**
   * Scan only from here. Used by the incremental refresh: the logs before this
   * block are already in the cached series, and re-reading the whole chain to
   * find one new trade is what made the chart a minute stale.
   */
  opts: {
    fromBlock?: bigint;
    knownLaunch?: PriceHistory["launch"];
    /**
     * Skip the launcher search. Asking every launcher `curves(token)` is the
     * expensive half of a refresh, and on a refresh the answer is already
     * known: this token has not moved launchers since the series was built.
     */
    knownLauncher?: Address;
  } = {},
): Promise<PriceHistory> {
  const pc = publicClient();
  const unreadable: string[] = [];
  const startBlock = opts.fromBlock ?? 0n;

  // "Which launcher holds this" has three answers, not two, and collapsing the
  // third into "none" is what made this route report a live token as untraded.
  const owner = opts.knownLauncher
    ? {
        kind: "found" as const,
        launcher: opts.knownLauncher,
        superseded: false,
        curve: await cfCurve(token, opts.knownLauncher),
      }
    : await launcherHolding(token);
  if (owner.kind === "unreadable") {
    unreadable.push(`launcher lookup: ${owner.reasons.join("; ")}`);
    return { points: [], unreadable, launcher: null, curve: null, launch: null };
  }
  if (owner.kind === "absent") {
    // Not a curve token on this deployment. That is a real answer, not a gap.
    return { points: [], unreadable, launcher: null, curve: null, launch: null };
  }
  const launcher = owner.launcher;

  const head = await pc.getBlockNumber();
  const buyEvent = eventNamed("CurveBuy");
  const sellEvent = eventNamed("CurveSell");

  // Sequential. These two plus the pool scans used to go out together, and the
  // burst is what earned the 429 that deleted most of the series.
  const buys = await allLogs(
    (f, t) =>
      pc.getLogs({ address: launcher, event: buyEvent, args: { token }, fromBlock: f, toBlock: t }),
    head,
    startBlock,
  ).catch((e) => {
    unreadable.push(`CurveBuy logs: ${message(e)}`);
    return [];
  });
  const sells = await allLogs(
    (f, t) =>
      pc.getLogs({ address: launcher, event: sellEvent, args: { token }, fromBlock: f, toBlock: t }),
    head,
    startBlock,
  ).catch((e) => {
    unreadable.push(`CurveSell logs: ${message(e)}`);
    return [];
  });

  const times = await blockTimes([...buys, ...sells].map((l) => l.blockNumber ?? 0n));
  const points: PricePoint[] = [];

  for (const log of buys) {
    const a = log.args as { usdgIn?: bigint; tokensOut?: bigint; who?: `0x${string}` };
    const ts = times.get(log.blockNumber ?? 0n);
    if (!ts || !a.usdgIn || !a.tokensOut) continue;
    const usd = Number(a.usdgIn) / USDG_UNIT;
    const tokens = Number(a.tokensOut) / TOKEN_UNIT;
    if (tokens <= 0) continue;
    points.push({
      ts,
      block: Number(log.blockNumber),
      priceUsd: usd / tokens,
      volumeUsd: usd,
      side: "buy",
      venue: "curve",
      txHash: log.transactionHash ?? ZERO_HASH,
      trader: a.who ?? ZERO_ADDR,
      tokens,
    });
  }

  for (const log of sells) {
    const a = log.args as { tokensIn?: bigint; usdgOut?: bigint; who?: `0x${string}` };
    const ts = times.get(log.blockNumber ?? 0n);
    if (!ts || !a.tokensIn) continue;
    const tokens = Number(a.tokensIn) / TOKEN_UNIT;
    // A sell can settle in fSHARE rather than USDG, in which case the event's
    // usdgOut is 0 and this trade has no dollar price of its own. Skipping it
    // loses a print; pricing it off today's fSHARE mark would invent one.
    const usd = Number(a.usdgOut ?? 0n) / USDG_UNIT;
    if (tokens <= 0 || usd <= 0) continue;
    points.push({
      ts,
      block: Number(log.blockNumber),
      priceUsd: usd / tokens,
      volumeUsd: usd,
      side: "sell",
      venue: "curve",
      txHash: log.transactionHash ?? ZERO_HASH,
      trader: a.who ?? ZERO_ADDR,
      tokens,
    });
  }

  points.sort((a, b) => a.ts - b.ts || a.block - b.block);

  // When this curve opened, and at what price.
  //
  // The price is exact arithmetic on the curve's own constants. The TIME is the
  // only part that has to be looked up, and TokenLaunched is the sole exact
  // source for it: deriving it from the first trade would place the opening
  // wherever the first buyer happened to arrive, which is a made-up timestamp
  // on a real price. If the log cannot be read we return no anchor at all
  // rather than guessing, and the chart simply starts at the first print.
  let launch: { ts: number; priceUsd: number } | null = opts.knownLaunch ?? null;
  const c = owner.curve;
  if (!launch && c && c.vToken > 0n) {
    const openPrice = (Number(c.vQuote) / USDG_UNIT) / (Number(c.vToken) / TOKEN_UNIT);
    if (Number.isFinite(openPrice) && openPrice > 0) {
      try {
        const launched = await allLogs(
          (f, t) => pc.getLogs({
            address: launcher, event: eventNamed("TokenLaunched"), args: { token },
            fromBlock: f, toBlock: t,
          }),
          head,
        );
        const first = launched[0];
        if (first) {
          const at = await blockTimes([first.blockNumber ?? 0n]);
          const ts = at.get(first.blockNumber ?? 0n);
          if (ts) launch = { ts, priceUsd: openPrice };
        }
      } catch (e) {
        unreadable.push(`TokenLaunched log: ${message(e)}`);
      }
    }
  }

  return { points, unreadable, launcher, curve: owner.curve, launch, head };
}

/**
 * The v4 `Swap` the PoolManager emits. Not generated into abi.ts because the
 * PoolManager is chain infrastructure we did not deploy and there is no forge
 * artifact for it here, the same reason pools.ts carries its own STATE_VIEW_ABI.
 */
const V4_SWAP_EVENT = {
  type: "event",
  name: "Swap",
  inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "amount0", type: "int128", indexed: false },
    { name: "amount1", type: "int128", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "liquidity", type: "uint128", indexed: false },
    { name: "tick", type: "int24", indexed: false },
    { name: "fee", type: "uint24", indexed: false },
  ],
} as const;

const Q96 = 2 ** 96;

/**
 * How much of currency1 one unit of currency0 is worth, in whole units.
 *
 * Checked against numbers the app already displays rather than against the
 * formula alone: DOZE's quote pool sqrtPriceX96 gives 0.0197 fNTDO3 per USDG,
 * so one fNTDO3 is $50.7, which is the $50.00 line NTDO3 is marked at; feeding
 * that through DOZE's meme pool gives $2.7e-7 per DOZE against the $2.5e-7 the
 * board shows. Two independent agreements, so the decimal adjustment is the
 * right way up.
 */
function price1per0(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const ratio = Number(sqrtPriceX96) / Q96;
  return ratio * ratio * 10 ** (decimals0 - decimals1);
}

/** An observation of the fSHARE's dollar price, from the USDG pool's own logs. */
interface QuoteObservation {
  ts: number;
  usdgPerShare: number;
}

/**
 * Post-graduation trades, read from the two v4 pools.
 *
 * A graduated token stops trading on the curve and starts trading in the
 * MEME/fSHARE pool, so a chart built from curve logs alone stops dead at
 * graduation while claiming to be the token's history. SNOOZE is exactly this:
 * one curve buy, then four pool swaps that were nowhere on the page.
 *
 * The dollar price needs two hops, because the meme pool is priced in fSHARE
 * and not in dollars. The second hop comes from the token's OWN USDG/fSHARE
 * pool, at the observation nearest in time to the swap being priced, so the
 * cross-rate is a real chain reading from around that moment rather than
 * today's number wearing a historical timestamp. Where no observation exists
 * the point is dropped and the reason is reported: a missing cross-rate is a
 * gap, and a gap must not be filled with a plausible number.
 */
async function poolPriceHistory(
  token: Address,
  pools: TokenPool[],
  unreadable: string[],
): Promise<PricePoint[]> {
  const meme = pools.find((p) => p.kind === "meme");
  const quote = pools.find((p) => p.kind === "quote");
  if (!meme) return [];

  const pc = publicClient();
  const poolManager = await resolve("V4_POOL_MANAGER").catch(() => null);
  if (!poolManager) {
    unreadable.push("no V4_POOL_MANAGER in the registry, so pool swaps were not read");
    return [];
  }

  const head = await pc.getBlockNumber();
  const swapsFor = (poolId: `0x${string}`) =>
    allLogs(
      (f, t) =>
        pc.getLogs({
          address: poolManager,
          event: V4_SWAP_EVENT,
          args: { id: poolId },
          fromBlock: f,
          toBlock: t,
        }),
      head,
    );

  const memeSwaps = await swapsFor(meme.poolId).catch((e) => {
    unreadable.push(`meme pool swaps: ${message(e)}`);
    return [];
  });
  const quoteSwaps = quote
    ? await swapsFor(quote.poolId).catch((e) => {
        unreadable.push(`quote pool swaps: ${message(e)}`);
        return [];
      })
    : [];

  if (!memeSwaps.length) return [];

  const times = await blockTimes([
    ...memeSwaps.map((l) => l.blockNumber ?? 0n),
    ...quoteSwaps.map((l) => l.blockNumber ?? 0n),
    ...(quote ? [BigInt(quote.initBlock)] : []),
  ]);

  // The fSHARE's dollar price over time. `usdgSide` says which currency is USDG;
  // never infer it from the index, because currencies are ordered by address and
  // USDG is currency0 in some of these pools and currency1 in others.
  const observations: QuoteObservation[] = [];
  if (quote && quote.usdgSide !== null) {
    // The price the pool opened at. A pool with no swaps still has one, and
    // without it a token whose USDG/fSHARE pool has never traded has no
    // cross-rate and loses every pool print it does have. SLEEPY was that case.
    const initSqrt = BigInt(quote.initSqrtPriceX96);
    const initTs = times.get(BigInt(quote.initBlock));
    if (initSqrt > 0n && initTs) {
      const p = price1per0(initSqrt, quote.decimals0, quote.decimals1);
      if (p > 0) {
        observations.push({ ts: initTs, usdgPerShare: quote.usdgSide === 0 ? 1 / p : p });
      }
    }
    for (const log of quoteSwaps) {
      const a = log.args as { sqrtPriceX96?: bigint };
      const ts = times.get(log.blockNumber ?? 0n);
      if (!ts || !a.sqrtPriceX96) continue;
      const p = price1per0(a.sqrtPriceX96, quote.decimals0, quote.decimals1);
      if (!(p > 0)) continue;
      // usdgSide 0 means currency0 is USDG, so p is fSHARE per USDG.
      observations.push({ ts, usdgPerShare: quote.usdgSide === 0 ? 1 / p : p });
    }
    observations.sort((a, b) => a.ts - b.ts);
  }

  if (!observations.length) {
    unreadable.push(
      "no USDG/fSHARE observation for this token, so its pool swaps have no dollar price",
    );
    return [];
  }

  const nearest = (ts: number): QuoteObservation => {
    let best = observations[0];
    for (const o of observations) {
      if (Math.abs(o.ts - ts) < Math.abs(best.ts - ts)) best = o;
    }
    return best;
  };

  const tokenIsCurrency0 = meme.currency0.toLowerCase() === token.toLowerCase();
  const shareDecimals = tokenIsCurrency0 ? meme.decimals1 : meme.decimals0;
  const tokenDecimals = tokenIsCurrency0 ? meme.decimals0 : meme.decimals1;
  const points: PricePoint[] = [];

  // Who actually traded. The Swap event's `sender` is whatever contract called
  // the PoolManager, which for every routed swap is the UniversalRouter, so it
  // is the same address on every row and is not the trader. The transaction's
  // own sender is.
  const senders = new Map<string, `0x${string}`>();
  const hashes = [...new Set(memeSwaps.map((l) => l.transactionHash).filter(Boolean))];
  await mapLimited(hashes as `0x${string}`[], async (h) => {
    const tx = await withRetry(() => pc.getTransaction({ hash: h }), `getTransaction(${h})`).catch(
      () => null,
    );
    if (tx) senders.set(h.toLowerCase(), tx.from);
  });

  for (const log of memeSwaps) {
    const a = log.args as { sqrtPriceX96?: bigint; amount0?: bigint; amount1?: bigint };
    const ts = times.get(log.blockNumber ?? 0n);
    if (!ts || !a.sqrtPriceX96) continue;

    const p = price1per0(a.sqrtPriceX96, meme.decimals0, meme.decimals1);
    if (!(p > 0)) continue;
    // p is currency1 per currency0. We want fSHARE per token.
    const sharePerToken = tokenIsCurrency0 ? p : 1 / p;
    const usdgPerShare = nearest(ts).usdgPerShare;
    const priceUsd = sharePerToken * usdgPerShare;
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;

    // Volume in dollars, from the fSHARE leg, which is the side with a price.
    const shareLeg = tokenIsCurrency0 ? a.amount1 : a.amount0;
    const tokenLeg = tokenIsCurrency0 ? a.amount0 : a.amount1;
    const shares = shareLeg === undefined ? 0 : Math.abs(Number(shareLeg)) / 10 ** shareDecimals;

    points.push({
      ts,
      block: Number(log.blockNumber),
      priceUsd,
      volumeUsd: shares * usdgPerShare,
      // A swap that took the token out of the pool is a buy of the token.
      side: (tokenIsCurrency0 ? (a.amount0 ?? 0n) < 0n : (a.amount1 ?? 0n) < 0n) ? "buy" : "sell",
      venue: "pool",
      txHash: log.transactionHash ?? ZERO_HASH,
      trader: senders.get((log.transactionHash ?? "").toLowerCase()) ?? ZERO_ADDR,
      tokens: Math.abs(Number(tokenLeg ?? 0n)) / 10 ** tokenDecimals,
    });
  }

  return points;
}

/**
 * Caches, and why they are not optional here.
 *
 * `/candles` is not only the token page's chart. `fetchTokenChange24h` calls it
 * once per token to compute a 24h column, so opening a list of five tokens
 * fires five of these at once, and each one wants a full pool enumeration and
 * several log scans. Uncached that is enough traffic to make the public RPC
 * start refusing, and what fails first is not this route: it is whatever else
 * the page was reading. The first symptom was the token page rendering "Token
 * not found" over a token that exists, because `fetchCurveFunderTokens` lost
 * its reads to the throttling this route caused.
 *
 * So: one entry per token, and concurrent callers for the same token share a
 * single in-flight promise rather than each starting their own scan.
 */
/**
 * How long a series is served untouched. Short, because a trader who just
 * bought watches the chart for their own print and a minute of nothing reads
 * as a failed trade: that is exactly the complaint this became.
 *
 * It can be this short only because a refresh no longer rescans the chain. The
 * first build reads every log from genesis and takes seconds; a refresh reads
 * the handful of blocks since the last one and takes milliseconds.
 */
const HISTORY_TTL_MS = 6_000;

/**
 * When to throw the incremental series away and rebuild from genesis.
 *
 * The incremental path keeps the curve it was built with, so a token that
 * graduates in the meantime would keep being priced off a spent curve. A full
 * rebuild on this interval bounds that, and graduation is rare enough that
 * bounding it is enough. A graduated token never takes the incremental path at
 * all, since its series also needs pool swaps.
 */
const FULL_REBUILD_MS = 5 * 60_000;

const historyCache = new Map<string, { at: number; builtAt: number; value: PriceHistory }>();
const historyInflight = new Map<string, Promise<PriceHistory>>();

/**
 * Everything a chart of this token should contain: its curve, then its pool.
 *
 * These are two different markets and the token moved from one to the other, so
 * the series is their union rather than a choice between them. Showing only the
 * curve stops the chart at graduation; showing only the pool throws away how it
 * got there.
 */
export async function tokenPriceHistory(token: Address): Promise<PriceHistory> {
  const key = token.toLowerCase();
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.value;
  const running = historyInflight.get(key);
  if (running) return running;

  const now = Date.now();
  const canExtend =
    hit !== undefined
    && hit.value.head !== undefined
    && hit.value.launcher !== null
    && hit.value.curve?.graduated === false
    && now - hit.builtAt < FULL_REBUILD_MS;

  const job = (canExtend ? extendHistory(token, hit!) : buildPriceHistory(token))
    .then((value) => {
      // Only a successful read is worth remembering. Caching a failure would
      // hold the page on "we could not ask" for a minute after the RPC recovers.
      if (value.points.length || !value.unreadable.length) {
        historyCache.set(key, {
          at: Date.now(),
          // An extension inherits the original build time, so the periodic
          // full rebuild still happens on schedule rather than being pushed
          // out forever by a token that keeps trading.
          builtAt: canExtend && hit ? hit.builtAt : Date.now(),
          value,
        });
      }
      return value;
    })
    .finally(() => {
      historyInflight.delete(key);
    });
  historyInflight.set(key, job);
  return job;
}

/**
 * Refresh a cached series by reading only the blocks since it was built.
 *
 * The expensive part of a build is one getLogs across every block from
 * genesis. Doing that on a six second cadence would be worse than the staleness
 * it fixes, so a refresh scans the gap instead, which is usually a few hundred
 * blocks and returns nothing at all.
 *
 * Falls back to a full build on any failure: a partial series presented as
 * complete is the failure mode this whole file exists to avoid.
 */
async function extendHistory(
  token: Address,
  hit: { at: number; builtAt: number; value: PriceHistory },
): Promise<PriceHistory> {
  const prev = hit.value;
  try {
    const from = (prev.head ?? 0n) + 1n;
    const fresh = await curvePriceHistory(token, {
      fromBlock: from,
      knownLaunch: prev.launch,
      knownLauncher: prev.launcher ?? undefined,
    });
    if (fresh.unreadable.length) return buildPriceHistory(token);
    if (!fresh.points.length) {
      // Nothing new, but the scan reached a later block, so the next refresh
      // starts from there rather than re-reading the same empty gap.
      return { ...prev, head: fresh.head ?? prev.head, curve: fresh.curve ?? prev.curve };
    }
    const seen = new Set(prev.points.map((p) => `${p.txHash}:${p.ts}:${p.tokens}`));
    const added = fresh.points.filter((p) => !seen.has(`${p.txHash}:${p.ts}:${p.tokens}`));
    const points = [...prev.points, ...added].sort(
      (a, b) => a.ts - b.ts || a.block - b.block,
    );
    return {
      points,
      unreadable: [],
      launcher: prev.launcher,
      curve: fresh.curve ?? prev.curve,
      launch: prev.launch,
      head: fresh.head ?? prev.head,
    };
  } catch {
    return buildPriceHistory(token);
  }
}

async function buildPriceHistory(token: Address): Promise<PriceHistory> {
  const curve = await curvePriceHistory(token);
  const unreadable = [...curve.unreadable];

  let pools: TokenPool[] = [];
  if (curve.launcher && curve.curve) {
    try {
      const found = await poolsForToken({
        launcher: curve.launcher,
        underlying: curve.curve.underlying,
        memePoolId: curve.curve.poolId,
      });
      pools = found.pools;
      unreadable.push(...found.unreadable);
    } catch (e) {
      unreadable.push(`pool lookup: ${message(e)}`);
    }
  }

  const poolPoints = pools.length
    ? await poolPriceHistory(token, pools, unreadable).catch((e) => {
        unreadable.push(`pool swaps: ${message(e)}`);
        return [] as PricePoint[];
      })
    : [];

  const points = [...curve.points, ...poolPoints].sort(
    (a, b) => a.ts - b.ts || a.block - b.block,
  );
  return {
    points, unreadable, launcher: curve.launcher, curve: curve.curve,
    launch: curve.launch, head: curve.head,
  };
}

export interface RawCandle {
  /** Bucket start, unix seconds. */
  t: number;
  /** OHLC in the units the chart expects: USD per token, scaled 1e6. */
  o: number;
  h: number;
  l: number;
  c: number;
  /** USDG volume in the bucket, scaled 1e6, matching the price scale. */
  v: number;
  /** Trades in the bucket. */
  n: number;
}

/**
 * Points to OHLC.
 *
 * The scale is not free choice. `trading-chart-canvas` computes
 * `(candle.open / 1e6) * (solUsd || 1) * DEFAULT_TOKEN_SUPPLY`, and `solUsd` is
 * 1 on this venue because the quote asset is the dollar, so a candle field has
 * to be USD-per-token times 1e6, the same units `current_price` already uses.
 * Emitting plain dollars here would render every market cap 1e6 too small,
 * which is the same class of mistake as the 1e12 curve-price bug in api.ts.
 */
export function toCandles(
  points: PricePoint[],
  bucketSeconds: number,
  limit: number,
  /**
   * The curve's opening quote, seeded as the first candle so a market that has
   * printed once still has a series to draw: it opens where the curve opened
   * and moves to where the trade took it. Carries `n: 0`, because it is a
   * quote and not a trade, and every count downstream reads `n`.
   */
  launch?: { ts: number; priceUsd: number } | null,
): RawCandle[] {
  if (bucketSeconds <= 0) return [];
  if (!points.length && !launch) return [];
  const buckets = new Map<number, RawCandle>();

  if (launch) {
    const t = Math.floor(launch.ts / bucketSeconds) * bucketSeconds;
    const price = launch.priceUsd * 1e6;
    buckets.set(t, { t, o: price, h: price, l: price, c: price, v: 0, n: 0 });
  }

  for (const p of points) {
    const t = Math.floor(p.ts / bucketSeconds) * bucketSeconds;
    const price = p.priceUsd * 1e6;
    const vol = p.volumeUsd * 1e6;
    const existing = buckets.get(t);
    if (!existing) {
      buckets.set(t, { t, o: price, h: price, l: price, c: price, v: vol, n: 1 });
      continue;
    }
    existing.h = Math.max(existing.h, price);
    existing.l = Math.min(existing.l, price);
    existing.c = price;
    existing.v += vol;
    existing.n += 1;
  }

  const ordered = [...buckets.values()].sort((a, b) => a.t - b.t);

  // Carry the last close across empty buckets. A gap is not a price of zero,
  // and a candlestick series with holes in it draws as one.
  const filled: RawCandle[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    filled.push(ordered[i]);
    const next = ordered[i + 1];
    if (!next) break;
    const gap = (next.t - ordered[i].t) / bucketSeconds - 1;
    // Bounded so a token that traded once months ago does not synthesise tens
    // of thousands of flat candles for the browser to draw.
    if (gap <= 0 || gap > 500) continue;
    const c = ordered[i].c;
    for (let k = 1; k <= gap; k += 1) {
      filled.push({ t: ordered[i].t + k * bucketSeconds, o: c, h: c, l: c, c, v: 0, n: 0 });
    }
  }

  // Open each candle where the last one closed.
  //
  // Taken literally, a bucket holding one trade has open == close == high ==
  // low and draws as a one pixel line: the second trade on TEST rendered as a
  // volume bar with no candle above it. Opening at the previous close is the
  // convention these charts use and it is not an invention, because the price
  // genuinely was the previous close until this bucket's first trade moved it.
  // The series is already gap-free by the carry-forward above, so this makes
  // every bucket show the move it actually contains.
  for (let i = 1; i < filled.length; i += 1) {
    const open = filled[i - 1].c;
    filled[i].o = open;
    filled[i].h = Math.max(filled[i].h, open);
    filled[i].l = Math.min(filled[i].l, open);
  }

  return filled.slice(-limit);
}

/**
 * The two curve events, pulled out of the generated ABI with their types intact
 * so viem can infer the decoded `args` rather than being handed `never`.
 *
 * They are looked up rather than written out again because a second copy of an
 * event signature is a second thing to keep in step with the contract, and this
 * app has already been bitten by drifted duplicates of exactly that shape.
 */
type CurveEvent<N extends string> = Extract<
  (typeof CURVEFUNDER_ABI)[number],
  { type: "event"; name: N }
>;

const CURVE_BUY_EVENT = CURVEFUNDER_ABI.find(
  (e): e is CurveEvent<"CurveBuy"> => e.type === "event" && e.name === "CurveBuy",
);
const CURVE_SELL_EVENT = CURVEFUNDER_ABI.find(
  (e): e is CurveEvent<"CurveSell"> => e.type === "event" && e.name === "CurveSell",
);
const CURVE_LAUNCH_EVENT = CURVEFUNDER_ABI.find(
  (e): e is CurveEvent<"TokenLaunched"> => e.type === "event" && e.name === "TokenLaunched",
);

function eventNamed<N extends "CurveBuy" | "CurveSell" | "TokenLaunched">(name: N) {
  const found =
    name === "CurveBuy" ? CURVE_BUY_EVENT
    : name === "CurveSell" ? CURVE_SELL_EVENT
    : CURVE_LAUNCH_EVENT;
  if (!found) {
    // gen-abi.py emitted functions and errors only until the chart needed these.
    // A missing event here means the manifest was trimmed, not that the chain
    // is quiet, so say which.
    throw new Error(`${name} is not in CURVEFUNDER_ABI. Re-run scripts/gen-abi.py.`);
  }
  return found as N extends "CurveBuy" ? CurveEvent<"CurveBuy">
    : N extends "CurveSell" ? CurveEvent<"CurveSell">
    : CurveEvent<"TokenLaunched">;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] : String(e);
}
