// CosmWasm transactions + smart queries against the ansem-horn-vault contract.
//
// The vault has two GLOBAL sinks, the native denoms `uansem` (ANSEM) and
// `uchanse` (CHANSE), both 6 decimals. Stakers of either denom earn a cut of
// every graduated pool's swap-fee skim. There is NO APR / reward-rate query, so
// the UI never fabricates one.
//
// Execute schema (exact):
//   Stake {}                              (native funds attached; one sink denom)
//   Unstake { denom, amount: Uint128 }
//   Claim   { denom }
// Query schema (exact):
//   Sink    { denom }  -> { stake_denom, total_staked, reward_denoms }
//   Stake   { denom, staker } -> { staked }
//   Pending { denom, staker } -> { rewards: Coin[] }
//
// Amounts crossing the wire are micro-units (whole * 1e6, floored, as strings).

import type { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { REST_URL } from "@/lib/floorlaunch/config";
import { getHornVaultContract } from "@/lib/floorlaunch/live-config";

export const VAULT_DENOMS = ["uansem", "uchanse"] as const;
export type VaultDenom = (typeof VAULT_DENOMS)[number];
export const VAULT_DECIMALS = 6;

// ── base64 (browser + node safe, UTF-8 correct) ─────────────────────────────
function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  if (typeof btoa === "function") {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  return Buffer.from(bytes).toString("base64");
}

/** whole units -> micro-units string (floored). Guards NaN/negatives to "0". */
export function toMicro(whole: number): string {
  if (!Number.isFinite(whole) || whole <= 0) return "0";
  return String(Math.floor(whole * 10 ** VAULT_DECIMALS));
}

/** micro-units string -> whole-unit number (for display formatting). */
export function fromMicro(micro: string | null | undefined): number {
  const n = Number(micro ?? "0");
  return Number.isFinite(n) ? n / 10 ** VAULT_DECIMALS : 0;
}

// ── smart query (chain REST, base64 msg) ─────────────────────────────────────
export interface Coin {
  denom: string;
  amount: string;
}
export interface SinkInfo {
  stake_denom: string;
  total_staked: string;
  reward_denoms: string[];
}
export interface StakeInfo {
  staked: string;
}
export interface PendingInfo {
  rewards: Coin[];
}

async function smartQuery<T>(contract: string, msg: unknown): Promise<T> {
  const res = await fetch(
    `${REST_URL}/cosmwasm/wasm/v1/contract/${contract}/smart/${toBase64(
      JSON.stringify(msg),
    )}`,
    { headers: { accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`vault smart query -> HTTP ${res.status}`);
  return (await res.json() as { data: T }).data;
}

export async function querySink(vault: string, denom: string): Promise<SinkInfo> {
  return smartQuery<SinkInfo>(vault, { sink: { denom } });
}

export async function queryStake(
  vault: string,
  denom: string,
  staker: string,
): Promise<StakeInfo> {
  return smartQuery<StakeInfo>(vault, { stake: { denom, staker } });
}

export async function queryPending(
  vault: string,
  denom: string,
  staker: string,
): Promise<PendingInfo> {
  return smartQuery<PendingInfo>(vault, { pending: { denom, staker } });
}

// ── execute (signed by the connected wallet) ─────────────────────────────────

/** Stake native coins (exactly one sink denom) into the vault. Auto-harvests
 *  first on-chain. `microAmount` is micro-units. Returns the tx hash. */
export async function stakeVault(
  client: SigningCosmWasmClient,
  sender: string,
  denom: string,
  microAmount: string,
): Promise<string> {
  const vault = await getHornVaultContract();
  if (!vault) throw new Error("Horn Vault is not configured.");
  const res = await client.execute(sender, vault, { stake: {} }, "auto", "", [
    { denom, amount: microAmount },
  ]);
  return res.transactionHash;
}

/** Unstake `microAmount` (micro-units) of `denom` from the vault. */
export async function unstakeVault(
  client: SigningCosmWasmClient,
  sender: string,
  denom: string,
  microAmount: string,
): Promise<string> {
  const vault = await getHornVaultContract();
  if (!vault) throw new Error("Horn Vault is not configured.");
  const res = await client.execute(
    sender,
    vault,
    { unstake: { denom, amount: microAmount } },
    "auto",
  );
  return res.transactionHash;
}

/** Claim all settled rewards for the caller's stake in the `denom` sink. */
export async function claimVault(
  client: SigningCosmWasmClient,
  sender: string,
  denom: string,
): Promise<string> {
  const vault = await getHornVaultContract();
  if (!vault) throw new Error("Horn Vault is not configured.");
  const res = await client.execute(sender, vault, { claim: { denom } }, "auto");
  return res.transactionHash;
}
