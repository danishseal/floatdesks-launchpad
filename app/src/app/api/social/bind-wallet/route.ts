import { NextResponse } from "next/server";
import { bindWallet } from "@/lib/server/social-store";
import { verifySocial, socialAuthMessage, AUTH_MAX_AGE_MS, type SocialWriteBody } from "@/lib/server/verify";
import { bindWalletSignAction } from "@/lib/social-sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREFIX = "ansem";

/**
 * Bind a real wallet to a token-owned account (the "claim without a wallet"
 * flow's graduation step). Unlike claim-token / token-profile, this DOES require
 * a wallet signature — that is the security upgrade: the token proves WHICH
 * token-owned account, and the signature (binding that exact token) proves the
 * NEW wallet. On success ownership migrates from `token-<username>` to the wallet
 * and the token is spent. After this it is an ordinary wallet-owned profile.
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
    message: socialAuthMessage(bindWalletSignAction(token), ts),
    signatureB64: signature,
    pubkeyB64: pubkey,
    scheme: body.scheme,
    bodyBytesB64: body.bodyBytesB64,
    authInfoBytesB64: body.authInfoBytesB64,
    accountNumber: body.accountNumber,
    chainId: body.chainId,
  });
  if (!ok) {
    console.error("[social/bind-wallet] signature verify failed", { address, ts });
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  try {
    const profile = await bindWallet(address, token);
    return NextResponse.json({ profile });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not bind wallet";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
