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
import { lpPools } from "@/lib/float/pools";
import { activeNetwork } from "@/lib/float/networks";

export async function GET() {
  const net = activeNetwork();
  try {
    const { pools, unreadable } = await lpPools();
    return NextResponse.json(
      {
        network: { key: net.key, chainId: net.chainId, explorer: net.explorer },
        pools,
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
