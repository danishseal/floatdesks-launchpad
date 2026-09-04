"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchMarkets } from "@/lib/api";

export const XYZ_PRICE_QUERY_KEY = ["sol-price"] as const;

async function fetchSolPrice() {
  const markets = await fetchMarkets();
  const price = markets.find((market) => market.solUsd > 0)?.solUsd;
  if (!price) throw new Error("SOL/USD price is unavailable");
  return { price, source: "pyth" as const };
}

/** Compatibility name retained for chart consumers; value is SOL/USD. */
export function useXyzPrice() {
  const query = useQuery({
    queryKey: [...XYZ_PRICE_QUERY_KEY],
    queryFn: fetchSolPrice,
    staleTime: 120_000,
    refetchInterval: 120_000,
  });
  return {
    ...query,
    xyzPriceUsd: query.data?.price ?? 0,
    priceSource: query.data?.source ?? "pyth",
  };
}
