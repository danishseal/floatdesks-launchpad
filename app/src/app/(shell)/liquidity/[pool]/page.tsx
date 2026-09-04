import type { Metadata } from "next";
import { LiquidityDetail } from "@/components/liquidity/liquidity-detail";

export const metadata: Metadata = {
  title: "HYPE/USDC Liquidity | Floatdesk",
  description: "Configure a hard-coded HYPE/USDC concentrated liquidity position.",
};

export default function LiquidityPoolPage() {
  return <LiquidityDetail />;
}
