"use client";

// Live, per-token Horn reads against the ansem-1 launchpad + AMM.
//
// What is on-chain (deployed 2026-08-28):
//   Launchpad  { horn_config: {} }        -> { feeshare, skim_bps, ansem_bps }
//   Launchpad  { horn_registry_all: {} }  -> { entries: [{ slug, address, flags }] }
//   AMM        { pool: { token_address } } -> Pool; when a horn is attached the
//              response carries `hook: { address, flags }` (serde skips it while
//              null, which is why pre-hook pools omit it) and MAY carry
//              `horn_skim_bps`. Existing (pre-migration) pools have no hook, so
//              they honestly resolve to "None".
//   Decay horn { config: {} }             -> { launch_time, decay_seconds,
//              start_fee_bps, end_fee_bps, ... } so a REAL current fee can be
//              computed from on-chain params + wall-clock block time.
//
// No datum is ever fabricated: a field the chain does not expose stays null and
// the display layer renders "-" / "None".

import { useQuery } from "@tanstack/react-query";
import { REST_URL } from "@/lib/floorlaunch/config";
import { hornsConfigured } from "@/lib/floorlaunch/config";
import { getAmmContract, getLaunchpadContract } from "@/lib/floorlaunch/live-config";
import { HORNS } from "@/lib/horns-catalog";
import type { TokenListItem } from "@/lib/api";

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

