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
import { activeNetwork } from "@/lib/float/networks";

const DAY = 86_400;

// The board polls every 15s and each build is ~60 eth_calls, so serve a short
// cache rather than re-reading the chain for every viewer. Short enough that a
// deposit shows up on the next poll.
const CACHE_MS = 8_000;
let cached: { at: number; key: string; body: unknown } | null = null;

interface TradeRow { block: number; asset_id: string; side: string; quote: string; base: string; fee_bps: number; ts?: number | null }

async function indexerTrades(): Promise<TradeRow[]> {
  const origin = process.env.FLOAT_INDEXER_ORIGIN ?? "http://localhost:8462";
  try {
    const r = await fetch(`${origin}/trades?limit=500`, { cache: "no-store" });
    if (!r.ok) return [];
    return (await r.json()) as TradeRow[];
  } catch {
    return [];
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

export async function GET() {
  const net = activeNetwork();
  if (cached && cached.key === net.registry && Date.now() - cached.at < CACHE_MS) {
    return NextResponse.json(cached.body, { headers: { "cache-control": "no-store" } });
  }
  try {
    const venue = await detectVenue();
    const [vault, queue, ids, usdgAddr] = await Promise.all([
      deskVault(), funderQueue(), listingIds(), resolve("USDG"),
    ]);
    // contribute() reverts NotQueued unless the head is enqueued and unpoured,
    // and a market funded straight from a curve is never enqueued at all.
    const queueOpen = await funderAcceptsContribution(queue.assetId).catch(() => false);
    const usdg = await erc20(usdgAddr);

    const now = Math.floor(Date.now() / 1000);
    const trades = await withTimes(await indexerTrades());
    const windowed = (secs: number) => trades.filter((t) => t.ts && now - t.ts <= secs);

    const sumQuote = (rows: TradeRow[]) =>
      rows.reduce((a, r) => a + Number(BigInt(r.quote ?? "0")), 0);
    const sumFees = (rows: TradeRow[]) =>
      rows.reduce((a, r) => a + Number(BigInt(r.quote ?? "0")) * (r.fee_bps ?? 0) / 10_000, 0);

    const markets = await Promise.all(ids.map(async (assetId) => {
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
    }));

    // Launched tokens, only where this deployment runs the fSHARE curve.
    let tokens: unknown[] = [];
    let launchpad: Record<string, string> | null = null;
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
      funder: {
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
