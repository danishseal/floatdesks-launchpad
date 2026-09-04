// Config for the ANSEM launchpad, repointed from the old Solana/floorlaunch
// backend to the ansem-1 CosmWasm stack (indexer + launchpad + AMM). The export
// names are kept so existing imports across the app keep resolving.

// ── ansem-1 chain ──────────────────────────────────────────────────────────
export const CHAIN_ID = process.env.NEXT_PUBLIC_CHAIN_ID ?? "ansem-1";
export const RPC_URL =
  process.env.NEXT_PUBLIC_ANSEM_RPC ?? "https://rpc.ansemchain.fun";
export const REST_URL =
  process.env.NEXT_PUBLIC_ANSEM_REST ?? "https://rest.ansemchain.fun";
export const DENOM = process.env.NEXT_PUBLIC_ANSEM_DENOM ?? "uchanse";
export const DENOM_DECIMALS = 6;

// Native base denoms a launch can use. The four `*x` denoms are tokenized-stock
// (RWA) denominations registered on the chain: a curve denominated in one of
// them prices/graduates against that stock's oracle (see STOCK_DENOMS below).
export const BASE_DENOMS = {
  chanse: "uchanse",
  ansem: "uansem",
  nvdax: "unvdax",
  tslax: "utslax",
  aaplx: "uaaplx",
  spyx: "uspyx",
} as const;
export type BaseDenom = (typeof BASE_DENOMS)[keyof typeof BASE_DENOMS];
export type BaseDenomKey = keyof typeof BASE_DENOMS;

// utoken denom -> display ticker. Stock denoms render as their ticker; every
// other denom falls back to CHANSE.
const DENOM_LABELS: Record<string, string> = {
  uchanse: "CHANSE",
  uansem: "ANSEM",
  unvdax: "NVDA",
  utslax: "TSLA",
  uaaplx: "AAPL",
  uspyx: "SPY",
};
export function denomLabel(denom: string): string {
  return DENOM_LABELS[denom] ?? "CHANSE";
}

// Tokenized-stock (RWA) launch denominations. Selecting one denominates the
// bonding curve in that stock; graduation is oracle-derived (the launchpad
// resolves the per-denom oracle itself), so no manual graduation target is
// needed. Logos are clean ticker badges under public/stocks (not the companies'
// trademarked artwork). `key` matches the BASE_DENOMS key.
export type StockDenomKey = "nvdax" | "tslax" | "aaplx" | "spyx";
export interface StockDenom {
  key: StockDenomKey;
  denom: string;
  ticker: string;
  name: string;
  color: string;
  logo: string;
}
export const STOCK_DENOMS: StockDenom[] = [
  { key: "nvdax", denom: BASE_DENOMS.nvdax, ticker: "NVDA", name: "Nvidia", color: "#76b900", logo: "/stocks/nvda.png" },
  { key: "tslax", denom: BASE_DENOMS.tslax, ticker: "TSLA", name: "Tesla", color: "#e31937", logo: "/stocks/tsla.png" },
  { key: "aaplx", denom: BASE_DENOMS.aaplx, ticker: "AAPL", name: "Apple", color: "#a3aab2", logo: "/stocks/aapl.png" },
  { key: "spyx", denom: BASE_DENOMS.spyx, ticker: "SPY", name: "S&P 500 ETF", color: "#4b8dff", logo: "/stocks/spy.png" },
];
export function isStockDenomKey(k: string): k is StockDenomKey {
  return STOCK_DENOMS.some((s) => s.key === k);
}

