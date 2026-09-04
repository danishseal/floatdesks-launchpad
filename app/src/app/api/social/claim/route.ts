import { NextResponse } from "next/server";
import { claimUsername } from "@/lib/server/social-store";
import { verifySocial, socialAuthMessage, AUTH_MAX_AGE_MS, type SocialWriteBody } from "@/lib/server/verify";
import { claimUsernameSignAction } from "@/lib/social-sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREFIX = "ansem";

/**
 * Claim a reserved username. The signature binds the exact one-time token, so a
 * verified caller proves both who they are and which token they are redeeming.
 * On success the reserved handle + preset (and any verified badge) bind to the
 * caller's wallet and the token is consumed. The store trusts this app-verified
 * identity and forwards to the indexer with the bearer.
 */
export async function POST(req: Request) {
  let body: SocialWriteBody & {
    address?: string;
    token?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const { address, token, ts, signature, pubkey } = body;
  if (!address || !token || !ts || !signature || !pubkey) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  if (Math.abs(Date.now() - ts) > AUTH_MAX_AGE_MS) {
    return NextResponse.json({ error: "stale signature" }, { status: 401 });
  }

  const ok = await verifySocial({
    prefix: PREFIX,
    signer: address,
    message: socialAuthMessage(claimUsernameSignAction(token), ts),
    signatureB64: signature,
    pubkeyB64: pubkey,
    scheme: body.scheme,
    bodyBytesB64: body.bodyBytesB64,
    authInfoBytesB64: body.authInfoBytesB64,
    accountNumber: body.accountNumber,
    chainId: body.chainId,
  });
  if (!ok) {
    console.error("[social/claim] signature verify failed", { address, ts });
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  try {
    const profile = await claimUsername(address, token);
    return NextResponse.json({ profile });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not claim username";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