async function smartQuery<T>(contract: string, msg: unknown): Promise<T> {
  const res = await fetch(
    `${REST_URL.replace(/\/$/, "")}/cosmwasm/wasm/v1/contract/${contract}/smart/${toBase64(
      JSON.stringify(msg),
    )}`,
    { headers: { accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`horn smart query -> HTTP ${res.status}`);
  return ((await res.json()) as { data: T }).data;
}

/* ------------------------------------------------------------------ */
/* Launchpad HornConfig                                               */
/* ------------------------------------------------------------------ */

export interface HornConfig {
  /** Fee-Share horn address the skim routes through. */
  feeshare: string;
  /** Default skim to the Vault, basis points (e.g. 2000 = 20%). */
  skimBps: number;
  /** ANSEM sink share of the skim, basis points. */
  ansemBps: number;
  /** CHANSE sink share, basis points (10000 - ansemBps). */
  chanseBps: number;
  /** True when the horn stack addresses are present AND this config resolved. */
  live: boolean;
}

type RawHornConfig = { feeshare: string; skim_bps: number; ansem_bps: number };

async function loadHornConfig(): Promise<HornConfig> {
  const lp = await getLaunchpadContract();
  const c = await smartQuery<RawHornConfig>(lp, { horn_config: {} });
  const ansemBps = Number(c.ansem_bps ?? 0);
  return {
    feeshare: c.feeshare,
    skimBps: Number(c.skim_bps ?? 0),
    ansemBps,
    chanseBps: 10_000 - ansemBps,
    live: hornsConfigured(),
  };
}

/** Launchpad HornConfig, cached ~2min. `live` reflects real config, not a stub. */
export function useHornConfig() {
  return useQuery({
    queryKey: ["horn-config"],
    queryFn: loadHornConfig,
    staleTime: 120_000,
    refetchInterval: 120_000,
  });
}

/* ------------------------------------------------------------------ */
/* Per-token attached horn                                            */
/* ------------------------------------------------------------------ */

export interface AttachedHorn {
  /** Whether a horn hook is attached to this token's graduated pool. */
  attached: boolean;
  /** Registry slug (e.g. "decay", "dynfee", "feeshare"), or null. */
  slug: string | null;
  /** Human name from the horns catalog, or null. */
  name: string | null;
  /** Hook contract address, or null. */
  address: string | null;
  /** Hook flags from the pool/registry, or null. */
  flags: number | null;
  /** Skim to the Vault for this pool, basis points, or null. */
  skimBps: number | null;
  /** ANSEM sink share, basis points, or null. */
  ansemBps: number | null;
  /** CHANSE sink share, basis points, or null. */
  chanseBps: number | null;
}

const NOT_ATTACHED: AttachedHorn = {
  attached: false,
  slug: null,
  name: null,
  address: null,
  flags: null,
  skimBps: null,
  ansemBps: null,
  chanseBps: null,
};

type PoolHook = { address?: string | null; flags?: number | null } | null;
// The AMM PoolResponse exposes `skim_bps` (older builds used `horn_skim_bps`);
// accept either so the read works across a migration.
type RawPool = {
  hook?: PoolHook;
  skim_bps?: number | string | null;
  horn_skim_bps?: number | string | null;
};
type RegistryEntry = { slug: string; address: string; flags: number };
type RawRegistry = { entries: RegistryEntry[] };

function nameForSlug(slug: string): string | null {
  return HORNS.find((h) => h.slug === slug)?.name ?? null;
}

export async function loadTokenHorn(token: TokenListItem): Promise<AttachedHorn> {
  // Only graduated tokens have an AMM pool that can carry a hook.
  if (!token.graduated) return NOT_ATTACHED;

  const amm = await getAmmContract();
  const pool = await smartQuery<RawPool>(amm, {
    pool: { token_address: token.address },
  });

  const hook = pool.hook;
  const hookAddr = hook && hook.address ? hook.address : null;
  if (!hookAddr) return NOT_ATTACHED; // pre-hook pools: honest "None"

  // Config gives the default split + recognizes the Fee-Share address.
  const config = await loadHornConfig();

  // Per-pool skim if the pool exposes it, else the launchpad default.
  const rawSkim = pool.skim_bps ?? pool.horn_skim_bps;
  const poolSkim = rawSkim != null && rawSkim !== "" ? Number(rawSkim) : null;
  const skimBps = poolSkim != null && Number.isFinite(poolSkim) ? poolSkim : config.skimBps;

  // Resolve the hook address to a slug/name.
  let slug: string | null = null;
  let flags: number | null = hook?.flags ?? null;
  if (config.feeshare && hookAddr === config.feeshare) {
    slug = "feeshare";
  } else {
    const registry = await smartQuery<RawRegistry>(await getLaunchpadContract(), {
      horn_registry_all: {},
    });
    const entry = registry.entries.find((e) => e.address === hookAddr);
    if (entry) {
      slug = entry.slug;
      if (flags == null) flags = entry.flags;
    }
  }

  return {
    attached: true,
    slug,
    name: slug ? nameForSlug(slug) : null,
    address: hookAddr,
    flags,
    skimBps,
    ansemBps: config.ansemBps,
    chanseBps: config.chanseBps,
  };
}

/** Per-token attached-horn read, cached a few minutes. Returns `attached:false`
 *  for non-graduated tokens and for graduated pools with no hook. */
export function useTokenHorn(token: TokenListItem) {
  return useQuery({
    queryKey: ["token-horn", token.address, token.graduated],
    queryFn: () => loadTokenHorn(token),
    staleTime: 180_000,
    refetchInterval: 180_000,
  });
}

/* ------------------------------------------------------------------ */
/* Pre-graduation: the creator's selected Horns (from the launchpad curve) */
/* ------------------------------------------------------------------ */

/** The Horns a creator chose at launch, read from the launchpad Curve. Available
 *  before graduation; after graduation the attached hook (useTokenHorn) is the
 *  source of truth. `slugs` are catalog slugs (e.g. ["decay"]). */
export interface CurveHornChoice {
  slugs: string[];
  skimBps: number | null;
  ansemBps: number | null;
}

type RawCurveHorn = {
  horn?: { composite_horns?: string[]; skim_bps?: number; ansem_bps?: number } | null;
};

async function loadCurveHorn(token: TokenListItem): Promise<CurveHornChoice> {
  const empty: CurveHornChoice = { slugs: [], skimBps: null, ansemBps: null };
  if (token.graduated) return empty;
  const lp = await getLaunchpadContract();
  const c = await smartQuery<RawCurveHorn>(lp, { curve: { token_address: token.address } });
  const h = c.horn;
  if (!h) return empty;
  return {
    slugs: Array.isArray(h.composite_horns) ? h.composite_horns : [],
    skimBps: h.skim_bps ?? null,
    ansemBps: h.ansem_bps ?? null,
  };
}

/** The creator's selected Horns for a not-yet-graduated coin. Returns empty
 *  slugs when nothing is selected, the coin has graduated, or the launchpad
 *  build does not yet expose `horn` on the curve query. */
export function useTokenCurveHorn(token: TokenListItem) {
  return useQuery({
    queryKey: ["curve-horn", token.address, token.graduated],
    queryFn: () => loadCurveHorn(token),
    enabled: !token.graduated,
    staleTime: 120_000,
  });
}

/* ------------------------------------------------------------------ */
/* Fee Decay live params (for the Horn tracker)                       */
/* ------------------------------------------------------------------ */

export interface DecayConfig {
  /** Unix seconds the decay window started. */
  launchTime: number;
  /** Window length in seconds. */
  decaySeconds: number;
  /** Fee at launch, basis points. */
  startFeeBps: number;
  /** Fee at/after the window end, basis points. */
  endFeeBps: number;
}

type RawDecayConfig = {
  launch_time: number;
  decay_seconds: number;
  start_fee_bps: number;
  end_fee_bps: number;
};

export async function loadDecayConfig(address: string): Promise<DecayConfig> {
  const c = await smartQuery<RawDecayConfig>(address, { config: {} });
  return {
    launchTime: Number(c.launch_time ?? 0),
    decaySeconds: Number(c.decay_seconds ?? 0),
    startFeeBps: Number(c.start_fee_bps ?? 0),
    endFeeBps: Number(c.end_fee_bps ?? 0),
  };
}

/** Live Fee Decay params, read from the decay horn's own `config`. Enabled only
 *  when a decay hook address is passed (i.e. a pool actually has one attached).
 *  The current fee is computed at the display layer from these + block time. */
export function useDecayConfig(address: string | null | undefined) {
  return useQuery({
    queryKey: ["decay-config", address ?? "none"],
    queryFn: () => loadDecayConfig(address as string),
    enabled: Boolean(address),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

/** Linear decay of the fee (bps) from start to end across the window, matching
 *  the on-chain schedule. `nowSec` is wall-clock seconds. Clamped to the window
 *  ends. Returns basis points. */
export function decayFeeBpsAt(cfg: DecayConfig, nowSec: number): number {
  if (cfg.decaySeconds <= 0) return cfg.endFeeBps;
  const u = Math.min(1, Math.max(0, (nowSec - cfg.launchTime) / cfg.decaySeconds));
  return cfg.startFeeBps + (cfg.endFeeBps - cfg.startFeeBps) * u;
}

/* ------------------------------------------------------------------ */
/* Dynamic Fee live params (for the Horn tracker)                     */
/* ------------------------------------------------------------------ */

export interface DynfeeConfig {
  /** Standard swap fee, basis points. */
  baseFeeBps: number;
  /** Discounted fee for qualifying ANSEM stakers, basis points. */
  discountFeeBps: number;
  /** Minimum ANSEM stake (micro-units) that unlocks the discount. */
  minAnsemStake: string;
}

type RawDynfeeConfig = {
  base_fee_bps: number;
  discount_fee_bps: number;
  min_ansem_stake: string;
};

async function loadDynfeeConfig(address: string): Promise<DynfeeConfig> {
  const c = await smartQuery<RawDynfeeConfig>(address, { config: {} });
  return {
    baseFeeBps: Number(c.base_fee_bps ?? 0),
    discountFeeBps: Number(c.discount_fee_bps ?? 0),
    minAnsemStake: String(c.min_ansem_stake ?? "0"),
  };
}

/** Live Dynamic Fee params, read from the dynfee horn's own `config`. Enabled
 *  only when a dynfee hook address is passed. */
export function useDynfeeConfig(address: string | null | undefined) {
  return useQuery({
    queryKey: ["dynfee-config", address ?? "none"],
    queryFn: () => loadDynfeeConfig(address as string),
    enabled: Boolean(address),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
