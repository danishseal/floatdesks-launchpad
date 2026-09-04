import type { Metadata } from "next";
import { LiquidityMarket } from "@/components/liquidity/liquidity-market";

export const metadata: Metadata = {
  title: "Liquidity | Floatdesk",
  description: "Browse Floatdesk liquidity pools and market rewards.",
};

export default function LiquidityPage() {
  return <LiquidityMarket />;
}
