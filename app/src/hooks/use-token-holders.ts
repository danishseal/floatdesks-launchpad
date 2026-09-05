"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchTokenHolders, TOKEN_HOLDERS_QUERY_KEY } from "@/lib/api";

export function useTokenHolders(tokenAddress: string) {
  return useQuery({
    queryKey: TOKEN_HOLDERS_QUERY_KEY(tokenAddress),
    queryFn: () => fetchTokenHolders(tokenAddress),
    staleTime: 15_000,
    refetchInterval: 30_000,
    enabled: !!tokenAddress,
  });
}
