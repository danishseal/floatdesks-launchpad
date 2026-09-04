import { NextResponse } from "next/server";
import { getNotifications, getUnreadCount } from "@/lib/server/social-store";
import { verifySocial, socialAuthMessage, AUTH_MAX_AGE_MS, type SocialWriteBody } from "@/lib/server/verify";
import { notificationsReadSignAction } from "@/lib/social-sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREFIX = "ansem";

/**
 * Read the caller's notifications + unread count. A signed read is a
 * write-shaped request: the reader signs notificationsReadSignAction() to prove
 * they own `me`, and only that VERIFIED address is passed to the store — so a
 * wallet's notifications are readable only by that wallet. (Server-trust
 * privacy, the same model as DMs.) Returns { items, unread } in one round-trip so
 * the badge poll and the panel share a single signed request.
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

  const [items, unread] = await Promise.all([getNotifications(me, body.limit), getUnreadCount(me)]);
  return NextResponse.json({ items, unread });
}
