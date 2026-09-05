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
import { lpPools, amountsFor, activeRange } from "@/lib/float/pools";
import { activeNetwork } from "@/lib/float/networks";

export async function GET() {
  const net = activeNetwork();
  try {
    const { pools, unreadable } = await lpPools();

    // How much is quoting within 1% of spot.
    //
    // Two earlier attempts got the SUBJECT wrong rather than the arithmetic.
    // Printing L raw read as a fortune. Valuing L over one tick spacing and
    // calling it "the range containing spot" understated a pool 3.8x, because
    // L is constant between INITIALISED ticks and those are not adjacent.
    // Chasing the true active range then failed on the pools that need it
    // least: MARIO's only initialised ticks sit near MAX_TICK, a full range
    // position, so the range is nearly the whole tick space and searching for
    // it is both expensive and beside the point.
    //
    // A fixed 1% band is the question a depositor actually has, and it is
    // exact whenever L is constant across it. One bitmap word settles that: an
    // initialised tick inside the band makes the figure approximate, and no
    // initialised tick anywhere nearby is a CONFIRMATION of exactness, not a
    // failure. Only a read that errored is unmeasured.
    // One read each, in parallel. I ran these serially first on a wrong
    // diagnosis: five pools came back without a range and I put it down to
    // throttling, when the reason was that their nearest initialised ticks are
    // near MAX_TICK and the search legitimately found none nearby. Serialising
    // cost eleven seconds a request and fixed nothing that was broken.
    const BAND = 100; // 1.0001^100, about 1% either side
    const withAmounts = await Promise.all(
      pools.map(async (p) => {
        const lo = p.tick - BAND;
        const hi = p.tick + BAND;
        const range = await activeRange(p.poolId as `0x${string}`, p.tick, p.key.tickSpacing);
        if (range.kind === "error") return { ...p, inRange: null, inRangeError: range.message };
        const exact = range.kind === "none-nearby" || (range.lower <= lo && range.upper >= hi);
        const { amount0, amount1 } = amountsFor(BigInt(p.liquidity), lo, hi, p.tick);
        const a0 = amount0 / 10 ** p.decimals0;
        const a1 = amount1 / 10 ** p.decimals1;
        return {
          ...p,
          inRange: {
            amount0: a0,
            amount1: a1,
            usdg: p.usdgSide === 0 ? a0 : p.usdgSide === 1 ? a1 : null,
            bandPct: 1,
            exact,
          },
        };
      }),
    );

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
