import { NextResponse } from "next/server";
import { listTrendingPosts } from "@/lib/server/social-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public trending feed: main-feed posts ranked by a windowed engagement score
 * with recency decay. `?window=` is hours (default 24); `?viewer=` adds the
 * viewer's like/repost flags. No auth (trending is public data).
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const windowHours = Number(searchParams.get("window") ?? 24) || 24;
  const limit = Number(searchParams.get("limit") ?? 30) || 30;
  const viewer = searchParams.get("viewer") ?? undefined;
  const posts = await listTrendingPosts({ windowHours, limit, viewer });
  return NextResponse.json({ posts });
}
