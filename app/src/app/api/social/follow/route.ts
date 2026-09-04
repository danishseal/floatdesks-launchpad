import { NextResponse } from "next/server";
import { setFollow } from "@/lib/server/social-store";
import { verifySocial, socialAuthMessage, AUTH_MAX_AGE_MS, type SocialWriteBody } from "@/lib/server/verify";
import { followSignAction } from "@/lib/social-sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREFIX = "ansem";

/** Follow / unfollow a target as the caller. Requires a valid ADR-36 signature. */
export async function POST(req: Request) {
  let body: SocialWriteBody & {
    follower?: string;
    target?: string;
    follow?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const { follower, target, follow, ts, signature, pubkey } = body;
  if (!follower || !target || typeof follow !== "boolean" || !ts || !signature || !pubkey) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  if (follower === target) {
    return NextResponse.json({ error: "cannot follow yourself" }, { status: 400 });
  }
  if (Math.abs(Date.now() - ts) > AUTH_MAX_AGE_MS) {
    return NextResponse.json({ error: "stale signature" }, { status: 401 });
  }

  const ok = await verifySocial({
    prefix: PREFIX,
    signer: follower,
    message: socialAuthMessage(followSignAction(target, follow), ts),
    signatureB64: signature,
    pubkeyB64: pubkey,
    scheme: body.scheme,
    bodyBytesB64: body.bodyBytesB64,
    authInfoBytesB64: body.authInfoBytesB64,
    accountNumber: body.accountNumber,
    chainId: body.chainId,
  });
  if (!ok) {
    console.error("[social/follow] ADR-36 verify failed", { follower, target, follow, ts });
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  const now = await setFollow(follower, target, follow);
  return NextResponse.json({ following: now });
}
