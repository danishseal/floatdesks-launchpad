/**
 * The trades behind one token, in the shape the page already reads.
 *
 * `fetchTokenTrades()` was `return []`, a stub with no address parameter, so
 * every figure derived from it was structurally zero and could never be
 * anything else: the About panel's 5M/1H/4H/1D windows, its buys/sells,
 * volume and buyers/sellers bars, and the Transactions tab. They all rendered
 * as measurements of a market with no activity, over tokens that had traded.
 *
 * The prints come from the same place the chart's candles do, so the two agree
 * by construction rather than by maintenance: curve events, which are exact
 * because they are denominated in USDG, plus the meme pool's v4 swaps.
 *
 * SCALE, and it is not the obvious one. The consumers divide `hodl_amount` by
 * 1e6 and multiply by solUsd (1 on this venue) to get dollars, which matches
 * USDG's 6dp. But they also divide `token_amount` by 1e6, NOT by the token's
 * own 1e18, so the token leg has to be scaled to micro-units on the way out.
 * Handing over raw wei here would print every trade as a number 1e12 too large.
 */

import { NextResponse } from "next/server";
import type { Address } from "viem";
import { isAddress } from "viem";
import { tokenPriceHistory } from "@/lib/float/curve-trades";

/** What the page's TokenTrade looks like. */
interface TokenTradeRow {
  time: string;
  tx_hash: string;
  action: "buy" | "sell";
  trader: string;
  hodl_amount: string;
  token_amount: string;
  fee: string;
  phase: "curve" | "amm";
  price_sol: number;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 200), 1), 1000);
  if (!token || !isAddress(token)) {
    return NextResponse.json({ error: "token must be an address" }, { status: 400 });
  }

  try {
    const history = await tokenPriceHistory(token as Address);
    if (history.unreadable.length && !history.points.length) {
      return NextResponse.json({ error: history.unreadable.join("; ") }, { status: 502 });
    }

    // Newest first: the panel takes the head as the latest print.
    const rows: TokenTradeRow[] = [...history.points]
      .sort((a, b) => b.ts - a.ts || b.block - a.block)
      .slice(0, limit)
      .map((p) => ({
        time: new Date(p.ts * 1000).toISOString(),
        tx_hash: p.txHash,
        action: p.side,
        trader: p.trader,
        // USDG is 6dp, so dollars in micro-units is the raw amount.
        hodl_amount: String(Math.round(p.volumeUsd * 1e6)),
        // Micro-units, because that is what the table divides by. Not wei.
        token_amount: String(Math.round(p.tokens * 1e6)),
        // The fee is charged inside the trade and the event does not break it
        // out, so this is not a number we have. Zero here would read as "no
        // fee" rather than "not stated", so the column is left empty instead.
        fee: "",
        phase: p.venue === "pool" ? "amm" : "curve",
        price_sol: p.priceUsd,
      }));

    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (history.unreadable.length) {
      headers["x-float-unreadable"] = history.unreadable.join("; ").slice(0, 900);
    }
    return NextResponse.json(rows, { headers });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message.split("\n")[0] : String(e) },
      { status: 502 },
    );
  }
}
