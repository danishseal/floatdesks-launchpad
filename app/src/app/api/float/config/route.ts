/**
 * What network the SERVER is actually on.
 *
 * The client cannot infer this: NEXT_PUBLIC_* is baked into its bundle at build
 * time, so a server started with a different value disagrees with it silently.
 * This is the one authoritative answer, and the client adopts it at boot.
 */
import { NextResponse } from "next/server";
import { activeNetwork, activeNetworkKey } from "@/lib/float/networks";

export async function GET() {
  const net = activeNetwork();
  return NextResponse.json(
    {
      key: activeNetworkKey(),
      label: net.label,
      chainId: net.chainId,
      rpc: net.rpc,
      registry: net.registry,
      explorer: net.explorer,
      testnet: net.testnet,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
