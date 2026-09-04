import { NextResponse } from "next/server";
import { editTokenProfile, type Profile } from "@/lib/server/social-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELIBERATE, DOCUMENTED EXCEPTION to the app's wallet-signature identity model.
 *
 * Edit a TOKEN-OWNED account's profile using the claim token as the credential —
 * NO wallet signature. This mirrors /api/social/claim-token: while an account is
 * still token-owned (no wallet bound yet), the token is the credential, so
 * possession of it authorizes edits. The indexer enforces that the token still
 * maps to an unbound `token-<username>` account and that only displayName / bio /
 * avatar / banner change (username + verified are locked). Once a wallet is
 * bound the token is spent and this path 400s.
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

  const p = body.profile ?? {};
  const clean: Profile = {
    displayName: str(p.displayName, 40),
    bio: str(p.bio, 160),
    avatar: str(p.avatar, 1_500_000),
    banner: str(p.banner, 1_500_000),
  };

  try {
    const profile = await editTokenProfile(token, clean);
    return NextResponse.json({ profile });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not save profile";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}
