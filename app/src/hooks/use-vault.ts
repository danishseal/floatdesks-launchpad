"use client";

import { useQuery } from "@tanstack/react-query";
import { getHornVaultContract } from "@/lib/floorlaunch/live-config";
import {
  VAULT_DENOMS,
  querySink,
  queryStake,
  queryPending,
  type Coin,
} from "@/lib/ansem/vault-tx";

/** Per-sink state, straight from the contract. All amounts are micro-unit
 *  strings, formatted at the display layer. `staked`/`rewards` are null until a
 *  wallet is connected (those queries are staker-scoped). */
export interface VaultSink {
  denom: string;
  /** Sink TVL, micro-units. */
  totalStaked: string;
  rewardDenoms: string[];
  /** The connected wallet's stake, micro-units, or null if disconnected. */
  staked: string | null;
  /** The connected wallet's pending reward coins, or null if disconnected. */
  rewards: Coin[] | null;
}

export interface VaultState {
  /** True once a vault address resolves (env or reserved registry slot). */
  configured: boolean;
  vault: string | null;
  sinks: Record<string, VaultSink>;
}

export const VAULT_QUERY_KEY = (address: string | null) =>
  ["horn-vault", address ?? "none"] as const;

async function loadVault(staker: string | null): Promise<VaultState> {
  const vault = await getHornVaultContract();
  if (!vault) {
    return { configured: false, vault: null, sinks: {} };
  }

  const sinks: Record<string, VaultSink> = {};
  await Promise.all(
    VAULT_DENOMS.map(async (denom) => {
      // Sink TVL is public. Staker-scoped reads only when connected. Each read
      // is independently resilient so one failure does not blank the panel.
      const [sink, stake, pending] = await Promise.all([
        querySink(vault, denom).catch(() => null),
        staker ? queryStake(vault, denom, staker).catch(() => null) : Promise.resolve(null),
        staker ? queryPending(vault, denom, staker).catch(() => null) : Promise.resolve(null),
      ]);
      sinks[denom] = {
        denom,
        totalStaked: sink?.total_staked ?? "0",
        rewardDenoms: sink?.reward_denoms ?? [],
        staked: staker ? stake?.staked ?? "0" : null,
        rewards: staker ? pending?.rewards ?? [] : null,
      };
    }),
  );

  return { configured: true, vault, sinks };
}

/**
 * Live Horn Vault reads. When the vault address is unset (contract not deployed
 * yet) this resolves to an unconfigured state and issues no chain queries, so
 * the page can render its honest preview. Refetches ~15s.
 */
export function useVault(staker: string | null) {
  return useQuery({
    queryKey: VAULT_QUERY_KEY(staker),
    queryFn: () => loadVault(staker),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}
