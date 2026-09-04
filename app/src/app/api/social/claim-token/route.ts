import { NextResponse } from "next/server";
import { claimUsernameNoWallet, type Profile } from "@/lib/server/social-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELIBERATE, DOCUMENTED EXCEPTION to the app's wallet-signature identity model.
 *
 * Claim a reserved username WITHOUT a wallet: the raw claim token itself is the
 * credential ("token-as-credential"). There is NO wallet signature here on
 * purpose — whoever holds the token controls the resulting account (bound to a
 * synthetic `token-<username>` owner) until they later bind a real wallet
 * (/api/social/bind-wallet), which DOES require a signature. The token proving
 * the account is exactly the credential the reserve/claim flow issues, so
 * possession of it is sufficient to create the token-owned profile.
 *
 * The only gate here is token presence; the indexer verifies the token hash and
 * enforces one-account-per-token semantics.
 */
export async function POST(req: Request) {
  let body: { token?: string; profile?: Profile };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return NextResponse.json({ error: "missing token" }, { status: 400 });
  }

  // Only the mutable fields are honored server-side (username + verified come
  // from the reservation preset and are locked); clip them defensively here too.
  const p = body.profile ?? {};
  const clean: Profile = {
    displayName: str(p.displayName, 40),
    bio: str(p.bio, 160),
    avatar: str(p.avatar, 1_500_000),
    banner: str(p.banner, 1_500_000),
  };

  try {
    const { profile, ownerId } = await claimUsernameNoWallet(token, clean);
    return NextResponse.json({ profile, ownerId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not claim username";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}
