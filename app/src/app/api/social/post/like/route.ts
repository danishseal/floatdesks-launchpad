import { NextResponse } from "next/server";
import { togglePostLike } from "@/lib/server/social-store";
import { verifySocial, AUTH_MAX_AGE_MS, type SocialWriteBody } from "@/lib/server/verify";
import { canonicalSocialMessage } from "@/lib/social-sign";
import { relayLike } from "@/lib/server/social-chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREFIX = "ansem";

/** Like / unlike a post as the caller. The signature binds the contract's
 *  canonical message, so it verifies both here and (for on-chain targets) at
 *  the relay. `subject` is the target's on-chain id when it has one. */
export async function POST(req: Request) {
  let body: SocialWriteBody & {
    postId?: string;
    subject?: string;
    user?: string;
    like?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const { postId, user, like, ts, signature, pubkey } = body;
  const subject = body.subject ?? postId;
  if (!postId || !user || typeof like !== "boolean" || !ts || !signature || !pubkey) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  if (Math.abs(Date.now() - ts) > AUTH_MAX_AGE_MS) {
    return NextResponse.json({ error: "stale signature" }, { status: 401 });
  }

  const ok = await verifySocial({
    prefix: PREFIX,
    signer: user,
    message: canonicalSocialMessage("like", subject!, ts, ""),
    signatureB64: signature,
    pubkeyB64: pubkey,
    scheme: body.scheme,
    bodyBytesB64: body.bodyBytesB64,
    authInfoBytesB64: body.authInfoBytesB64,
    accountNumber: body.accountNumber,
    chainId: body.chainId,
  });
  if (!ok) {
    console.error("[social/post/like] verify failed", { postId, user, like, ts });
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  const { count } = await togglePostLike(postId, user, like);

  // Relay on-chain when the target is an on-chain post (numeric subject).
  if (subject && /^\d+$/.test(subject)) {
    await relayLike(
      { author: user, signature, pubkey, scheme: body.scheme, bodyBytesB64: body.bodyBytesB64, authInfoBytesB64: body.authInfoBytesB64, accountNumber: body.accountNumber, chainId: body.chainId },
      Number(subject),
      ts,
    );
  }

  return NextResponse.json({ count, liked: like });
}
