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
}

/** USDG is 6dp, the launched token is 18dp. */
const USDG_UNIT = 1e6;
const TOKEN_UNIT = 1e18;

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
): Promise<T[]> {
  try {
    return await withRetry(() => fetch(0n, head), "getLogs full range");
  } catch (e) {
    // Windowing a rate-limited node turns one refused call into hundreds of
    // them. The fallback is for a node that will not serve a WIDE range, which
    // is a different complaint from one that will not serve any more calls.
    if (isRateLimited(e)) throw e;
    const out: T[] = [];
    for (let start = 0n; start <= head; start += WINDOW + 1n) {
      const end = start + WINDOW > head ? head : start + WINDOW;
      out.push(...(await withRetry(() => fetch(start, end), `getLogs ${start}-${end}`)));
    }
    return out;
  }
}

/** Block timestamps for the blocks we actually saw, fetched once each. */
async function blockTimes(blocks: bigint[]): Promise<Map<bigint, number>> {
  const pc = publicClient();
  const unique = [...new Set(blocks.map((b) => b.toString()))].map(BigInt);
  const entries = await mapLimited(unique, async (b) => {
    const block = await withRetry(() => pc.getBlock({ blockNumber: b }), `getBlock(${b})`).catch(
      () => null,
    );
    return [b, block ? Number(block.timestamp) : 0] as const;
  });
  return new Map(entries.filter(([, ts]) => ts > 0));
}

/**
 * Every curve trade for one token, oldest first.
 *
 * The launcher matters. Three of the four mainnet launches live on the
 * superseded 0xD55E56Be, and reading a legacy token against the current
 * launcher returns a zero struct rather than reverting, so "which contract
 * holds this token" has to be answered before anything is read from it.
 */
export async function curvePriceHistory(token: Address): Promise<PriceHistory> {
  const pc = publicClient();
  const unreadable: string[] = [];

  // "Which launcher holds this" has three answers, not two, and collapsing the
  // third into "none" is what made this route report a live token as untraded.
  const owner = await launcherHolding(token);
  if (owner.kind === "unreadable") {
    unreadable.push(`launcher lookup: ${owner.reasons.join("; ")}`);
    return { points: [], unreadable, launcher: null, curve: null };
  }
  if (owner.kind === "absent") {
    // Not a curve token on this deployment. That is a real answer, not a gap.
    return { points: [], unreadable, launcher: null, curve: null };
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
  ).catch((e) => {
    unreadable.push(`CurveBuy logs: ${message(e)}`);
    return [];
  });
  const sells = await allLogs(
    (f, t) =>
      pc.getLogs({ address: launcher, event: sellEvent, args: { token }, fromBlock: f, toBlock: t }),
    head,
  ).catch((e) => {
    unreadable.push(`CurveSell logs: ${message(e)}`);
    return [];
  });

  const times = await blockTimes([...buys, ...sells].map((l) => l.blockNumber ?? 0n));
  const points: PricePoint[] = [];

  for (const log of buys) {
    const a = log.args as { usdgIn?: bigint; tokensOut?: bigint };
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
    });
  }

  for (const log of sells) {
    const a = log.args as { tokensIn?: bigint; usdgOut?: bigint };
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
    });
  }

  points.sort((a, b) => a.ts - b.ts || a.block - b.block);
  return { points, unreadable, launcher, curve: owner.curve };
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
  const points: PricePoint[] = [];

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
    const shares = shareLeg === undefined ? 0 : Math.abs(Number(shareLeg)) / 10 ** shareDecimals;

    points.push({
      ts,
      block: Number(log.blockNumber),
      priceUsd,
      volumeUsd: shares * usdgPerShare,
      // A swap that took the token out of the pool is a buy of the token.
      side: (tokenIsCurrency0 ? (a.amount0 ?? 0n) < 0n : (a.amount1 ?? 0n) < 0n) ? "buy" : "sell",
      venue: "pool",
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
const HISTORY_TTL_MS = 60_000;

const historyCache = new Map<string, { at: number; value: PriceHistory }>();
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

  const job = buildPriceHistory(token)
    .then((value) => {
      // Only a successful read is worth remembering. Caching a failure would
      // hold the page on "we could not ask" for a minute after the RPC recovers.
      if (value.points.length || !value.unreadable.length) {
        historyCache.set(key, { at: Date.now(), value });
      }
      return value;
    })
    .finally(() => {
      historyInflight.delete(key);
    });
  historyInflight.set(key, job);
  return job;
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
  return { points, unreadable, launcher: curve.launcher, curve: curve.curve };
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
export function toCandles(points: PricePoint[], bucketSeconds: number, limit: number): RawCandle[] {
  if (!points.length || bucketSeconds <= 0) return [];
  const buckets = new Map<number, RawCandle>();

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

function eventNamed<N extends "CurveBuy" | "CurveSell">(name: N) {
  const found = name === "CurveBuy" ? CURVE_BUY_EVENT : CURVE_SELL_EVENT;
  if (!found) {
    // gen-abi.py emitted functions and errors only until the chart needed these.
    // A missing event here means the manifest was trimmed, not that the chain
    // is quiet, so say which.
    throw new Error(`${name} is not in CURVEFUNDER_ABI. Re-run scripts/gen-abi.py.`);
  }
  return found as N extends "CurveBuy" ? CurveEvent<"CurveBuy"> : CurveEvent<"CurveSell">;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] : String(e);
}
