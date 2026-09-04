import { NextResponse } from "next/server";
import { getGraph, isFollowing } from "@/lib/server/social-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The follow graph for an address: follower/following counts (and lists), plus
 * whether an optional `?viewer=` currently follows this address.
 */
export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const viewer = new URL(req.url).searchParams.get("viewer");
  const graph = await getGraph(address);
  const viewerFollows = viewer ? await isFollowing(viewer, address) : false;
  return NextResponse.json({ ...graph, viewerFollows });
}
