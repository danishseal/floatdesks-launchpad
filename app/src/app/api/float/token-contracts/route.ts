/**
 * Every contract a launched token actually touches, for the page to print.
 *
 * The token page could name exactly one address, its own, and the pair in the
 * title bar said "AMM". That is the venue's category, not what the thing trades
 * against, and it is the same on every graduated token, so the one place a
 * reader looks for "what is this priced in" answered with a word that could not
 * vary. What it trades against is an fSHARE, which has a ticker and an address
 * and neither was anywhere on the screen.
 *
 * Everything below is read from the chain: the curve names its own underlying
 * and its own fSHARE, Listings names the ticker, and the pool ids come from the
 * verified pool keys. Nothing is composed out of a string the app already had.
 *
 * Absent is not zero. A field this could not read is null and says why in
 * `unreadable`, because the caller has to be able to render "we could not ask"
 * rather than a plausible blank row.
 */

import { NextResponse } from "next/server";
import type { Address } from "viem";
import { isAddress, zeroAddress } from "viem";
import { LISTINGS_ABI } from "@/lib/float/abi";
import { publicClient } from "@/lib/float/chain";
import { resolve } from "@/lib/float/registry";
import { cfTokenMeta } from "@/lib/float/curve-funder";
import { launcherHolding } from "@/lib/float/token-owner";
import { poolsForToken } from "@/lib/float/token-pools";
import { activeNetwork } from "@/lib/float/networks";

export interface ContractEntry {
  /** What to call it on screen, e.g. "SNOOZE" or "SNOOZE / fNTDO2". */
  label: string;
  /** What kind of thing the address identifies, for the row's caption. */
  kind: "token" | "fshare" | "pool" | "launcher" | "pool-manager";
  /** An address, or a v4 pool id, which is a hash and not an address. */
  value: `0x${string}`;
  /** Pool ids are not addresses and have no explorer page of their own. */
  explorable: boolean;
  note?: string;
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; body: unknown }>();

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token || !isAddress(token)) {
    return NextResponse.json({ error: "token must be an address" }, { status: 400 });
  }

  const key = token.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return NextResponse.json(hit.body);

  const net = activeNetwork();
  const unreadable: string[] = [];
  const entries: ContractEntry[] = [];
  let pair: string | null = null;
  let shareTicker: string | null = null;

  try {
    const pc = publicClient();

    // Which launcher holds it, asked directly rather than found in a list.
    // Reading a legacy token against the current launcher answers with a zero
    // struct instead of reverting, so the wrong launcher does not fail, it
    // fabricates; and the enumeration that used to answer this drops entries
    // under load, which turns a live token into a 404.
    const owner = await launcherHolding(token as Address);
    if (owner.kind === "unreadable") {
      return NextResponse.json(
        { error: `could not ask every launcher: ${owner.reasons.join("; ")}` },
        { status: 502 },
      );
    }
    if (owner.kind === "absent") {
      return NextResponse.json(
        { error: `no curve on this deployment holds ${token}` },
        { status: 404 },
      );
    }
    const owned = { launcher: owner.launcher, superseded: owner.superseded };
    const curve = owner.curve;
    const meta = await cfTokenMeta(token as Address).catch(() => ({ name: "", symbol: "" }));

    const symbol = meta.symbol || "TOKEN";
    entries.push({
      label: symbol,
      kind: "token",
      value: token as `0x${string}`,
      explorable: true,
    });

    // The fSHARE. The curve carries the ERC-20 itself, so this does not have to
    // be looked up by name anywhere.
    if (curve.share && curve.share !== zeroAddress) {
      try {
        const listings = await resolve("LISTINGS");
        const listing = (await pc.readContract({
          address: listings,
          abi: LISTINGS_ABI,
          functionName: "get",
          args: [curve.underlying],
        })) as { ticker: string };
        shareTicker = listing.ticker ? `f${listing.ticker}` : null;
      } catch (e) {
        // UnknownAsset reverts rather than answering with a blank, which is the
        // good failure: an unset mapping would have handed back a zero struct.
        unreadable.push(`listing for ${curve.underlying}: ${message(e)}`);
      }
      entries.push({
        label: shareTicker ?? "fSHARE",
        kind: "fshare",
        value: curve.share,
        explorable: true,
        note: shareTicker ? undefined : "ticker unreadable",
      });
      pair = shareTicker ? `${symbol} / ${shareTicker}` : null;
    } else {
      unreadable.push("the curve names no fSHARE");
    }

    // The two v4 pools, asked for by id rather than found by scanning every pool
    // on the deployment. The scan is not reliable enough to conclude "no pool"
    // from: it answered 6, 8 and 2 pools on three consecutive calls, and the
    // third answer would have printed "no v4 pool" over two live ones.
    let poolCount = 0;
    try {
      const found = await poolsForToken({
        launcher: owned.launcher,
        underlying: curve.underlying,
        memePoolId: curve.poolId,
      });
      poolCount = found.pools.length;
      unreadable.push(...found.unreadable);
      for (const kind of ["meme", "quote"] as const) {
        const p = found.pools.find((x) => x.kind === kind);
        if (!p) continue;
        entries.push({
          label: `${p.symbol0} / ${p.symbol1}`,
          kind: "pool",
          value: p.poolId,
          explorable: false,
          note: kind === "meme" ? "trades the token" : "prices the fSHARE",
        });
      }
      if (!found.pools.length && curve.graduated) {
        unreadable.push("graduated, but neither pool could be read");
      }
    } catch (e) {
      unreadable.push(`pools: ${message(e)}`);
    }

    entries.push({
      label: owned.superseded ? "Launcher (superseded)" : "Launcher",
      kind: "launcher",
      value: owned.launcher,
      explorable: true,
      note: owned.superseded ? "no registry key points here" : undefined,
    });

    const poolManager = await resolve("V4_POOL_MANAGER").catch(() => null);
    if (poolManager) {
      entries.push({
        label: "v4 PoolManager",
        kind: "pool-manager",
        value: poolManager,
        explorable: true,
        // An ungraduated token has no pool yet, and saying it holds them anyway
        // would be a claim about this token that is false today.
        note: poolCount ? (poolCount > 1 ? "holds both pools" : "holds the pool") : "no pool yet",
      });
    }

    const body = {
      pair,
      shareTicker,
      graduated: curve.graduated,
      explorer: net.explorer,
      entries,
      unreadable,
    };
    cache.set(key, { at: Date.now(), body });
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ error: message(e) }, { status: 502 });
  }
}

function message(e: unknown): string {
  // viem puts the useful part of a revert on the SECOND line; line one alone
  // drops the selector while looking like it kept it.
  if (!(e instanceof Error)) return String(e);
  const lines = e.message.split("\n").filter(Boolean);
  return lines.slice(0, 2).join(" ").slice(0, 200);
}
