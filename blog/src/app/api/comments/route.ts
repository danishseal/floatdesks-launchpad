import { NextRequest, NextResponse } from "next/server";
import { getComments, addComment } from "@/lib/store";
import { verifyAuthor } from "@/lib/privy";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ comments: await getComments() });
}

export async function POST(req: NextRequest) {
  const token = req.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  if (!token) {
    return NextResponse.json({ error: "sign in to comment" }, { status: 401 });
  }
  const author = await verifyAuthor(token);
  if (!author) {
    return NextResponse.json({ error: "invalid session" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const text = String(body.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "empty comment" }, { status: 400 });
  if (text.length > 2000) {
    return NextResponse.json({ error: "comment too long" }, { status: 400 });
  }
  const comment = await addComment({
    id: crypto.randomUUID(),
    author,
    text,
    ts: Date.now(),
  });
  return NextResponse.json({ comment });
}
