/**
 * The DeskHook board: sole-LP dealer pools, one per listing.
 *
 * Deliberately its own route rather than a key inside /api/float/pools. The
 * Desk vault board is what people actually deposit into, and a DeskHook read
 * that reverts must not be able to take it down. This route is allowed to fail
 * on its own; the caller renders the section only when it returns pools.
 *
 * An empty array is the normal answer on any deployment whose registry has no
 * DESK_HOOK, which today is all of them.
 */

import { NextResponse } from "next/server";
import { hookPools, deskHookAddress } from "@/lib/float/desk-hook";
import { resolve } from "@/lib/float/registry";
import { erc20 } from "@/lib/float/chain";
import { activeNetwork } from "@/lib/float/networks";

export async function GET() {
  const net = activeNetwork();
  try {
    const hook = await deskHookAddress();
    if (!hook) {
      return NextResponse.json(
        // hook: null is "this deployment has no DeskHook", which is a different
        // fact from "it has one and there are no pools". Both return an empty
        // list, so the caller is told which it is looking at.
        { network: net.key, hook: null, pools: [], unreadable: [], quote: null, asOf: Math.floor(Date.now() / 1000) },
        { headers: { "cache-control": "no-store" } },
      );
    }

    const usdgAddr = await resolve("USDG");
    const [usdg, result] = await Promise.all([erc20(usdgAddr), hookPools()]);

    return NextResponse.json(
      {
        network: net.key,
        hook,
        quote: { address: usdgAddr, symbol: usdg.symbol, decimals: usdg.decimals },
        pools: result.pools,
        unreadable: result.unreadable,
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
