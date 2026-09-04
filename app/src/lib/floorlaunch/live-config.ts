// Runtime config-registry resolver.
//
// Launch-day model: only TWO things are baked into the build and both are
// genesis-stable: the config-registry ADDRESS and the REST endpoint. Every
// mutable address (launchpad / amm / oracle / names contracts, the ANSEM SPL
// mint, and optional RPC/REST overrides) is read LIVE from the registry at
// runtime. On a fresh genesis the developer changes nothing: the pinned
// registry (same address) auto-points to the new contracts and this resolver
// picks them up. No rebuild, no code edit.
//
// The registry {config:{}} query returns snake_case fields; empty *_override
// strings mean "use the baked default".

import {
  REST_URL,
  LAUNCHPAD_CONTRACT as ENV_LAUNCHPAD,
  AMM_CONTRACT as ENV_AMM,
  ORACLE_CONTRACT as ENV_ORACLE,
  RPC_URL as ENV_RPC,
  getHornVaultAddress,
} from "./config";

// Registry candidates, tried IN ORDER; the first that answers {config:{}} wins.
// [0] the genesis-proof anchor: deterministic instantiate2 (fixed salt +
//     deployer + config wasm checksum), byte-identical across every regenesis.
//     Live since the 2026-08-31 launch.
// [1] the OLD classic-instantiate registry from the pre-launch testnet. It did
//     NOT survive the launch regenesis (classic addresses are sequence-derived)
//     but is kept as a fallback for any environment still running the old chain.
// An env override, when set, is tried before both.
const REGISTRY_CANDIDATES = [
  process.env.NEXT_PUBLIC_ANSEM_REGISTRY,
  "ansem1uruc2ue7wqvy83yysspe6afrwu02fuz4g0mxffuz3tssljakxu0qt57u4l",
  "ansem1vguuxez2h5ekltfj9gjd62fs5k4rl2zy5hfrncasykzw08rezpfs766uxe",
].filter((a): a is string => Boolean(a));

export interface RegistryConfig {
  version: number;
  ammContract: string;
  launchpadContract: string;
  oracleContract: string;
  namesContract: string;
  vestingCodeId: number;
  solanaBridgeProgramId: string;
  solanaAnsemSplMint: string;
  solanaRpcUrlOverride: string;
  ansemRpcUrlOverride: string;
  ansemRestUrlOverride: string;
  /** Reserved slot for the Horn Vault (ansem-horn-vault). Empty until deployed
   *  and wired into the registry; env stays the primary source meanwhile. */
  hornVaultContract: string;
}

const CACHE_TTL_MS = 60_000;
let cache: { value: RegistryConfig; fetchedAt: number } | null = null;
let inFlight: Promise<RegistryConfig> | null = null;

function b64(s: string): string {
  if (typeof btoa === "function") {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const byte of bytes) bin += String.fromCharCode(byte);
    return btoa(bin);
  }
  return Buffer.from(s, "utf-8").toString("base64");
}

async function fetchRegistry(): Promise<RegistryConfig> {
  const query = b64(JSON.stringify({ config: {} }));
  let lastErr: Error = new Error("no registry candidates");
  for (const contract of REGISTRY_CANDIDATES) {
    const url = `${REST_URL.replace(/\/$/, "")}/cosmwasm/wasm/v1/contract/${contract}/smart/${query}`;
    let json: { data?: Record<string, unknown> };
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`config registry HTTP ${res.status}`);
      json = (await res.json()) as { data?: Record<string, unknown> };
      if (!json.data) throw new Error("config registry response missing data");
    } catch (e) {
      // A dead candidate (regenesis'd-away contract) 500s; fall through.
      lastErr = e instanceof Error ? e : new Error(String(e));
      continue;
    }
    return parseRegistry(json.data);
  }
  throw lastErr;
}

function parseRegistry(d: Record<string, unknown>): RegistryConfig {
  return {
    version: Number(d.version ?? 0),
    ammContract: String(d.amm_contract ?? ""),
    launchpadContract: String(d.launchpad_contract ?? ""),
    oracleContract: String(d.oracle_contract ?? ""),
    namesContract: String(d.names_contract ?? ""),
    vestingCodeId: Number(d.vesting_code_id ?? 0),
    solanaBridgeProgramId: String(d.solana_bridge_program_id ?? ""),
    solanaAnsemSplMint: String(d.solana_ansem_spl_mint ?? ""),
    solanaRpcUrlOverride: String(d.solana_rpc_url_override ?? ""),
    ansemRpcUrlOverride: String(d.ansem_rpc_url_override ?? ""),
    ansemRestUrlOverride: String(d.ansem_rest_url_override ?? ""),
    hornVaultContract: String(d.horn_vault_contract ?? ""),
  };
}

