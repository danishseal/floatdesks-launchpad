import { indexerOrigin } from "@/lib/float/networks";
/**
 * Chain-wide analytics, assembled here rather than in the indexer.
 *
 * These four shapes came from the ansem-1 indexer, which served /analytics/*.
 * The Float indexer does not, and because it answers an unknown path with 200
 * and its endpoint listing, the page was parsing that menu as data and
 * crashing on undefined.length. After the proxy started returning a real 404 it
 * stopped crashing but reported "No activity in this window", which was worse:
 * there IS activity, we just were not asking anywhere that had it.
 *
 * So they are built from what Float actually exposes: Desk trades (with block
 * timestamps resolved by the proxy), the launched-token list, and the listings.
 *
 * Honest limits, stated rather than papered over:
 *  - Volume is DESK volume in USDG, which is already USD. There is no denom to
 *    price, so byDenom carries the one quote asset and unpricedDenoms is empty.
 *  - Per-token volume covers Desk flow per market. Launched-token curve volume
 *    lives in the indexer's token_trades and has no endpoint, so a launched
 *    token reports its trade count as 0 rather than borrowing its underlying's.
 *  - Graduations are read from the curve state, not from an event log, so the
 *    series shows them at their launch bucket. It is a count, not a timeline.
 */

import { NextResponse } from "next/server";

const ORIGIN = indexerOrigin();
const WINDOWS: Record<string, number> = {
  "24h": 86_400, "7d": 604_800, "30d": 2_592_000, all: Number.MAX_SAFE_INTEGER,
};

interface Trade { block: number; asset_id: string; side: string; who: string; quote: string; fee_bps: number; ts?: number | null }
interface Token { token: string; symbol: string; underlying_ticker: string | null; block: number; graduated: number }
interface Listing { asset_id: string; ticker: string }

async function idx<T>(path: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(`${ORIGIN}${path}`, { cache: "no-store" });
    if (!r.ok) return fallback;
    const j = await r.json();
    // The indexer answers unknown paths with its endpoint menu at 200.
    if (j && typeof j === "object" && !Array.isArray(j) && Array.isArray(j.endpoints)) return fallback;
    return j as T;
  } catch {
    return fallback;
  }
}

/** Trades carry a block but no timestamp; resolve the distinct blocks once. */
async function withTimes(rows: Trade[], rpc: string): Promise<Trade[]> {
  const blocks = [...new Set(rows.map((r) => r.block))];
  const times = new Map<number, number>();
  await Promise.all(blocks.map(async (b) => {
    try {
      const r = await fetch(rpc, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x" + b.toString(16), false] }),
      });
      const j = await r.json();
      if (j.result?.timestamp) times.set(b, Number(BigInt(j.result.timestamp)));
    } catch { /* leave it out rather than guess */ }
  }));
  return rows.map((r) => ({ ...r, ts: r.ts ?? times.get(r.block) ?? null }));
}

const USDG = 1e6;

