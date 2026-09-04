import { NextResponse } from "next/server";
import { markNotificationsRead } from "@/lib/server/social-store";
import { verifySocial, socialAuthMessage, AUTH_MAX_AGE_MS, type SocialWriteBody } from "@/lib/server/verify";
import { notificationsReadSignAction } from "@/lib/social-sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREFIX = "ansem";

/**
 * Mark the caller's notifications read. Same signed-request model as the read:
 * the caller signs notificationsReadSignAction() to prove they own `me`, and
 * only that VERIFIED address is passed to the store. `ids` marks the listed
 * notifications; omitting it marks all of the caller's unread.
 */
export async function POST(req: Request) {
  let body: SocialWriteBody & {
    me?: string;
    ids?: string[];
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
    message: socialAuthMessage(notificationsReadSignAction(), ts),
    signatureB64: signature,
    pubkeyB64: pubkey,
    scheme: body.scheme,
    bodyBytesB64: body.bodyBytesB64,
    authInfoBytesB64: body.authInfoBytesB64,
    accountNumber: body.accountNumber,
    chainId: body.chainId,
  });
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : undefined;
  const marked = await markNotificationsRead(me, ids);
  return NextResponse.json({ marked });
}
