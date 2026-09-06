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
    // A trader who just bought watches this pane for their own print, and a
    // minute of nothing reads as a failed trade. The route can afford this
    // cadence now: a refresh scans only the blocks since the last one instead
    // of rebuilding the series from genesis.
    staleTime: 5_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    enabled: !!tokenAddress,
  });
}
