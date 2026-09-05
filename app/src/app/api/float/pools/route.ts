/**
 * The liquidity board, assembled server-side from chain reads plus indexer
 * history. Every field here traces to a call or a row; nothing is modelled.
 *
 * What replaced the mock matters, so it is worth being explicit about the
 * shape of the truth:
 *  - The Desk is ONE pooled USDG vault backing every market, not a pool per
 *    pair. Depositing USDG mints shares of it; the share price is equity/shares
 *    and it moves with spread and size impact earned across all markets.
 *  - Per-market rows are therefore NOT separate TVL. They show that market's
 *    utilisation of the shared vault (netOI against its OI cap) and its own
 *    fee stream, which is what a staker in that market earns.
 */

import { NextResponse } from "next/server";
import {
  deskVault, funderQueue, getListing, listingIds, markPx, netOI,
  oracleQuote, stakePool, tokenCurve, launchpadParams, erc20, publicClient,
  funderAcceptsContribution,
} from "@/lib/float/chain";
import { resolve, detectVenue } from "@/lib/float/registry";
import { cfAllTokensDetailed, cfCurve, cfTokenMeta } from "@/lib/float/curve-funder";
import { activeNetwork } from "@/lib/float/networks";

const DAY = 86_400;

// The board polls every 15s and each build is ~60 eth_calls, so serve a short
// cache rather than re-reading the chain for every viewer. Short enough that a
// deposit shows up on the next poll.
const CACHE_MS = 8_000;
let cached: { at: number; key: string; body: unknown } | null = null;

interface TradeRow { block: number; asset_id: string; side: string; quote: string; base: string; fee_bps: number; ts?: number | null }

/**
 * Trades, plus whether we could actually ask.
 *
 * Returning a bare [] on failure made a dead indexer identical to a quiet
 * chain: every market read "no trades yet" at $0 volume, which is exactly what
 * a market with no trades reads. The caller needs to be able to say "we could
 * not ask" instead of publishing a zero it did not measure.
 */
/**
 * Which deployment is the indexer actually watching?
 *
 * Reachable is not the same as correct. Pointing the app at 4663 while :8462
 * indexes 46630 gave a live indexer answering happily about a different chain,
 * and every market read "no trades yet" when the truth was "not watching this
 * chain". /addresses exposes its resolved contracts, so comparing its DESK
 * against ours is a direct test.
 *
 * Note /addresses is NOT listed in the indexer's own root endpoint array even
 * though it works, so feature-detecting from that list reports it absent.
 * Call it and handle the 404.
 */
async function indexerDesk(): Promise<{ desk: string | null; exposed: boolean }> {
  const origin = process.env.FLOAT_INDEXER_ORIGIN ?? "http://localhost:8462";
  try {
    const r = await fetch(`${origin}/addresses`, { cache: "no-store" });
    if (!r.ok) return { desk: null, exposed: false };
    const d = (await r.json()) as Record<string, string>;
    return { desk: d.DESK?.toLowerCase() ?? null, exposed: Boolean(d.DESK) };
  } catch {
    return { desk: null, exposed: false };
  }
}

async function indexerTrades(): Promise<{ rows: TradeRow[]; ok: boolean; error?: string }> {
  const origin = process.env.FLOAT_INDEXER_ORIGIN ?? "http://localhost:8462";
  try {
    const r = await fetch(`${origin}/trades?limit=500`, { cache: "no-store" });
    if (!r.ok) return { rows: [], ok: false, error: `indexer HTTP ${r.status}` };
    return { rows: (await r.json()) as TradeRow[], ok: true };
  } catch (e) {
    return { rows: [], ok: false, error: e instanceof Error ? e.message.slice(0, 120) : "unreachable" };
  }
}

/** Block timestamps for windowing, resolved once per request. */
async function withTimes(rows: TradeRow[]): Promise<TradeRow[]> {
  const pc = publicClient();
  const blocks = [...new Set(rows.map((r) => r.block))];
  const times = new Map<number, number>();
  await Promise.all(blocks.map(async (b) => {
    try {
      const blk = await pc.getBlock({ blockNumber: BigInt(b) });
      times.set(b, Number(blk.timestamp));
    } catch { /* skip */ }
  }));
  return rows.map((r) => ({ ...r, ts: times.get(r.block) ?? null }));
}

/**
 * A viem revert message puts the useful part on the SECOND line: the first is
 * "The contract function X reverted with the following signature:" and the
 * decoded error name or selector follows. Taking line one alone threw the
 * reason away while looking like it had kept it.
 */
