import { NextResponse } from "next/server";
import { getDmInbox } from "@/lib/server/social-store";
import { verifySocial, socialAuthMessage, AUTH_MAX_AGE_MS, type SocialWriteBody } from "@/lib/server/verify";
import { dmReadSignAction } from "@/lib/social-sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREFIX = "ansem";

/**
 * Read the caller's DM inbox. Like the thread read, the request is signed so the
 * caller proves they own `me`, and only that VERIFIED address is passed to the
 * store — the inbox is never enumerable for anyone else. (Server-trust privacy,
 * not end-to-end encryption.)
 */
export async function POST(req: Request) {
  let body: SocialWriteBody & {
    me?: string;
    limit?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { me, ts, signature, pubkey } = body;
  if (!me || !ts || !signature || !pubkey) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  if (Math.abs(Date.now() - ts) > AUTH_MAX_AGE_MS) {
    return NextResponse.json({ error: "stale signature" }, { status: 401 });
  }
  const ok = await verifySocial({
    prefix: PREFIX,
    signer: me,
    message: socialAuthMessage(dmReadSignAction(), ts),
    signatureB64: signature,
    pubkeyB64: pubkey,
    scheme: body.scheme,
    bodyBytesB64: body.bodyBytesB64,
    authInfoBytesB64: body.authInfoBytesB64,
    accountNumber: body.accountNumber,
    chainId: body.chainId,
  });
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  const threads = await getDmInbox(me, body.limit);
  return NextResponse.json({ threads });
}
