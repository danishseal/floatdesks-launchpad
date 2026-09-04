import { NextResponse } from "next/server";
import { listHashtagPosts } from "@/lib/server/social-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TAG_RE = /^[a-z0-9_]{2,32}$/;

/** Public hashtag feed: recent main-feed posts containing #<tag>. */
export async function GET(req: Request, { params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  const clean = decodeURIComponent(tag).replace(/^#/, "").toLowerCase();
  if (!TAG_RE.test(clean)) {
    return NextResponse.json({ error: "invalid tag" }, { status: 400 });
  }
  const { searchParams } = new URL(req.url);
  const limit = Number(searchParams.get("limit") ?? 50) || 50;
  const viewer = searchParams.get("viewer") ?? undefined;
  const posts = await listHashtagPosts(clean, { limit, viewer });
  return NextResponse.json({ posts });
}
