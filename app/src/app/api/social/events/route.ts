import { NextResponse } from "next/server";
import { listFollowEvents } from "@/lib/server/social-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recent follow events, globally or involving ?target= (as follower or target). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const target = url.searchParams.get("target") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const events = await listFollowEvents({ target, limit });
  return NextResponse.json({ events });
}
