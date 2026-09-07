/**
 * A launched token's logo, at a plain HTTP URL.
 *
 * The image is written on chain as a data: URI in TokenMetadata, which is the
 * right place for it to live (nothing to rot) and the wrong place for anything
 * else to find it: no explorer, terminal or wallet knows to call
 * `TokenMetadata.uriOf`. That is why a launched token has never carried its
 * logo anywhere outside this app, before or after graduation.
 *
 * This unwraps the data URI and serves the bytes at a stable address that
 * anything can fetch. Immutable once written, so it is cached hard.
 */

import { NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import { readTokenMeta } from "@/lib/float/curve-funder";

const CACHE = "public, max-age=3600, stale-while-revalidate=86400";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  if (!isAddress(address)) {
    return NextResponse.json({ error: "address must be a token address" }, { status: 400 });
  }

  let image: string | null = null;
  try {
    image = (await readTokenMeta(address as Address))?.image ?? null;
  } catch {
    // A read that failed is not a token without a logo, so it answers 502
    // rather than 404: a cache should not remember this as "no image".
    return NextResponse.json({ error: "could not read token metadata" }, { status: 502 });
  }
  if (!image) return NextResponse.json({ error: "no image set" }, { status: 404 });

  // Already a URL somewhere else: send the caller there rather than proxying.
  if (/^https?:\/\//i.test(image)) return NextResponse.redirect(image, 302);

  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(image);
  if (!match) return NextResponse.json({ error: "unrecognised image encoding" }, { status: 415 });
  const [, type, base64, payload] = match;
  const bytes = base64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");

  return new NextResponse(new Uint8Array(bytes), {
    headers: { "content-type": type, "cache-control": CACHE, "access-control-allow-origin": "*" },
  });
}
