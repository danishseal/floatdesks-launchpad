/**
 * What each launched token is worth right now, from the market that actually
 * trades it.
 *
 * `fetchCurveFunderTokens` prices every token off the curve:
 * `(vQuote + rQuote) / (vToken - sold)`. That is right up to graduation and
 * meaningless after it, because a graduated curve is spent and the token moved
 * to a v4 pool. It is not a small error either. SLEEPY's header read $2.03K of
 * market cap against a pool trading it at $24.62, and DOZE read $251.45 against
 * $269.92. The same number feeds the Bullpen table and every mcap on the board.
 *
 * The price is read from the pool's own slot, not from the last print in the
 * trade history. Both give the same number, because `sqrtPriceX96` only moves
 * when somebody swaps, but the history costs a full log scan per token and
 * having the page wait on that for every token before it could render turned a
 * token page into a twenty second blank screen. Two reads per token instead.
 * A token still on the curve is left alone: the curve formula is right there.
 *
 * `source` travels with the price so a caller can say which market it came
 * from, and a token with no prints at all is simply absent rather than being
 * given a zero.
 */

import { NextResponse } from "next/server";
import { cfAllTokensDetailed, cfCurve } from "@/lib/float/curve-funder";
import { livePoolPriceUsd, poolsForTokenCached } from "@/lib/float/token-pools";
import { mapLimited } from "@/lib/float/retry";

const TTL_MS = 20_000;
let cache: { at: number; body: Record<string, unknown> } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < TTL_MS) return NextResponse.json(cache.body);
  try {
    const all = await cfAllTokensDetailed();
    const entries = await mapLimited(all, async ({ token, launcher }) => {
      const curve = await cfCurve(token, launcher).catch(() => null);
      // Only a graduated token has a pool to be repriced from. One still on the
      // curve is already priced correctly by the curve formula.
      if (!curve?.graduated) return null;
      const { pools } = await poolsForTokenCached({
        launcher,
        underlying: curve.underlying,
        memePoolId: curve.poolId,
      }).catch(() => ({ pools: [] }));
      if (!pools.length) return null;
      const priceUsd = await livePoolPriceUsd(pools);
      if (!priceUsd) return null;
      // Liquidity is deliberately NOT computed here. Valuing a v4 position needs
      // the active tick range, and confirming that range is exact is a bitmap
      // search: adding it made this route take 41 seconds and, worse, starved
      // the cheap price reads through the shared concurrency gate until they
      // retried out and returned nothing. The liquidity board already owns that
      // computation, with its own exactness flag.
      return [
        token.toLowerCase(),
        { priceUsd, source: "pool" as const, ts: Math.floor(Date.now() / 1000) },
      ] as const;
    });

    const body = Object.fromEntries(
      entries.filter(Boolean) as Array<readonly [string, unknown]>,
    ) as Record<string, unknown>;
    cache = { at: Date.now(), body };
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message.split("\n")[0] : String(e) },
      { status: 502 },
    );
  }
}
