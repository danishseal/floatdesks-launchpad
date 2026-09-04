import { NextResponse } from "next/server";
import { upsertProfile, SocialError, type Profile } from "@/lib/server/social-store";
import { verifySocial, socialAuthMessage, AUTH_MAX_AGE_MS, type SocialWriteBody } from "@/lib/server/verify";
import { editProfileSignAction } from "@/lib/social-sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREFIX = "ansem";

/** Upsert the caller's own profile. Body must carry a valid ADR-36 signature. */
export async function POST(req: Request) {
  let body: SocialWriteBody & {
    address?: string;
    profile?: Profile;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const { address, profile, ts, signature, pubkey } = body;
  if (!address || !profile || !ts || !signature || !pubkey) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  if (Math.abs(Date.now() - ts) > AUTH_MAX_AGE_MS) {
    return NextResponse.json({ error: "stale signature" }, { status: 401 });
  }

  const ok = await verifySocial({
    prefix: PREFIX,
    signer: address,
    message: socialAuthMessage(editProfileSignAction(), ts),
    signatureB64: signature,
    pubkeyB64: pubkey,
    scheme: body.scheme,
    bodyBytesB64: body.bodyBytesB64,
    authInfoBytesB64: body.authInfoBytesB64,
    accountNumber: body.accountNumber,
    chainId: body.chainId,
  });
  if (!ok) {
    console.error("[social/profile] ADR-36 verify failed", { address, ts });
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  const clean: Profile = {
    username: str(profile.username, 20),
    displayName: str(profile.displayName, 40),
    bio: str(profile.bio, 160),
    // Avatar/banner may be inline data: URLs (downscaled client-side), so allow
    // a generous cap rather than the ~400 chars a plain URL would need.
    avatar: str(profile.avatar, 1_500_000),
    banner: str(profile.banner, 1_500_000),
    twitter: str(profile.twitter, 80),
    telegram: str(profile.telegram, 80),
  };
  try {
    const saved = await upsertProfile(address, clean);
    return NextResponse.json({ profile: saved });
  } catch (err) {
    if (err instanceof SocialError) {
      const status = err.code === "username_taken" ? 409 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}
