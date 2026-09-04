import { NextResponse } from "next/server";
import { searchProfiles, resolveUsername } from "@/lib/server/social-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public profile search. `?q=` returns username/display-name/address matches;
 * `?resolve=<handle>` returns the single address bound to an exact username.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const resolve = searchParams.get("resolve");
  if (resolve != null) {
    const address = await resolveUsername(resolve);
    return NextResponse.json({ address });
  }
  const q = searchParams.get("q") ?? "";
  const hits = await searchProfiles(q, 8);
  return NextResponse.json({ profiles: hits });
}
