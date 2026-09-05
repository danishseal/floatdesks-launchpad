/**
 * Network presets. ONE address is hardcoded per network, the Registry; every
 * mutable contract resolves from it at runtime (see registry.ts).
 *
 * This is deliberate. The soak on this same deployment spent three days posting
 * prices into the previous deploy's oracle because a script cached addresses in
 * a temp file. Anything that pins a contract address at build time is that bug
 * waiting to happen, so nothing here does.
 *
 * Switching networks is a single value: NEXT_PUBLIC_FLOAT_NETWORK, or the
 * in-app switcher, which writes the same key to localStorage. Individual fields
 * can still be overridden per-env for a fork or a private RPC.
 */

export type VenueKind = "token-launchpad" | "curve-funder";

export interface FloatNetwork {
  key: string;
  label: string;
  chainId: number;
  rpc: string;
  explorer: string;
  /** The only hardcoded contract. Everything else comes from it. */
  registry: `0x${string}`;
  /** Float indexer base URL. */
  indexer: string;
  /** Quote asset display. Decimals are read from the token itself. */
  quoteSymbol: string;
  /**
   * Which launch venue this deployment runs. `token-launchpad` is the merged
   * main-line TokenLaunchpad (curve denominated in an fSHARE). `curve-funder`
   * is the unmerged CurveFunder lane (curve denominated in USDG, separate
   * Graduator). Resolved at runtime from which registry keys exist, with this
   * as the hint; see registry.ts detectVenue().
   */
  venue: VenueKind;
  testnet: boolean;
}

export const NETWORKS: Record<string, FloatNetwork> = {
  "float-testnet": {
    key: "float-testnet",
    label: "Float testnet",
    chainId: 46630,
    rpc: "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    registry: "0xc300f9B7903FaF66dAC973884965652c61AD05Ae",
    indexer: "/api/float",
    quoteSymbol: "USDG",
    venue: "token-launchpad",
    testnet: true,
  },
  /**
   * Robinhood Chain mainnet. This registry belongs to the CurveFunder lane
   * (session 9979f4b4's deployment): its launch venue is CURVE_FUNDER +
   * GRADUATOR rather than TOKEN_LAUNCHPAD, and its curve is quoted in USDG.
   * Reads work; the curve-funder write path is not implemented yet, so the
   * launch form declares itself unavailable rather than building a call that
   * would revert.
   */
  "float-mainnet": {
    key: "float-mainnet",
    label: "Robinhood Chain",
    chainId: 4663,
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://explorer.chain.robinhood.com",
    registry: "0x7134d98596490838FC16e8CA16bC2FDd57aD3202",
    indexer: "/api/float",
    quoteSymbol: "USDG",
    venue: "curve-funder",
    testnet: false,
  },
};

export const DEFAULT_NETWORK = "float-testnet";
const STORAGE_KEY = "float-network";

/**
 * Network handed to the client by the server at runtime.
 *
 * NEXT_PUBLIC_* is inlined into the client bundle at BUILD time while server
 * routes read process.env per request, so starting the dev server with a
 * different NEXT_PUBLIC_FLOAT_NETWORK gave a split brain: the pools API served
 * mainnet while every browser-side contract read went to the testnet RPC baked
 * into the bundle. Reads returned null for contracts that exist, and the UI
 * concluded "this deployment has no metadata contract".
 *
 * So the server is the single source of truth. The client asks once, at boot,
 * and that answer outranks its own build-time value.
 */
let runtimeKey: string | null = null;

export function setRuntimeNetwork(key: string) {
  if (NETWORKS[key]) runtimeKey = key;
}

export function runtimeNetworkKey(): string | null {
  return runtimeKey;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/** Network key from env, overridable in the browser by the switcher. */
export function activeNetworkKey(): string {
  if (typeof window !== "undefined") {
    // An explicit in-app switch wins; then what the server told us; then the
    // bundle's own build-time value.
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && NETWORKS[stored]) return stored;
    } catch {
      /* private mode */
    }
    if (runtimeKey) return runtimeKey;
  }
  const fromEnv = env("NEXT_PUBLIC_FLOAT_NETWORK");
  if (fromEnv && NETWORKS[fromEnv]) return fromEnv;
  return DEFAULT_NETWORK;
}

export function setActiveNetwork(key: string) {
  if (!NETWORKS[key]) throw new Error(`unknown network ${key}`);
  try {
    window.localStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* private mode */
  }
}

/**
 * The active network with per-field env overrides applied. Every field is
 * overridable so a fork, a private RPC or a fresh redeploy needs no code change.
 */
export function activeNetwork(): FloatNetwork {
  const base = NETWORKS[activeNetworkKey()];
  const registry = env("NEXT_PUBLIC_FLOAT_REGISTRY");
  return {
    ...base,
    rpc: env("NEXT_PUBLIC_FLOAT_RPC") ?? base.rpc,
    chainId: Number(env("NEXT_PUBLIC_FLOAT_CHAIN_ID") ?? base.chainId),
    explorer: env("NEXT_PUBLIC_FLOAT_EXPLORER") ?? base.explorer,
    registry: (registry as `0x${string}` | undefined) ?? base.registry,
    indexer: env("NEXT_PUBLIC_FLOAT_INDEXER") ?? base.indexer,
  };
}
