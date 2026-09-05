/**
 * Server-side proxy to the Float indexer.
 *
 * Two jobs beyond forwarding:
 *  - the indexer runs on localhost:8462 and has no CORS, so the browser cannot
 *    reach it directly;
 *  - its `trades` table stores `block` but no timestamp, so any 24h/7d window
 *    needs block times. We resolve the distinct blocks once and cache them,
 *    which is cheap because block times never change.
 */

import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { activeNetwork } from "@/lib/float/networks";

const ORIGIN = process.env.FLOAT_INDEXER_ORIGIN ?? "http://localhost:8462";

const blockTimes = new Map<string, number>();

async function timestampsFor(blocks: number[]): Promise<Map<number, number>> {
  const net = activeNetwork();
  const missing = blocks.filter((b) => !blockTimes.has(`${net.chainId}:${b}`));
  if (missing.length) {
    const pc = createPublicClient({ transport: http(net.rpc, { batch: true }) });
    await Promise.all(
      missing.map(async (b) => {
        try {
          const blk = await pc.getBlock({ blockNumber: BigInt(b) });
          blockTimes.set(`${net.chainId}:${b}`, Number(blk.timestamp));
        } catch {
          /* pruned or unreachable: leave it out rather than guess */
        }
      }),
    );
  }
  const out = new Map<number, number>();
  for (const b of blocks) {
    const t = blockTimes.get(`${net.chainId}:${b}`);
    if (t !== undefined) out.set(b, t);
  }
  return out;
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const target = `${ORIGIN}/${path.join("/")}${url.search}`;

  let res: Response;
  try {
    res = await fetch(target, { cache: "no-store", headers: { accept: "application/json" } });
  } catch {
    return NextResponse.json(
      { error: "indexer unreachable", indexer: ORIGIN },
      { status: 503 },
    );
  }
  if (!res.ok) {
    return NextResponse.json({ error: `indexer HTTP ${res.status}` }, { status: res.status });
  }

  let body = await res.json();

  // The indexer answers an UNKNOWN path with 200 and its endpoint listing
  // rather than a 404, so a request for a route it does not have looks like a
  // success and the caller parses a menu as data. That is how the analytics
  // page came to crash on `undefined.length`. Translate it back into the 404 it
  // should have been.
  if (
    body && typeof body === "object" && !Array.isArray(body) &&
    Array.isArray((body as { endpoints?: unknown }).endpoints) &&
    path.join("/") !== ""
  ) {
    return NextResponse.json(
      { error: `indexer has no /${path.join("/")}`, endpoints: (body as { endpoints: string[] }).endpoints },
      { status: 404 },
    );
  }

  // Enrich trade rows with a real timestamp so the UI can window them.
  if (Array.isArray(body) && body.length && "block" in body[0] && !("ts" in body[0])) {
    const times = await timestampsFor([...new Set(body.map((r: { block: number }) => r.block))]);
    body = body.map((r: { block: number }) => ({ ...r, ts: times.get(r.block) ?? null }));
  }

  return NextResponse.json(body, {
    headers: { "cache-control": "no-store" },
  });
}
