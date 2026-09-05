/**
 * One LP pool, with everything the detail page needs: the verified PoolKey, the
 * live price and fee, and the pool's REAL liquidity distribution for the depth
 * chart, walked out from the active tick rather than drawn to look plausible.
 */

import { NextResponse } from "next/server";
import { lpPools, poolDepth, launchSeeded } from "@/lib/float/pools";
import { activeNetwork } from "@/lib/float/networks";

export async function GET(_req: Request, ctx: { params: Promise<{ poolId: string }> }) {
  const net = activeNetwork();
  const { poolId } = await ctx.params;
  try {
    const { pools } = await lpPools();
    const pool = pools.find((p) => p.poolId.toLowerCase() === poolId.toLowerCase());
    if (!pool) {
      return NextResponse.json(
        { error: "no such pool on this network", network: net.key, poolId },
        { status: 404 },
      );
    }
    const depth = await poolDepth(
      pool.poolId,
      pool.key.tickSpacing,
      pool.tick,
      BigInt(pool.liquidity),
    );
    const seeded = await launchSeeded(pool.poolId, depth, pool.key.tickSpacing);
    return NextResponse.json(
      {
        network: { key: net.key, chainId: net.chainId, explorer: net.explorer },
        pool,
        depth,
        seeded,
        asOf: Math.floor(Date.now() / 1000),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), network: net.key, poolId },
      { status: 502 },
    );
  }
}
