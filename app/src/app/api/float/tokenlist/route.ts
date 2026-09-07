/**
 * Every launched token, as a Uniswap token list.
 *
 * This is the format wallets, explorers and terminals already ingest, and
 * Float published nothing of the kind, so a launched token appeared everywhere
 * else as a bare address with no name and no logo. `logoURI` points at the
 * token-image route beside this one rather than at a data: URI, because a lot
 * of consumers refuse those.
 *
 * Read from the chain rather than the indexer: the indexer's token rows carry
 * metadata from a different launchpad's events and are empty on this venue,
 * and a list that silently omits tokens is worse than no list.
 */

import { NextResponse } from "next/server";
import { activeNetwork } from "@/lib/float/networks";
import { cfAllTokensDetailed, cfTokenMeta, readTokenMeta } from "@/lib/float/curve-funder";
import { isHiddenLaunch } from "@/lib/float/hidden-launches";

export const revalidate = 300;

export async function GET(req: Request) {
  const net = activeNetwork();
  const origin = new URL(req.url).origin;

  let entries: Awaited<ReturnType<typeof cfAllTokensDetailed>>;
  try {
    entries = await cfAllTokensDetailed();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message.split("\n")[0] : "could not read launches" },
      { status: 502 },
    );
  }

  const tokens = (
    await Promise.all(
      entries
        .filter(({ token }) => !isHiddenLaunch(token))
        .map(async ({ token }) => {
          const [meta, extra] = await Promise.all([
            cfTokenMeta(token).catch(() => null),
            readTokenMeta(token).catch(() => null),
          ]);
          // A token whose symbol will not read is not describable, so it is
          // left out rather than listed as a blank row.
          if (!meta?.symbol) return null;
          return {
            chainId: net.chainId,
            address: token,
            name: meta.name || meta.symbol,
            symbol: meta.symbol,
            decimals: 18,
            ...(extra?.image ? { logoURI: `${origin}/api/float/token-image/${token}` } : {}),
          };
        }),
    )
  ).filter(Boolean);

  return NextResponse.json(
    {
      name: "Float launches",
      timestamp: new Date().toISOString(),
      version: { major: 1, minor: 0, patch: 0 },
      keywords: ["float", "floatdesks", "launchpad"],
      tokens,
    },
    { headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } },
  );
}
