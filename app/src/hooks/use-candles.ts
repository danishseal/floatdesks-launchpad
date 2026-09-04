"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchCandles, type Timeframe } from "@/lib/api";

export const CANDLES_QUERY_KEY = (address: string, timeframe: Timeframe) =>
  ["candles", address, timeframe] as const;

export function useCandles(tokenAddress: string, timeframe: Timeframe) {
  return useQuery({
    queryKey: CANDLES_QUERY_KEY(tokenAddress, timeframe),
    // Load the full candle history so the chart can pan/zoom over everything,
    // not just the most recent window.
    queryFn: () => fetchCandles(tokenAddress, timeframe, 1000),
    staleTime: 60_000,       // 1 minute (matches candle update frequency)
    refetchInterval: 60_000, // Auto-refresh every minute for live data
    enabled: !!tokenAddress,
  });
}
