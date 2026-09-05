/**
 * The LP board: the graduated v4 pools anyone can add to and remove from.
 *
 * Its own route rather than a key inside /api/float/pools, for the same reason
 * the DeskHook route is separate: the Desk vault card is what people deposit
 * into, and a launcher that will not answer must not be able to take it down.
 *
 * On what this deliberately does NOT return: there is no TVL column and no
 * volume column. `liquidity` is the ACTIVE liquidity at the current tick, which
 * is a real chain read and not the dollar value of the pool; converting it into
 * a TVL would need every position's range, which is not readable from a pool
 * id. Nothing indexes swaps on these pools yet either, so volume does not
 * exist. This repo's rule is that a column traces to a chain call or says it
 * does not exist, so those columns say it does not exist.
 */

import { NextResponse } from "next/server";
import { lpPools, amountsFor } from "@/lib/float/pools";
import { activeNetwork } from "@/lib/float/networks";

export async function GET() {
  const net = activeNetwork();
  try {
    const { pools, unreadable } = await lpPools();

    // What the active liquidity IS, in tokens. Not an approximation: active L
    // is the liquidity of the tick range that currently contains spot, so
    // valuing it over exactly that range is the amount quoting right now.
    // Costs no extra chain reads, because everything it needs is already in
    // the row.
    //
    // This replaces printing L raw. L lives in sqrt-price space and is not an
    // amount of anything, so a column headed "liquidity" showing 56,886,259.95Q
    // read as a fortune where the honest figure is a few dollars. This board
    // exists because the page before it invented a TVL; printing a real number
    // under a label that implies a different quantity gets to the same place
    // by accident.
    const withAmounts = pools.map((p) => {
      const spacing = p.key.tickSpacing;
      const base = Math.floor(p.tick / spacing) * spacing;
      const { amount0, amount1 } = amountsFor(BigInt(p.liquidity), base, base + spacing, p.tick);
      const a0 = amount0 / 10 ** p.decimals0;
      const a1 = amount1 / 10 ** p.decimals1;
      return {
        ...p,
        inRange: {
          amount0: a0,
          amount1: a1,
          usdg: p.usdgSide === 0 ? a0 : p.usdgSide === 1 ? a1 : null,
          bandPct: (Math.pow(1.0001, spacing) - 1) * 100,
        },
      };
    });

    return NextResponse.json(
      {
        network: { key: net.key, chainId: net.chainId, explorer: net.explorer },
        pools: withAmounts,
        unreadable,
        asOf: Math.floor(Date.now() / 1000),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), network: net.key, pools: [], unreadable: [] },
      { status: 502 },
    );
  }
}
