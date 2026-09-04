import { NextResponse } from "next/server";
import { addComment } from "@/lib/server/social-store";
import { verifySocial, socialAuthMessage, AUTH_MAX_AGE_MS, type SocialWriteBody } from "@/lib/server/verify";
import { commentSignAction } from "@/lib/social-sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREFIX = "ansem";
const MAX_LEN = 480;

/** Post a comment on a token. The signature binds the author + token + text. */
export async function POST(req: Request) {
  let body: SocialWriteBody & {
    author?: string;
    token?: string;
    text?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { author, token, ts, signature, pubkey } = body;
  const text = (body.text ?? "").trim();
  if (!author || !token || !text || !ts || !signature || !pubkey) {
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
    message: socialAuthMessage(commentSignAction(token, text), ts),
    signatureB64: signature,
    pubkeyB64: pubkey,
    scheme: body.scheme,
    bodyBytesB64: body.bodyBytesB64,
    authInfoBytesB64: body.authInfoBytesB64,
    accountNumber: body.accountNumber,
    chainId: body.chainId,
  });
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  const comment = await addComment(token, author, text);
  return NextResponse.json({ comment });
}
