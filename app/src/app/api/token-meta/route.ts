import { NextResponse } from "next/server";
import { getTokenMeta, setTeamLaunch } from "@/lib/server/token-meta-store";
import {
  verifySocial,
  socialAuthMessage,
  AUTH_MAX_AGE_MS,
  type SocialWriteBody,
} from "@/lib/server/verify";
import { INDEXER_HTTP } from "@/lib/floorlaunch/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREFIX = "ansem";

// Reproduced here (not imported from the client module) so the signed message
// the server reconstructs cannot drift from what the wallet signed.
function teamLaunchSignAction(token: string, teamLaunch: boolean): string {
  return `set-team-launch:${token}:${teamLaunch ? 1 : 0}`;
}

/** Read a token's off-chain meta (the team-launch flag + who set it). */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 400 });
  const meta = await getTokenMeta(token);
  return NextResponse.json({ meta });
}

/**
 * Set the team-launch flag for a token. The body carries a wallet signature that
 * proves the caller owns `setBy`; we also do a best-effort check that `setBy` is
 * the token's on-chain creator (the indexer may not have indexed a just-launched
 * token yet, so a missing record is allowed - the read side still gates
 * effectiveness on setBy === creator). This is the same signed-write pattern the
 * social routes use.
 */
export async function POST(req: Request) {
  let body: SocialWriteBody & {
    token?: string;
    teamLaunch?: boolean;
    setBy?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const { token, setBy, ts, signature, pubkey } = body;
  const teamLaunch = Boolean(body.teamLaunch);
  if (!token || !setBy || !ts || !signature || !pubkey) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  if (Math.abs(Date.now() - ts) > AUTH_MAX_AGE_MS) {
    return NextResponse.json({ error: "stale signature" }, { status: 401 });
  }

  const ok = await verifySocial({
    prefix: PREFIX,
    signer: setBy,
    message: socialAuthMessage(teamLaunchSignAction(token, teamLaunch), ts),
    signatureB64: signature,
    pubkeyB64: pubkey,
    scheme: body.scheme,
    bodyBytesB64: body.bodyBytesB64,
    authInfoBytesB64: body.authInfoBytesB64,
    accountNumber: body.accountNumber,
    chainId: body.chainId,
  });
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  // Best-effort creator gate: reject only when the indexer knows a DIFFERENT
  // creator. A not-yet-indexed token (fresh launch) is allowed through.
  try {
    const r = await fetch(`${INDEXER_HTTP}/tokens/${encodeURIComponent(token)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (r.ok) {
      const t = (await r.json()) as { creator?: string | null };
      if (t.creator && t.creator !== setBy) {
        return NextResponse.json({ error: "not the token creator" }, { status: 403 });
      }
    }
  } catch {
    /* indexer unreachable: fall through, read side still gates on creator */
  }

  const meta = await setTeamLaunch(token, teamLaunch, setBy);
  return NextResponse.json({ meta });
}
