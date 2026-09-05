/**
 * OHLC for one launched token, built from the chain's own trade logs.
 *
 * This route exists to take `/candles` away from the indexer proxy. The mainnet
 * indexer has no candle table and no `CurveBuy` index, so `/candles` returned
 * `[]` for every token on this venue, and `[]` reads as "never traded". Tokens
 * that had really traded therefore rendered the empty state over their own
 * history. A more specific segment wins over `[...path]`, so putting the file
 * here is the whole redirection.
 *
 * On failure this answers a non-2xx rather than an empty array, so the chart's
 * error branch can say we could not ask. `[]` from here means no trades, and
 * only that.
 */

import { NextResponse } from "next/server";
import type { Address } from "viem";
import { isAddress } from "viem";
import { tokenPriceHistory, toCandles } from "@/lib/float/curve-trades";

/** Buckets the client asks for, in seconds. Anything else is refused. */
const ALLOWED_BUCKETS = new Set([60, 300, 900, 3600, 14400, 43200, 86400]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const bucket = Number(url.searchParams.get("bucket") ?? 3600);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 1000), 1), 5000);

  if (!token || !isAddress(token)) {
    return NextResponse.json({ error: "token must be an address" }, { status: 400 });
  }
  if (!ALLOWED_BUCKETS.has(bucket)) {
    return NextResponse.json({ error: `unsupported bucket ${bucket}` }, { status: 400 });
  }

  try {
    const history = await tokenPriceHistory(token as Address);

    // A source that could not be read is not a source with nothing in it. If
    // the logs failed and we have no points, refuse rather than draw an empty
    // chart that claims the token never traded.
    if (history.unreadable.length && !history.points.length) {
      return NextResponse.json(
        { error: history.unreadable.join("; ") },
        { status: 502 },
      );
    }

    // A partial read is still a partial read. The series renders, because half
    // a chart beats none, but the reason travels with it rather than being
    // dropped: a short series that looks complete is the failure this whole
    // route exists to stop repeating.
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (history.unreadable.length) {
      headers["x-float-unreadable"] = history.unreadable.join("; ").slice(0, 900);
    }
    return NextResponse.json(toCandles(history.points, bucket, limit), { headers });
  } catch (e) {
    const detail = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}
