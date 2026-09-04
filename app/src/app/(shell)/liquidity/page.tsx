import type { Metadata } from "next";
import { LiquidityMarket } from "@/components/liquidity/liquidity-market";

export const metadata: Metadata = {
  title: "Liquidity | Floatdesk",
  description: "The Desk vault, the funding queue, and every market it quotes.",
};

export default function LiquidityPage() {
  return <LiquidityMarket />;
}
