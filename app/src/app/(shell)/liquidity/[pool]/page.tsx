import type { Metadata } from "next";
import { LiquidityDetail } from "@/components/liquidity/liquidity-detail";
import { LpPoolDetail } from "@/components/liquidity/lp-pool-detail";

export const metadata: Metadata = {
  title: "Add liquidity | Floatdesk",
  description: "Provide liquidity to a pool, deposit into the Desk vault, or fund the next market.",
};

/**
 * One route, two kinds of thing behind it. A 32 byte value is a v4 pool id and
 * gets the LP page: a real concentrated liquidity pool with a distribution to
 * draw and a position you add to and remove from. An address is the Desk, the
 * funding queue or a market, which are venues of a different shape and keep
 * their existing page.
 */
export default async function LiquidityPoolPage({ params }: { params: Promise<{ pool: string }> }) {
  const { pool } = await params;
  return /^0x[0-9a-fA-F]{64}$/.test(pool) ? <LpPoolDetail /> : <LiquidityDetail />;
}