// ── mutable contract addresses ──────────────────────────────────────────────
// These are now resolved LIVE from the config registry at runtime (see
// live-config.ts: getLaunchpadContract / getAmmContract / getOracleContract).
// The consts below are ONLY the last-resort fallback used when the registry is
// unreachable. Launch model: the only two baked anchors are the config-registry
// ADDRESS (NEXT_PUBLIC_ANSEM_REGISTRY, in live-config.ts) and the REST endpoint
// (NEXT_PUBLIC_ANSEM_REST) - both genesis-stable. On a fresh genesis nothing
// here changes; the pinned registry auto-points to the new contracts.
export const LAUNCHPAD_CONTRACT =
  process.env.NEXT_PUBLIC_LAUNCHPAD_CONTRACT ??
  "ansem1gjg0m75mnav5xftgwjxded5v0shlsj3vk8uh4adk9k7a33034wmsp7xq4c";

// The AMM a token graduates to. Once a token's curve fills it can no longer be
// traded on the launchpad; buys/sells route to this AMM's Swap instead.
export const AMM_CONTRACT =
  process.env.NEXT_PUBLIC_ANSEM_AMM ??
  "ansem14wzrxt6u557ecr98w2z22ygnu77w34uqfel72k8t8xatneajy2xqkn4m6e";

// ── indexer (our ansemchain-indexer on val1) ───────────────────────────────
export const INDEXER_HTTP = (
  process.env.NEXT_PUBLIC_ANSEM_API_URL ?? "https://api.ansemchain.fun/api"
).replace(/\/+$/, "");
// SSE stream (not a WebSocket): the indexer serves /api/sse/feed.
export const INDEXER_SSE = `${INDEXER_HTTP}/sse/feed`;
// Kept for import compatibility; the app now uses SSE, not a WS.
export const INDEXER_WS = INDEXER_SSE;

// ── launch economics ───────────────────────────────────────────────────────
// The platform creation fee is charged on-chain (in the create_token funds),
// always in CHANSE. This is the display value; the exact utoken amount comes
// from the launchpad Config query at submit time.
export const CREATION_FEE_CHANSE = 80_000; // 80,000 CHANSE
export const TOKEN_DECIMALS = 6;
// Total supply per token, in WHOLE tokens. Must match the launchpad contract's
// TOTAL_SUPPLY (100_000_000_000 utokens = 100,000 tokens). Market cap = price
// per token x this. (Was 1e9 by mistake, which inflated every market cap 10000x.)
export const TOKEN_SUPPLY = 100_000;

// ── oracle (CHANSE/USD) ─────────────────────────────────────────────────────
// The ansem-oracle contract holds the base-denom -> USD price the launchpad
// itself uses for all curve math. query {"price":{}} -> ansem_usd_price is
// micro-USD per CHANSE (e.g. 100 = $0.0001). Everything denominated in USD on
// the UI resolves the rate from here, per the "hit the oracle, do the math"
// model. NOTE: this rate is the base-asset/USD rate the contract applies to
// BOTH CHANSE and ANSEM curves; a distinct ANSEM(SPL)/USD feed does not exist
// yet, so ANSEM-denominated tokens use the same rate as a documented fallback.
export const ORACLE_CONTRACT =
  process.env.NEXT_PUBLIC_ANSEM_ORACLE ??
  "ansem1d2wr6ej95xepd3wmmpgrkyxwjns6gt5tfscrr3jcuetz7m7z0req0u7slp";

// ── Horn Vault (ansem-horn-vault) ───────────────────────────────────────────
// The staking vault contract. NOT yet deployed, so its address is supplied via
// env at build/runtime (NEXT_PUBLIC_HORN_VAULT_ADDRESS) and is the PRIMARY
// source. When unset (or malformed) this returns null and the vault page falls
// back to its honest preview state instead of showing live data. Once the
// contract deploys, a reserved registry slot can back it too (see
// getHornVaultContract in live-config.ts), but env wins until then.
export function getHornVaultAddress(): string | null {
  const addr = (process.env.NEXT_PUBLIC_HORN_VAULT_ADDRESS ?? "").trim();
  return addr.startsWith("ansem1") ? addr : null;
}

