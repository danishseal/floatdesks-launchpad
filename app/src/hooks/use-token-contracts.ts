"use client";

import { useQuery } from "@tanstack/react-query";

export interface ContractEntry {
  label: string;
  kind: "token" | "fshare" | "pool" | "launcher" | "pool-manager";
  value: string;
  explorable: boolean;
  note?: string;
}

export interface TokenContracts {
  /** "SNOOZE / fNTDO2", or null when the fSHARE ticker could not be read. */
  pair: string | null;
  shareTicker: string | null;
  graduated: boolean;
  explorer: string;
  entries: ContractEntry[];
  /** Non-empty means part of this is missing because a read failed. */
  unreadable: string[];
}

export const TOKEN_CONTRACTS_QUERY_KEY = (address: string) =>
  ["token-contracts", address] as const;

/**
 * The contracts behind one launched token.
 *
 * Long stale time on purpose: an fSHARE address and a pool id do not change for
 * a launched token, and the only field that can move is `graduated`, which
 * moves once. Refetching this on a timer would be traffic bought with nothing.
 */
export function useTokenContracts(address: string) {
  return useQuery({
    queryKey: TOKEN_CONTRACTS_QUERY_KEY(address),
    queryFn: async (): Promise<TokenContracts> => {
      const res = await fetch(`/api/float/token-contracts?token=${address}`, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<TokenContracts>;
    },
    staleTime: 10 * 60_000,
    enabled: !!address,
  });
}
