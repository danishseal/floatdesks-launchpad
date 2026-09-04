import { NextResponse } from "next/server";
import { getPost } from "@/lib/server/social-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A single post by id (+ engagement counts). Pass ?viewer= for like/repost flags. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(_req.url);
  const viewer = url.searchParams.get("viewer") ?? undefined;
  const post = await getPost(id, viewer);
  if (!post) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ post });
}
