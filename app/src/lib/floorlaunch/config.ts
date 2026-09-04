/**
 * Compatibility shim.
 *
 * This file used to hold the ansem-1 chain config (bech32 contracts, uchanse,
 * rpc.ansemchain.fun). Everything real now lives in lib/float/*, where the only
 * hardcoded address is the Registry. A handful of components still import from
 * this path, so the names they use are re-derived from the Float network here
 * rather than left pointing at a dead chain.
 */

import { activeNetwork } from "@/lib/float/networks";

export const RPC_URL = activeNetwork().rpc;
export const EXPLORER_URL = activeNetwork().explorer;
export const INDEXER_HTTP = "/api/float";

/**
 * Launched tokens mint their full 1B supply onto the curve (TokenLaunchpad
 * mints SUPPLY at launch), so market-cap math uses that, not the 100k of the
 * ansem launchpad this replaced.
 */
export const TOKEN_SUPPLY = 1_000_000_000;
export const TOKEN_DECIMALS = 18;

/**
 * Call sites use both `explorerUrl(hash)` and `explorerUrl("address", addr)`,
 * so accept either. With one argument the kind is inferred from length: 66
 * chars is a 32-byte tx hash, anything shorter is an address.
 */
export function explorerUrl(kindOrValue: string, maybeValue?: string): string {
  const base = activeNetwork().explorer;
  if (maybeValue !== undefined) {
    const kind = kindOrValue === "address" ? "address" : "tx";
    return `${base}/${kind}/${maybeValue}`;
  }
  return kindOrValue.length > 42
    ? `${base}/tx/${kindOrValue}`
    : `${base}/address/${kindOrValue}`;
}

/** Kept for call sites that had a second explorer; same target now. */
export const solscanUrl = explorerUrl;

/**
 * There is no AMM or launchpad contract to hardcode any more: both resolve from
 * the Registry. These stay as empty strings so the few UI spots that render a
 * link fall back to their "not available" branch instead of linking to a dead
 * ansem-1 address.
 */
export const AMM_CONTRACT = "";
export const LAUNCHPAD_CONTRACT = "";
