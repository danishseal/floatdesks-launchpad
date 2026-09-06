"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchToken } from "@/lib/api";

export const TOKEN_DETAIL_QUERY_KEY = (address: string) =>
  ["token", address] as const;

export function useTokenDetail(address: string) {
  return useQuery({
    queryKey: TOKEN_DETAIL_QUERY_KEY(address),
    queryFn: () => fetchToken(address),
    // Price and market cap are read straight off the curve, so they can move
    // as soon as a trade lands rather than up to a minute later.
    staleTime: 5_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    enabled: !!address,
  });
}