// ── Horn contracts, live on ansem-1 (deployed 2026-08-28) ───────────────────
// The three horn contracts that back the graduation hooks + skim routing:
//   Fee-Share  routes each pool's swap-fee skim into the Vault's two sinks
//   Fee Decay  launch fee starts high and decays down (registry slug "decay")
//   Dynamic Fee adjusts the swap fee to conditions (registry slug "dynfee")
// These are env-supplied so a regenesis can repoint them without a rebuild.
// A pool's attached hook is resolved by address against these + the launchpad
// horn_registry_all, so the UI can name the horn on a graduated pool.
function envAnsemAddr(raw: string | undefined): string | null {
  const addr = (raw ?? "").trim();
  return addr.startsWith("ansem1") ? addr : null;
}
export function getHornFeeShareAddress(): string | null {
  return envAnsemAddr(process.env.NEXT_PUBLIC_HORN_FEESHARE_ADDRESS);
}
export function getHornDecayAddress(): string | null {
  return envAnsemAddr(process.env.NEXT_PUBLIC_HORN_DECAY_ADDRESS);
}
export function getHornDynfeeAddress(): string | null {
  return envAnsemAddr(process.env.NEXT_PUBLIC_HORN_DYNFEE_ADDRESS);
}
/** True once the horn stack's addresses are present in the build. Combined with
 *  a resolving launchpad HornConfig, this is what flips the Horns surfaces from
 *  "preview" to "live". */
export function hornsConfigured(): boolean {
  return Boolean(getHornVaultAddress() && getHornFeeShareAddress());
}

export const IS_LOCALNET =
  RPC_URL.includes("127.0.0.1") || RPC_URL.includes("localhost");
export const IS_DEVNET = false;

// Tokens hidden from every listing + search FOR NOW, a pre-launch cleanup so
// the rehearsal/test tokens don't show. Detail pages (/token/<addr>) still
// resolve, so these stay reachable by direct link for testing. To show
// everything again at launch, empty this set.
export const HIDDEN_TOKEN_ADDRESSES = new Set<string>([
  "ansem1v0840lt6kv2khlgk2hgm230j4f6vmtf4e8lhszcxazfusshx6j7qufe304",
  "ansem1qvar9rwypdgyhyycmfee0zslpp489szn25wl2k5f2erxvy75mwds36e08k",
  "ansem1kc749lkcm6v7euwrqr2c9cwf208tqwu0mqetp6s4te4chr6ysj4qtetyq3",
  "ansem12dwgxsmhx5wwx7ywtqj2s72cjylwr46mqdjsm7e092w44m9mue7q60juz8",
  "ansem12cks8zuclf9339tnanpdd8z8ycf5ygdgy885sejc7kyhvryzfyzs50tgkh",
  "ansem1dmd65eend0mjvnmswzxq7ugpyukyfk40ylr6fm2hdhv3lema0yjsxgn4c6",
  "ansem10dl9tnsfpldlzktvw3xtsn436ntnynkg3xa420hx7pkd2mtz37pq8cxvh0",
  "ansem1lnx4r7styl209e9lfce8tdd7hyclq98upx25ax3t2qkmcl3jlgvsppdzc2",
  "ansem18nwjauhgpmfsjf8c4yea0mfj74n6dhy0wkqzydtvvhkmr7gqzxtsawgz5r",
  "ansem1enrur4t6kyyfgmh84e88muzej4m3zcvje999trctck0e7zr7ktjqvxeytp",
  "ansem1nkxfnchghtwx73p9fe9keepaerpykagydq00etp09qxk8n048mcs8my62h",
  "ansem167xst2jy9n6u92t3n8hf762adtpe3cs6acsgn0w5n2xlz9hv3xgsrf6yzu",
]);

export const EXPLORER_BASE =
  process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://explorer.ansemchain.fun";
export function explorerUrl(kind: "address" | "tx", value: string): string {
  return `${EXPLORER_BASE}/${kind === "tx" ? "tx" : "account"}/${value}`;
}
export function solscanUrl(kind: "account" | "token" | "tx", value: string): string {
  return explorerUrl(kind === "tx" ? "tx" : "address", value);
}
