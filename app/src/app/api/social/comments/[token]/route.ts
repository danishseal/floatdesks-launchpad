import { NextResponse } from "next/server";
import { listComments } from "@/lib/server/social-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List comments for a token, newest first. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 100);
  const comments = await listComments(token, limit);
  return NextResponse.json({ comments });
}
