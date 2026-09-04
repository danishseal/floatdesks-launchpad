"use client";

import { useQuery } from "@tanstack/react-query";
import { listTokenProposals, type TokenProposal } from "@/lib/ansem/proposals";

export const TOKEN_PROPOSALS_QUERY_KEY = (
  tokenAddress: string,
  viewer?: string,
) => ["token-proposals", tokenAddress, viewer ?? null] as const;

/** Live token-category proposals for a single token, with vote tallies. Reads
 *  the governance treasury tx history (same source as the ANSEM proposals web
 *  app). `viewer` marks which option the connected wallet already chose. */
export function useTokenProposals(tokenAddress: string, viewer?: string) {
  return useQuery<TokenProposal[]>({
    queryKey: TOKEN_PROPOSALS_QUERY_KEY(tokenAddress, viewer),
    queryFn: () => listTokenProposals(tokenAddress, viewer),
    staleTime: 10_000,
    refetchInterval: 30_000,
    enabled: !!tokenAddress,
  });
}
