"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchRecentTrades, RECENT_TRADES_QUERY_KEY } from "@/lib/api";

export function useRecentTrades(limit: number = 50) {
  return useQuery({
    queryKey: [...RECENT_TRADES_QUERY_KEY, limit],
    queryFn: () => fetchRecentTrades(limit),
    staleTime: 10_000,       // 10s - SSE updates cache between refetches
    refetchInterval: 30_000, // Fallback: refetch every 30s if SSE disconnects
  });
}