/** Load the registry config, cached ~60s. Throws only if unreachable. */
export async function loadRegistry(): Promise<RegistryConfig> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const value = await fetchRegistry();
      cache = { value, fetchedAt: Date.now() };
      return value;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// A resolved address is valid only if it looks like a bech32 contract address.
function pick(resolved: string, fallback: string): string {
  return resolved && resolved.startsWith("ansem1") ? resolved : fallback;
}

/** Launchpad contract: registry first, baked env as last-resort fallback. */
export async function getLaunchpadContract(): Promise<string> {
  try {
    return pick((await loadRegistry()).launchpadContract, ENV_LAUNCHPAD);
  } catch {
    return ENV_LAUNCHPAD;
  }
}

/** AMM contract (graduated-token trading). */
export async function getAmmContract(): Promise<string> {
  try {
    return pick((await loadRegistry()).ammContract, ENV_AMM);
  } catch {
    return ENV_AMM;
  }
}

/** Oracle contract (base-denom -> USD price). */
export async function getOracleContract(): Promise<string> {
  try {
    return pick((await loadRegistry()).oracleContract, ENV_ORACLE);
  } catch {
    return ENV_ORACLE;
  }
}

// ── runtime Horn Vault discovery ────────────────────────────────────────────
// The Horns stack is LIVE (deployed 2026-08-28). The vault address is set in
// env (NEXT_PUBLIC_HORN_VAULT_ADDRESS), but NEXT_PUBLIC_* values are inlined at
// build time, so a dev server already running when the env was added may not
// carry it. As a robust, env-independent fallback we DISCOVER the vault from the
// live chain: launchpad horn_config -> feeshare address -> feeshare config ->
// vault. This only needs the (genesis-stable) launchpad address, so /vault goes
// live in the running server with no restart.
async function smartQuery<T>(contract: string, msg: unknown): Promise<T> {
  const rest = REST_URL.replace(/\/$/, "");
  const res = await fetch(
    `${rest}/cosmwasm/wasm/v1/contract/${contract}/smart/${b64(JSON.stringify(msg))}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`smart query HTTP ${res.status}`);
  return ((await res.json()) as { data: T }).data;
}

let vaultDiscovery: { value: string | null; fetchedAt: number } | null = null;
async function discoverHornVault(): Promise<string | null> {
  const now = Date.now();
  if (vaultDiscovery && now - vaultDiscovery.fetchedAt < CACHE_TTL_MS) {
    return vaultDiscovery.value;
  }
  let value: string | null = null;
  try {
    const lp = await getLaunchpadContract();
    const cfg = await smartQuery<{ feeshare?: string }>(lp, { horn_config: {} });
    if (cfg.feeshare && cfg.feeshare.startsWith("ansem1")) {
      const fs = await smartQuery<{ vault?: string }>(cfg.feeshare, { config: {} });
      if (fs.vault && fs.vault.startsWith("ansem1")) value = fs.vault;
    }
  } catch {
    value = null;
  }
  vaultDiscovery = { value, fetchedAt: Date.now() };
  return value;
}

/** Horn Vault contract (ansem-horn-vault, native staking). Resolution order:
 *  env (NEXT_PUBLIC_HORN_VAULT_ADDRESS) -> reserved registry slot -> live
 *  on-chain discovery via the launchpad/fee-share horns. Returns null only when
 *  every source fails, so callers can render the honest preview state. */
export async function getHornVaultContract(): Promise<string | null> {
  // LIVE DISCOVERY FIRST. Horn addresses change every regenesis, so a baked env
  // (NEXT_PUBLIC_HORN_VAULT_ADDRESS) or a stale registry slot silently points the
  // stake/claim UI at a dead vault. The launchpad->feeshare->vault chain is the
  // always-current source of truth; env/registry are only fallbacks for when the
  // chain is unreachable.
  const discovered = await discoverHornVault();
  if (discovered && discovered.startsWith("ansem1")) return discovered;
  try {
    const slot = (await loadRegistry()).hornVaultContract;
    if (slot && slot.startsWith("ansem1")) return slot;
  } catch {
    /* fall through to the baked env */
  }
  return getHornVaultAddress();
}

/** REST endpoint: registry override wins, else the baked anchor. The baked
 *  anchor is what reaches the registry in the first place. */
export async function getRestUrl(): Promise<string> {
  try {
    const o = (await loadRegistry()).ansemRestUrlOverride;
    if (o) return o.replace(/\/$/, "");
  } catch {
    /* fall through */
  }
  return REST_URL.replace(/\/$/, "");
}

/** RPC endpoint: registry override wins, else the baked anchor. */
export async function getRpcUrl(): Promise<string> {
  try {
    const o = (await loadRegistry()).ansemRpcUrlOverride;
    if (o) return o.replace(/\/$/, "");
  } catch {
    /* fall through */
  }
  return ENV_RPC.replace(/\/$/, "");
}
