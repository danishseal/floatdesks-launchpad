import { NextResponse } from "next/server";
import { getProfile } from "@/lib/server/social-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const profile = await getProfile(address);
  return NextResponse.json({ profile });
}