function revertReason(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const lines = e.message.split("\n").map((l) => l.trim()).filter(Boolean);
  const named = lines.find((l) => /^(Error: )?[A-Z][A-Za-z0-9_]*\(/.test(l));
  if (named) return named.replace(/^Error: /, "").slice(0, 140);
  const sig = lines.find((l) => /^0x[0-9a-fA-F]{8}$/.test(l));
  return [lines[0], sig].filter(Boolean).join(" ").slice(0, 140);
}

export async function GET() {
  const net = activeNetwork();
  if (cached && cached.key === net.registry && Date.now() - cached.at < CACHE_MS) {
    return NextResponse.json(cached.body, { headers: { "cache-control": "no-store" } });
  }
  try {
    const venue = await detectVenue();
    // The Desk vault and the quote asset are fatal: without them there is no
    // board. The funder queue and the listing set are not, so they degrade
    // rather than taking the deposit surface down with them.
    const [vault, usdgAddr] = await Promise.all([deskVault(), resolve("USDG")]);
    const [queue, ids] = await Promise.all([
      funderQueue().catch(() => null),
      listingIds().catch(() => [] as `0x${string}`[]),
    ]);
    // contribute() reverts NotQueued unless the head is enqueued and unpoured,
    // and a market funded straight from a curve is never enqueued at all.
    const queueOpen = queue
      ? await funderAcceptsContribution(queue.assetId).catch(() => false)
      : false;
    const usdg = await erc20(usdgAddr);

    const now = Math.floor(Date.now() / 1000);
    const [feed, ident] = await Promise.all([indexerTrades(), indexerDesk()]);
    // Three distinct states, not two. Only the last may render a zero as a
    // measurement: unreachable, reachable but watching another deployment, and
    // reachable and confirmed to be on ours.
    const sameChain =
      ident.desk === null ? null : ident.desk === vault.address.toLowerCase();
    const indexerStatus: "unreachable" | "wrong-chain" | "unverified" | "ok" =
      !feed.ok ? "unreachable"
      : sameChain === false ? "wrong-chain"
      : sameChain === null ? "unverified"
      : "ok";
    const measured = indexerStatus === "ok" || indexerStatus === "unverified";
    const trades = await withTimes(measured ? feed.rows : []);
    const windowed = (secs: number) => trades.filter((t) => t.ts && now - t.ts <= secs);

    const sumQuote = (rows: TradeRow[]) =>
      rows.reduce((a, r) => a + Number(BigInt(r.quote ?? "0")), 0);
    const sumFees = (rows: TradeRow[]) =>
      rows.reduce((a, r) => a + Number(BigInt(r.quote ?? "0")) * (r.fee_bps ?? 0) / 10_000, 0);

    // Each market row fails on its own. getListing reverts UnknownAsset on a
    // delisted or zeroed listing, and inside a shared Promise.all one such
    // revert rejected the whole board, so a single bad row took down the Desk
    // vault card people deposit into. Drop the row, keep the board.
    const marketRows = await Promise.all(ids.map(async (assetId) => {
      try {
      const [l, mark, oi, oracle, pool] = await Promise.all([
        getListing(assetId),
        markPx(assetId).catch(() => 0n),
        netOI(assetId).catch(() => 0n),
        oracleQuote(assetId).catch(() => null),
        stakePool(assetId).catch(() => null),
      ]);
      const mine = (rows: TradeRow[]) =>
        rows.filter((t) => t.asset_id?.toLowerCase() === assetId.toLowerCase());
      return {
        assetId,
        ticker: l.ticker,
        displayName: l.displayName,
        token: l.token,
        status: l.status,
        spot: l.spot,
        markPx: mark.toString(),
        oraclePx: oracle ? oracle.price.toString() : null,
        oracleUpdatedAt: oracle ? Number(oracle.updatedAt) : null,
        marketOpen: oracle ? oracle.marketOpen : null,
        oiCapQuote: l.oiCapQuote.toString(),
        netOI: oi.toString(),
        baseSpreadBps: l.baseSpreadBps,
        ahSpreadBps: l.ahSpreadBps,
        totalStaked: pool ? pool.totalStaked.toString() : null,
        volume24h: sumQuote(mine(windowed(DAY))),
        volume7d: sumQuote(mine(windowed(7 * DAY))),
        fees7d: sumFees(mine(windowed(7 * DAY))),
        trades: mine(trades).length,
      };
      } catch (e) {
        // Dropping the row is right; dropping the REASON is not. A transient
        // RPC failure and a genuinely delisted asset both leave the board a row
        // short, and without this they look identical to anyone reading it.
        return { __dropped: assetId, reason: revertReason(e) };
      }
    }));

    type Dropped = { __dropped: string; reason: string };
    const isDropped = (r: unknown): r is Dropped =>
      typeof r === "object" && r !== null && "__dropped" in r;
    const markets = marketRows.filter((m) => m !== null && !isDropped(m)) as Exclude<
      (typeof marketRows)[number], Dropped | null
    >[];
    const unreadable = marketRows.filter(isDropped).map((d) => ({ assetId: d.__dropped, reason: d.reason }));

    let tokens: unknown[] = [];
    let launchpad: Record<string, string> | null = null;

    // The CurveFunder venue has no indexer, so its launched tokens come from the
    // contract. Its curve is quoted in USDG rather than in the underlying
    // fSHARE, so raise and target are already dollars.
    if (venue === "curve-funder") {
      const entries = await cfAllTokensDetailed().catch(() => []);
      tokens = (await Promise.all(entries.map(async ({ token, launcher, superseded }) => {
        const [c, meta] = await Promise.all([
          cfCurve(token, launcher).catch(() => null),
          cfTokenMeta(token).catch(() => ({ name: "", symbol: "" })),
        ]);
        if (!c) return null;
        const ticker = markets.find(
          (m) => m.assetId.toLowerCase() === c.underlying.toLowerCase(),
        )?.ticker;
        return {
          token,
          name: meta.name,
          symbol: meta.symbol,
          underlyingTicker: ticker ?? "?",
          raised: c.rQuote.toString(),
          gradTarget: c.gradTarget.toString(),
          sold: c.sold.toString(),
          graduated: c.graduated,
          quoteIsUsdg: true,
          poolId: c.poolId,
          superseded,
        };
      }))).filter(Boolean);
    }

    if (venue === "token-launchpad") {
      const params = await launchpadParams();
      launchpad = {
        address: params.address,
        launchFee: params.launchFee.toString(),
        feeBps: String(params.feeBps),
        creatorShareBps: String(params.creatorShareBps),
        graduationUsd: params.graduationUsd.toString(),
        tokenCount: params.tokenCount.toString(),
      };
      const origin = process.env.FLOAT_INDEXER_ORIGIN ?? "http://localhost:8462";
      let rows: Array<{ token: string; name: string; symbol: string; underlying_ticker: string }> = [];
      try {
        const r = await fetch(`${origin}/tokens?limit=100`, { cache: "no-store" });
        if (r.ok) rows = await r.json();
      } catch { /* indexer down: fall through with none */ }
      tokens = await Promise.all(rows.map(async (t) => {
        const c = await tokenCurve(t.token as `0x${string}`).catch(() => null);
        // curves() returns a ZERO STRUCT rather than reverting for a token this
        // launchpad has never seen, which happens whenever the indexer and the
        // active chain disagree (pointing the app at a localnet while the
        // indexer still serves testnet). Rendering that as a real token showed
        // a $0 raise against a $0 target. Drop it instead.
        if (!c || (c.gradTarget === 0n && c.sold === 0n && c.rQuote === 0n)) return null;
        return {
          token: t.token,
          name: t.name,
          symbol: t.symbol,
          underlyingTicker: t.underlying_ticker,
          raised: c.rQuote.toString(),
          gradTarget: c.gradTarget.toString(),
          sold: c.sold.toString(),
          graduated: c.graduated,
        };
      })).then((r) => r.filter(Boolean));
    }

    const sharePrice = vault.totalShares > 0n
      ? Number(vault.equity) / Number(vault.totalShares)
      : 1;

    const body = {
      network: { key: net.key, label: net.label, chainId: net.chainId, explorer: net.explorer, registry: net.registry, testnet: net.testnet },
      venue,
      quote: { address: usdgAddr, symbol: usdg.symbol, decimals: usdg.decimals },
      desk: {
        address: vault.address,
        available: vault.available.toString(),
        equity: vault.equity.toString(),
        totalShares: vault.totalShares.toString(),
        sharePrice,
        txFeeBps: vault.txFeeBps,
        stakerFeeBps: vault.stakerFeeBps,
        withdrawDelay: Number(vault.withdrawDelay),
      },
      funder: queue && {
        address: queue.address,
        assetId: queue.assetId,
        target: queue.target.toString(),
        funded: queue.funded.toString(),
        queueLength: Number(queue.length),
        feeBalance: queue.feeBalance.toString(),
        acceptsContribution: queueOpen,
      },
      launchpad,
      markets,
      /**
       * Whether the trade history could be read at all. When false, every
       * volume and fee figure below is unmeasured rather than zero.
       */
      indexer: {
        reachable: feed.ok,
        error: feed.error ?? null,
        status: indexerStatus,
        /** The Desk the indexer resolved, when it exposes /addresses. */
        desk: ident.desk,
        /** False when volume and fee figures below are unmeasured, not zero. */
        measured,
      },
      /** Markets the chain refused to read, with why. Empty is the normal case. */
      unreadable,
      tokens,
      totals: {
        volume24h: sumQuote(windowed(DAY)),
        volume7d: sumQuote(windowed(7 * DAY)),
        fees7d: sumFees(windowed(7 * DAY)),
        tradeCount: trades.length,
      },
      asOf: now,
    };
    cached = { at: Date.now(), key: net.registry, body };
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), network: net.key },
      { status: 502 },
    );
  }
}
