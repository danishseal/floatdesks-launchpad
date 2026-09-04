import { NextRequest, NextResponse } from "next/server";
import { addSubscriber, getSubscriberCount } from "@/lib/store";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET() {
  return NextResponse.json({ count: await getSubscriberCount() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "enter a valid email" }, { status: 400 });
  }
  const result = await addSubscriber(email);
  return NextResponse.json(result);
}
