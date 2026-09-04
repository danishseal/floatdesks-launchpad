import { NextResponse } from "next/server";
import { sendDm } from "@/lib/server/social-store";
import { verifySocial, socialAuthMessage, AUTH_MAX_AGE_MS, type SocialWriteBody } from "@/lib/server/verify";
import { dmSendSignAction } from "@/lib/social-sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREFIX = "ansem";
const MAX_LEN = 2000;

/**
 * Send a direct message. The signature binds the sender + recipient + text, so a
 * verified sender proves both who they are and what they sent to whom. The
 * indexer trusts this app-verified identity (server-trust privacy, not E2E).
 */
export async function POST(req: Request) {
  let body: SocialWriteBody & {
    sender?: string;
    recipient?: string;
    text?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { sender, recipient, ts, signature, pubkey } = body;
  const text = (body.text ?? "").trim();
  if (!sender || !recipient || !text || !ts || !signature || !pubkey) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  if (sender === recipient) {
    return NextResponse.json({ error: "cannot message yourself" }, { status: 400 });
  }
  if (text.length > MAX_LEN) {
    return NextResponse.json({ error: "too long" }, { status: 400 });
  }
  if (Math.abs(Date.now() - ts) > AUTH_MAX_AGE_MS) {
    return NextResponse.json({ error: "stale signature" }, { status: 401 });
  }
  const ok = await verifySocial({
    prefix: PREFIX,
    signer: sender,
    message: socialAuthMessage(dmSendSignAction(recipient, text), ts),
    signatureB64: signature,
    pubkeyB64: pubkey,
    scheme: body.scheme,
    bodyBytesB64: body.bodyBytesB64,
    authInfoBytesB64: body.authInfoBytesB64,
    accountNumber: body.accountNumber,
    chainId: body.chainId,
  });
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  const message = await sendDm(sender, recipient, text);
  return NextResponse.json({ message });
}
