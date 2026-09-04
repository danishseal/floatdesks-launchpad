import type { Metadata } from "next";
import { LiquidityDetail } from "@/components/liquidity/liquidity-detail";

export const metadata: Metadata = {
  title: "Add liquidity | Floatdesk",
  description: "Deposit USDG into the Desk vault, fund the next market, or stake an fSHARE.",
};

export default function LiquidityPoolPage() {
  return <LiquidityDetail />;
}
