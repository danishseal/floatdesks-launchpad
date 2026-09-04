"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchTokens, fetchTokenChanges } from "@/lib/api";

export const TOKENS_QUERY_KEY = ["tokens"] as const;

export function useTokens() {
  const tokensQuery = useQuery({
    queryKey: TOKENS_QUERY_KEY,
    queryFn: fetchTokens,
    staleTime: 30_000,       // 30s - SSE updates in between
    refetchInterval: 60_000, // Fallback: refetch every 60s if SSE disconnects
  });

  // Real 24h change is derived from candles (the /tokens payload has no 24h-open
  // field). Only tokens that actually traded in the last 24h can move, so we
  // fetch candles for just those - never one request per token per render. The
  // address list is sorted so the query key is stable regardless of list order,
  // which dedupes and caches the enrichment across components. Changes are cached
  // for several minutes; a fresh price 24h-window shift is not worth re-fetching
  // on every token-list refetch.
  const activeAddresses = useMemo(() => {
    const tokens = tokensQuery.data;
    if (!tokens) return [] as string[];
    return tokens
      .filter((t) => t.trade_count_24h > 0)
      .map((t) => t.address)
      .sort();
  }, [tokensQuery.data]);

  const changesQuery = useQuery({
    queryKey: ["token-changes", activeAddresses],
    queryFn: () => fetchTokenChanges(activeAddresses),
    enabled: activeAddresses.length > 0,
    staleTime: 5 * 60_000,        // 5m - changes shift slowly
    refetchInterval: 5 * 60_000,
  });

  // Merge computed changes onto the token list without changing the hook's
  // return surface: components still read `.data` / `.isLoading` / `.error` etc.
  // Tokens with no derivable history keep price_change_24h = null (renders "-").
  const data = useMemo(() => {
    const tokens = tokensQuery.data;
    if (!tokens) return tokens;
    const changes = changesQuery.data;
    if (!changes) return tokens;
    return tokens.map((t) => {
      const change = changes[t.address];
      return change == null ? t : { ...t, price_change_24h: change };
    });
  }, [tokensQuery.data, changesQuery.data]);

  return { ...tokensQuery, data };
}
