import { NextResponse } from "next/server";
import { addPostReply, listPostReplies } from "@/lib/server/social-store";
import { verifySocial, AUTH_MAX_AGE_MS, type SocialWriteBody } from "@/lib/server/verify";
import { canonicalSocialMessage } from "@/lib/social-sign";
import { relayReply } from "@/lib/server/social-chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREFIX = "ansem";
const MAX_LEN = 500;

/** List a post's replies (?postId=). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const postId = url.searchParams.get("postId");
  if (!postId) return NextResponse.json({ error: "missing postId" }, { status: 400 });
  const replies = await listPostReplies(postId);
  return NextResponse.json({ replies });
}

/** Reply to a post. The signature binds the contract's canonical message, so it
 *  verifies both here and (for an on-chain parent) at the relay, where the reply
 *  becomes its own on-chain post under the parent's id. */
export async function POST(req: Request) {
  let body: SocialWriteBody & {
    postId?: string;
    subject?: string;
    author?: string;
    text?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { postId, author, ts, signature, pubkey } = body;
  const text = (body.text ?? "").trim();
  const subject = body.subject ?? postId;
  if (!postId || !author || !text || !ts || !signature || !pubkey) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  if (text.length > MAX_LEN) {
    return NextResponse.json({ error: "too long" }, { status: 400 });
  }
  if (Math.abs(Date.now() - ts) > AUTH_MAX_AGE_MS) {
    return NextResponse.json({ error: "stale signature" }, { status: 401 });
  }
  const ok = await verifySocial({
    prefix: PREFIX,
    signer: author,
    message: canonicalSocialMessage("reply", subject!, ts, text),
    signatureB64: signature,
    pubkeyB64: pubkey,
    scheme: body.scheme,
    bodyBytesB64: body.bodyBytesB64,
    authInfoBytesB64: body.authInfoBytesB64,
    accountNumber: body.accountNumber,
    chainId: body.chainId,
  });
  if (!ok) {
    console.error("[social/post/reply] verify failed", { postId, author, ts });
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  // Relay on-chain when the parent is an on-chain post (numeric subject).
  let relayed: { onchainId?: string; txhash: string } | null = null;
  if (subject && /^\d+$/.test(subject)) {
    relayed = await relayReply(
      { author, signature, pubkey, scheme: body.scheme, bodyBytesB64: body.bodyBytesB64, authInfoBytesB64: body.authInfoBytesB64, accountNumber: body.accountNumber, chainId: body.chainId },
      Number(subject),
      text,
      ts,
    );
  }

  const reply = await addPostReply(postId, author, text, {
    onchainId: relayed?.onchainId,
    txhash: relayed?.txhash,
  });
  return NextResponse.json({ reply });
}
