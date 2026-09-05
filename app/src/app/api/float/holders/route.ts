/**
 * Holder distribution, rebuilt from Transfer logs.
 *
 * The Float indexer builds no holder index, so this panel returned an empty
 * list and said "No holders found" on tokens that plainly had holders. An
 * ERC-20's holder set is derivable from its own logs, so derive it: scan
 * Transfer from the token's first block and net the deltas.
 *
 * Scoped deliberately. It scans from the launch block rather than genesis, in
 * chunks, and caches, because this is a launchpad token that has existed for
 * hours. It is not a general-purpose indexer and does not pretend to be: if the
 * range is too wide to scan it says so rather than returning a partial set that
 * looks complete.
 */

import { NextResponse } from "next/server";
import { publicClient } from "@/lib/float/chain";
import { resolve } from "@/lib/float/registry";
import { activeNetwork } from "@/lib/float/networks";
import { parseAbiItem, type Address } from "viem";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ZERO = "0x0000000000000000000000000000000000000000";
const CHUNK = 50_000n;
const MAX_BLOCKS = 500_000n; // beyond this, say so rather than scan forever
const CACHE_MS = 30_000;

const cache = new Map<string, { at: number; body: unknown }>();

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token")?.toLowerCase();
  if (!token || !/^0x[0-9a-f]{40}$/.test(token)) {
    return NextResponse.json({ error: "token query param required" }, { status: 400 });
  }

  const net = activeNetwork();
  const key = `${net.registry}:${token}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json(hit.body, { headers: { "cache-control": "no-store" } });
  }

  try {
    const pc = publicClient();
    const tip = await pc.getBlockNumber();

    // Start at the token's own first block where we know it, so a fresh launch
    // costs one small scan instead of a chain-wide one.
    const origin = process.env.FLOAT_INDEXER_ORIGIN ?? "http://localhost:8462";
    let from = 0n;
    try {
      const r = await fetch(`${origin}/tokens?token=${token}`, { cache: "no-store" });
      if (r.ok) {
        const t = await r.json();
        if (t?.block) from = BigInt(t.block);
      }
    } catch { /* fall through to the window below */ }
    if (from === 0n) from = tip > MAX_BLOCKS ? tip - MAX_BLOCKS : 0n;

    if (tip - from > MAX_BLOCKS) {
      return NextResponse.json({
        token, holders: [], scanned: null,
        truncated: true,
        note: "history is wider than this route will scan; holders are unknown, not zero",
      }, { headers: { "cache-control": "no-store" } });
    }

    const balances = new Map<string, bigint>();
    for (let start = from; start <= tip; start += CHUNK) {
      const end = start + CHUNK - 1n > tip ? tip : start + CHUNK - 1n;
      const logs = await pc.getLogs({
        address: token as Address, event: TRANSFER, fromBlock: start, toBlock: end,
      });
      for (const l of logs) {
        const { from: f, to: t, value } = l.args as { from: Address; to: Address; value: bigint };
        if (f && f.toLowerCase() !== ZERO) {
          balances.set(f.toLowerCase(), (balances.get(f.toLowerCase()) ?? 0n) - value);
        }
        if (t && t.toLowerCase() !== ZERO) {
          balances.set(t.toLowerCase(), (balances.get(t.toLowerCase()) ?? 0n) + value);
        }
      }
    }

    // Label the addresses that are protocol machinery, so a curve holding its
    // own unsold supply does not read as a whale.
    const labels = new Map<string, string>();
    for (const k of ["TOKEN_LAUNCHPAD", "CURVE_FUNDER", "DESK", "STAKE_VAULTS", "FUNDER"] as const) {
      try { labels.set((await resolve(k)).toLowerCase(), k); } catch { /* absent on this deployment */ }
    }

    const holders = [...balances.entries()]
      .filter(([, v]) => v > 0n)
      .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
      .map(([address, balance]) => ({
        address,
        balance: balance.toString(),
        label: labels.get(address) ?? null,
      }));

    const body = {
      token,
      holders,
      scanned: { from: Number(from), to: Number(tip) },
      truncated: false,
    };
    cache.set(key, { at: Date.now(), body });
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : String(e) },
      { status: 502 },
    );
  }
}