function totals(rows: Trade[], tokens: Token[], from: number, to: number) {
  const inWindow = rows.filter((r) => r.ts && r.ts >= from && r.ts < to);
  const vol = (side?: string) =>
    inWindow.filter((r) => !side || r.side === side)
      .reduce((a, r) => a + Number(BigInt(r.quote ?? "0")), 0) / USDG;
  const launched = tokens.filter((t) => t.block >= from && t.block < to).length;
  return {
    volumeUsd: vol(),
    buyVolumeUsd: vol("buy"),
    sellVolumeUsd: vol("sell"),
    tradeCount: inWindow.length,
    uniqueTraders: new Set(inWindow.map((r) => r.who?.toLowerCase())).size,
    tokensLaunched: launched,
    tokensGraduated: tokens.filter((t) => t.graduated && t.block >= from && t.block < to).length,
    byDenom: [{
      denom: "usdg", label: "USDG", volumeBase: vol(), volumeUsd: vol(),
      buyVolumeBase: vol("buy"), sellVolumeBase: vol("sell"),
      tradeCount: inWindow.length, priced: true,
    }],
    unpricedDenoms: [] as string[],
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  const url = new URL(req.url);
  const win = url.searchParams.get("window") ?? "24h";
  const span = WINDOWS[win] ?? WINDOWS["24h"];
  const now = Math.floor(Date.now() / 1000);
  const from = span === Number.MAX_SAFE_INTEGER ? 0 : now - span;

  const rpc = process.env.FLOAT_RPC
    ?? process.env.NEXT_PUBLIC_FLOAT_RPC
    ?? "https://rpc.testnet.chain.robinhood.com";

  const [rawTrades, tokens, listings] = await Promise.all([
    idx<Trade[]>("/trades?limit=500", []),
    idx<Token[]>("/tokens?limit=200", []),
    idx<Listing[]>("/listings", []),
  ]);
  const trades = await withTimes(rawTrades, rpc);

  // Blocks, not timestamps, on token rows: map launch blocks to times too.
  const tokenTimes = await withTimes(
    tokens.map((t) => ({ block: t.block, asset_id: "", side: "", who: "", quote: "0", fee_bps: 0 })),
    rpc,
  );
  const tokensDated: Token[] = tokens.map((t, i) => ({ ...t, block: tokenTimes[i].ts ?? 0 }));

  if (kind === "overview") {
    const prevFrom = span === Number.MAX_SAFE_INTEGER ? 0 : from - span;
    return NextResponse.json({
      window: win,
      ...totals(trades, tokensDated, from, now),
      prev: span === Number.MAX_SAFE_INTEGER ? null : totals(trades, tokensDated, prevFrom, from),
    }, { headers: { "cache-control": "no-store" } });
  }

  if (kind === "volume-series" || kind === "launches-series") {
    const bucket = span <= 86_400 ? 3600 : span <= 604_800 ? 21_600 : 86_400;
    const start = span === Number.MAX_SAFE_INTEGER
      ? Math.min(...[...trades, ...tokensDated.map((t) => ({ ts: t.block }))].map((r) => ("ts" in r ? r.ts : 0) || now), now)
      : from;
    const points: Array<Record<string, unknown>> = [];
    for (let t = Math.floor(start / bucket) * bucket; t < now; t += bucket) {
      const slice = trades.filter((r) => r.ts && r.ts >= t && r.ts < t + bucket);
      const iso = new Date(t * 1000).toISOString();
      if (kind === "volume-series") {
        points.push({
          t: iso,
          volumeUsd: slice.reduce((a, r) => a + Number(BigInt(r.quote ?? "0")), 0) / USDG,
          tradeCount: slice.length,
        });
      } else {
        points.push({
          t: iso,
          launched: tokensDated.filter((k) => k.block >= t && k.block < t + bucket).length,
          graduated: tokensDated.filter((k) => k.graduated && k.block >= t && k.block < t + bucket).length,
        });
      }
    }
    return NextResponse.json(
      kind === "volume-series" ? { window: win, bucket, points } : { window: win, bucket, points },
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (kind === "top-tokens") {
    const by = url.searchParams.get("by") === "trades" ? "trades" : "volume";
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 12), 50);
    const tickerOf = new Map(listings.map((l) => [l.asset_id.toLowerCase(), l.ticker]));
    const agg = new Map<string, { vol: number; count: number }>();
    for (const r of trades) {
      if (!r.ts || r.ts < from) continue;
      const k = r.asset_id?.toLowerCase() ?? "";
      const cur = agg.get(k) ?? { vol: 0, count: 0 };
      cur.vol += Number(BigInt(r.quote ?? "0")) / USDG;
      cur.count += 1;
      agg.set(k, cur);
    }
    const rows = [...agg.entries()]
      .map(([assetId, v]) => ({
        address: assetId,
        symbol: `f${tickerOf.get(assetId) ?? "?"}`,
        base_denom: "usdg",
        base_label: "USDG",
        volumeBase: v.vol,
        volumeUsd: v.vol,
        tradeCount: v.count,
        priceChangePct: null,
      }))
      .sort((a, b) => (by === "volume" ? b.volumeUsd - a.volumeUsd : b.tradeCount - a.tradeCount))
      .slice(0, limit);
    return NextResponse.json({ window: win, by, tokens: rows },
      { headers: { "cache-control": "no-store" } });
  }

  return NextResponse.json({ error: `unknown analytics kind ${kind}` }, { status: 404 });
}
