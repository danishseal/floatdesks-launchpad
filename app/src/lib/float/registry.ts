/**
 * Registry resolution. Every contract address the app uses comes from here.
 *
 * The keys are ASCII right-padded to bytes32 (cast format-bytes32-string), NOT
 * keccak of the name. Getting that wrong returns the zero address rather than
 * reverting, which is why resolve() treats zero as a hard failure.
 */

import { publicClient } from "./chain";
import { REGISTRY_ABI } from "./abi";
import { activeNetwork, type VenueKind } from "./networks";

export type RegistryKey =
  | "DESK"
  | "LISTINGS"
  | "ORACLE"
  | "FUNDER"
  | "SEATS"
  | "ATTRIBUTION"
  | "BOOSTER"
  | "LAUNCHPAD"
  | "USDG"
  | "FLOAT"
  | "TOKEN_LAUNCHPAD"
  | "STAKE_VAULTS"
  | "BACKSTOP"
  | "RESERVE_BOOK"
  | "FEE_ROUTER"
  | "TREASURY"
  | "CURVE_FUNDER"
  | "GRADUATOR"
  | "V4_POOL_MANAGER"
  | "TOKEN_META"
  | "V4_STATE_VIEW"
  | "UNIVERSAL_ROUTER"
  | "PERMIT2"
  | "DESK_HOOK";

const ZERO = "0x0000000000000000000000000000000000000000";

/** ASCII name right-padded to 32 bytes. */
export function registryKey(name: string): `0x${string}` {
  const hex = Buffer.from(name, "utf8").toString("hex");
  if (hex.length > 64) throw new Error(`registry key too long: ${name}`);
  return `0x${hex.padEnd(64, "0")}`;
}

// Cached per registry address, so switching networks cannot serve a stale map.
const cache = new Map<string, Map<string, string>>();

function bucket(): Map<string, string> {
  const reg = activeNetwork().registry.toLowerCase();
  let b = cache.get(reg);
  if (!b) {
    b = new Map();
    cache.set(reg, b);
  }
  return b;
}

/** Resolve one key. Throws when the registry has no entry. */
export async function resolve(key: RegistryKey): Promise<`0x${string}`> {
  const b = bucket();
  const hit = b.get(key);
  if (hit) return hit as `0x${string}`;

  const net = activeNetwork();
  const addr = (await publicClient().readContract({
    address: net.registry,
    abi: REGISTRY_ABI,
    functionName: "addrs",
    args: [registryKey(key)],
  })) as `0x${string}`;

  if (!addr || addr.toLowerCase() === ZERO) {
    throw new Error(`registry ${net.registry} has no ${key}`);
  }
  b.set(key, addr);
  return addr;
}

/** Resolve a key that may legitimately be absent (venue detection). */
export async function tryResolve(key: RegistryKey): Promise<`0x${string}` | null> {
  try {
    return await resolve(key);
  } catch {
    return null;
  }
}

export async function resolveMany<K extends RegistryKey>(
  keys: readonly K[],
): Promise<Record<K, `0x${string}`>> {
  const out = {} as Record<K, `0x${string}`>;
  await Promise.all(keys.map(async (k) => { out[k] = await resolve(k); }));
  return out;
}

/**
 * Which launch venue this deployment runs, decided by what the registry
 * actually holds rather than by the preset's guess. A deployment that has
 * TOKEN_LAUNCHPAD runs the fSHARE-denominated curve; one that has CURVE_FUNDER
 * runs the USDG-denominated one with a separate Graduator.
 */
let venueCache: { registry: string; venue: VenueKind | null } | null = null;

export async function detectVenue(): Promise<VenueKind | null> {
  const reg = activeNetwork().registry.toLowerCase();
  if (venueCache && venueCache.registry === reg) return venueCache.venue;

  const [tokenPad, curveFunder] = await Promise.all([
    tryResolve("TOKEN_LAUNCHPAD"),
    tryResolve("CURVE_FUNDER"),
  ]);
  // A deployment can hold BOTH keys (the mainnet registry does), so presence
  // alone does not decide it. When both resolve, the preset's declared venue
  // wins; presence only decides when exactly one exists.
  const declared = activeNetwork().venue;
  const venue: VenueKind | null =
    tokenPad && curveFunder ? declared
    : tokenPad ? "token-launchpad"
    : curveFunder ? "curve-funder"
    : null;
  venueCache = { registry: reg, venue };
  return venue;
}

/** Drop every cached address. Called by the network switcher. */
export function clearRegistryCache() {
  cache.clear();
  venueCache = null;
}
