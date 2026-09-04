import { NextResponse } from "next/server";
import { listTrendingHashtags } from "@/lib/server/social-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public trending hashtags, ranked by distinct posts in the last 24h. */
export async function GET(req: Request) {
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 12) || 12;
  const tags = await listTrendingHashtags(limit);
  return NextResponse.json({ tags });
}
