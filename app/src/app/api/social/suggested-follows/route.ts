import { NextResponse } from "next/server";
import { listSuggestedFollows } from "@/lib/server/social-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public "who to follow": profiles the viewer doesn't already follow, ranked by
 * follower count and (when `?me=` is given) follows-of-follows overlap. Reads
 * only public follow data, so no auth even though it is personalized by `me`.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const me = searchParams.get("me");
  const limit = Number(searchParams.get("limit") ?? 8) || 8;
  const profiles = await listSuggestedFollows(me, limit);
  return NextResponse.json({ profiles });
}
