"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchCurveProgress } from "@/lib/api";

export function useCurveProgress(tokenAddress: string) {
  return useQuery({
    queryKey: ["curve-progress", tokenAddress],
    queryFn: () => fetchCurveProgress(tokenAddress),
    staleTime: 5_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    enabled: !!tokenAddress,
  });
}
