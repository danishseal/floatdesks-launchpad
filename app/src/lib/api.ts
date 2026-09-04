// Data layer, repointed from the Solana/floorlaunch backend to the ansem-1
// CosmWasm stack: reads come from our ansemchain-indexer (HTTP + SSE) and the
// launchpad contract's REST smart queries. Exported names + type shapes are
// preserved so the UI components keep compiling; collectible-only fields are
// filled with neutral defaults (this is a plain bonding-curve launchpad).

import {
  INDEXER_HTTP,
  INDEXER_SSE,
  REST_URL,
  denomLabel,
  HIDDEN_TOKEN_ADDRESSES,
} from "@/lib/floorlaunch/config";
import {
  getAmmContract,
  getLaunchpadContract,
  getOracleContract,
} from "@/lib/floorlaunch/live-config";

// ── oracle: base-denom -> USD ───────────────────────────────────────────────
// Everything shown in USD resolves the rate from the ansem-oracle contract:
// query {"price":{}} -> ansem_usd_price is micro-USD per CHANSE (100 = $0.0001).
// Cached briefly so the token list / detail don't hammer REST.
let oracleUsdCache: { rate: number; at: number } | null = null;
export async function fetchBaseUsd(): Promise<number> {
  const now = Date.now();
  if (oracleUsdCache && now - oracleUsdCache.at < 30_000) return oracleUsdCache.rate;
  try {
    const d = await smartQuery<{ ansem_usd_price: string }>((await getOracleContract()), {
      price: {},
    });
    const rate = Number(d.ansem_usd_price) / 1e6; // micro-USD -> USD per 1 CHANSE
    oracleUsdCache = { rate: Number.isFinite(rate) ? rate : 0, at: now };
    return oracleUsdCache.rate;
  } catch {
    return oracleUsdCache?.rate ?? 0;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${INDEXER_HTTP}${path}`, {
    cache: "no-store",
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** CosmWasm smart query via the chain REST endpoint (base64 msg). */
async function smartQuery<T>(contract: string, msg: unknown): Promise<T> {
  const b64 =
    typeof btoa === "function"
      ? btoa(JSON.stringify(msg))
      : Buffer.from(JSON.stringify(msg)).toString("base64");
  const res = await fetch(
    `${REST_URL}/cosmwasm/wasm/v1/contract/${contract}/smart/${b64}`,
    { headers: { accept: "application/json" }, cache: "no-store" },
  );
  if (!res.ok) throw new Error(`smart query -> HTTP ${res.status}`);
  const json = (await res.json()) as { data: T };
  return json.data;
}

// ── indexer token record ────────────────────────────────────────────────────
interface IndexerToken {
  address: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  description: string | null;
  social_links: string[] | null;
  creator: string | null;
  source: string;
  graduated: boolean;
  ansem_reserves: string;
  current_price: string; // base-denom per token, scaled 1e6
  base_denom: string; // "uchanse" | "uansem"
  created_at: string | null;
  first_seen_at: string;
  volume_24h: string;
  trade_count_24h: number;
}

// ── preserved view-model types (collectible fields kept, neutral-defaulted) ──
export interface MarketInfo {
  market: string;
  solUsd: number;
  collection: string;
  synthMint: string;
  status: string;
  venue: string;
  frozen: boolean;
  indexPerToken: number;
  markPerToken: number;
  cardIndexSol: number;
  unitsPerItem: number;
  indexLastTs: number;
  feedAgeSec: number | null;
  ammSolReserve: number;
  ammTokenReserve: number;
  insuranceSol: number;
  totalCollateralSol: number;
  curveSolRaised: number;
  curveVirtualSol: number;
  curveVirtualTokens: number;
  graduationTargetSol: number;
  fundingIndex: string;
  maxOpenInterest: number;
  itemsDeposited: number;
  dbcPool?: string;
  volume24hSol?: number;
  volumeTotalSol?: number;
  creatorFeesTotalSol?: number;
}

export interface ListingMeta {
  ticker: string;
  name: string;
  image: string | null;
  links: Record<string, string | undefined>;
  feeReceiver: { kind: string; value: string; escrow?: string };
  identifier: string;
  itemMints?: string[];
  launchedBy?: string;
  launchedAt?: number;
  indexAtLaunchLamports?: number;
}

export interface TokenListItem {
  address: string;
  mint: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  description: string | null;
  social_links: string[] | null;
  creator: string | null;
  source: string;
  graduated: boolean;
  created_at: string | null;
  first_seen_at: string;
  current_price: string;
  hodl_reserves: string;
  volume_24h: string;
  volume_total: string;
  creator_fees_total: string;
  trade_count_24h: number;
  price_change_24h: number | null;
  /** ansem-1: native base denom this token trades in ("uchanse" | "uansem"). */
  base_denom: string;
  /** ansem-1: "CHANSE" | "ANSEM" display label. */
  base_label: string;
  market: MarketInfo;
  listing: ListingMeta;
}

export interface BackendCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}
export interface BackendTrade {
  ts: number;
  side: "buy" | "sell";
  priceSol: number;
  solAmount: number;
  tokenAmount: number;
  phase: "curve" | "amm";
  sig: string;
  user: string;
}
export interface IndexTick {
  ts: number;
  value: number;
}
export interface FundingTick {
  ts: number;
  rateBpsPerDay: number;
  mark: number;
  index: number;
}
export interface AggregatorRow {
  market: string;
  ticker: string;
  name: string;
  image: string | null;
  priceUsd: number;
  change24h: number | null;
}

// Neutral MarketInfo for a plain bonding-curve token (no collectible venue).
// `solUsd` here is the base-denom -> USD rate from the oracle (name kept for the
// preserved shape; it is CHANSE/USD, or the same rate for ANSEM curves).
function stubMarket(t: IndexerToken, solUsd: number): MarketInfo {
  const reserves = Number(t.ansem_reserves) / 1e6;
  return {
    market: t.address,
    solUsd,
    collection: "",
    synthMint: t.address,
    status: t.graduated ? "live" : "bootstrap",
    venue: t.graduated ? "amm" : "curve",
    frozen: false,
    indexPerToken: 0,
    markPerToken: Number(t.current_price) / 1e6,
    cardIndexSol: 0,
    unitsPerItem: 0,
    indexLastTs: 0,
    feedAgeSec: null,
    // Liquidity = the reserves backing the token, whether that's the AMM pool
    // (graduated) or the bonding curve (on-curve). Gating this to graduated-only
    // left every on-curve token showing $0 liquidity.
    ammSolReserve: reserves,
    ammTokenReserve: 0,
    insuranceSol: 0,
    totalCollateralSol: 0,
    curveSolRaised: reserves,
    curveVirtualSol: 0,
    curveVirtualTokens: 0,
    graduationTargetSol: 0,
    fundingIndex: "0",
    maxOpenInterest: 0,
    itemsDeposited: 0,
    volume24hSol: Number(t.volume_24h) / 1e6,
  };
}

function stubListing(t: IndexerToken): ListingMeta {
  return {
    ticker: t.symbol ?? "",
    name: t.name ?? "",
    image: t.image,
    links: {},
    feeReceiver: { kind: "wallet", value: t.creator ?? "" },
    identifier: t.address,
    launchedBy: t.creator ?? undefined,
    launchedAt: t.created_at ? Date.parse(t.created_at) / 1000 : undefined,
  };
}

function toToken(t: IndexerToken, solUsd: number): TokenListItem {
  return {
    address: t.address,
    mint: t.address,
    name: t.name,
    symbol: t.symbol,
    image: t.image,
    description: t.description,
    social_links: t.social_links ?? null,
    creator: t.creator,
    source: t.source,
    graduated: t.graduated,
    created_at: t.created_at,
    first_seen_at: t.first_seen_at,
    current_price: t.current_price,
    hodl_reserves: t.ansem_reserves,
    volume_24h: t.volume_24h,
    volume_total: "0",
    creator_fees_total: "0",
    trade_count_24h: t.trade_count_24h,
    price_change_24h: null,
    base_denom: t.base_denom ?? "uchanse",
    base_label: denomLabel(t.base_denom ?? "uchanse"),
    market: stubMarket(t, solUsd),
    listing: stubListing(t),
  };
}

// Live AMM pools keyed by token address, from ONE all_pools query. Graduated
// tokens price off the pool, not the indexer's current_price (which can lag or
// hold a curve-phase value), so overlaying this keeps lists in step with the
// token page. Best-effort: an unreachable AMM just leaves the indexer values.
async function fetchAmmPoolMap(): Promise<
  Map<string, { price: string; ansem_reserve: string }>
> {
  const m = new Map<string, { price: string; ansem_reserve: string }>();
  try {
    const amm = await getAmmContract();
    const res = await smartQuery<{
      pools: Array<{ token_address: string; price: string; ansem_reserve: string }>;
    }>(amm, { all_pools: {} });
    for (const p of res.pools ?? []) m.set(p.token_address, p);
  } catch {
    /* leave empty -> indexer values stand */
  }
  return m;
}

// ── token data ──────────────────────────────────────────────────────────────
export async function fetchTokens(): Promise<TokenListItem[]> {
  const [{ tokens }, solUsd] = await Promise.all([
    request<{ tokens: IndexerToken[] }>("/tokens"),
    fetchBaseUsd(),
  ]);
  // Drop tokens hidden for now (pre-launch test-token cleanup). Applied here so
  // every listing/search that reads fetchTokens is filtered; detail pages use
  // fetchToken and remain reachable by direct link.
  const visible = tokens.filter(
    (t) => process.env.NEXT_PUBLIC_SHOW_HIDDEN === "1" || !HIDDEN_TOKEN_ADDRESSES.has(t.address),
  );
  // Overlay the live AMM pool for graduated tokens so list cards show the real
  // price/MC (matching the token page), not a stale indexer figure.
  const pools = visible.some((t) => t.graduated) ? await fetchAmmPoolMap() : null;
  if (pools) {
    for (const t of visible) {
      if (!t.graduated) continue;
      const p = pools.get(t.address);
      if (!p) continue;
      const price = Number(p.price); // CHANSE per whole token
      if (Number.isFinite(price) && price > 0) t.current_price = String(Math.round(price * 1e6));
      if (p.ansem_reserve && Number(p.ansem_reserve) > 0) t.ansem_reserves = p.ansem_reserve;
    }
  }
  return visible.map((t) => toToken(t, solUsd));
}

// ── real 24h price change (computed from candles) ───────────────────────────
// The indexer's /tokens payload carries no 24h-open / prev-price field (only
// current_price, volume_24h, trade_count_24h), so `price_change_24h` cannot be
// mapped directly and must be derived from the candle history.
//
// Method: pull hourly candles spanning >24h, take the latest close as "now",
// and the reference price as of 24h ago. Because candle buckets are sparse
// (only buckets that had trades exist), the reference is the close of the last
// candle at-or-before the 24h cutoff; if the token first traded inside the last
// 24h there is no such candle, so we fall back to the OPEN of the earliest
// candle in the window (its first real traded price). Both inputs are real
// on-chain prices. If we cannot derive two positive prices, we return null so
// the UI shows "-" rather than a fabricated 0.
const CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function fetchTokenChange24h(
  tokenAddress: string,
): Promise<number | null> {
  try {
    const { candles } = await fetchCandles(tokenAddress, "1h", 48);
    if (!candles || candles.length === 0) return null;
    const sorted = [...candles].sort(
      (a, b) => Date.parse(a.time) - Date.parse(b.time),
    );
    const cutoff = Date.now() - CHANGE_WINDOW_MS;
    // Reference = the last known close at or before the 24h cutoff.
    let ref: number | null = null;
    for (const c of sorted) {
      if (Date.parse(c.time) <= cutoff) ref = Number(c.close);
    }
    // Nothing before the cutoff -> token first traded inside the window; use the
    // earliest candle's opening price as the honest baseline.
    if (ref == null) ref = Number(sorted[0].open);
    const latest = Number(sorted[sorted.length - 1].close);
    if (
      !Number.isFinite(ref) ||
      !Number.isFinite(latest) ||
      ref <= 0 ||
      latest <= 0
    ) {
      return null;
    }
    return ((latest - ref) / ref) * 100;
  } catch {
    return null;
  }
}

/**
 * Batch-compute 24h change for a set of token addresses, in parallel. Each
 * address maps to a percentage or null (no derivable history). Intended to be
 * called with only the addresses that actually traded in the last 24h, so we
 * never fire a candle request for dead listings.
 */
export async function fetchTokenChanges(
  addresses: string[],
): Promise<Record<string, number | null>> {
  const entries = await Promise.all(
    addresses.map(
      async (address) => [address, await fetchTokenChange24h(address)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

// The launchpad's real graduation threshold (uchanse micro-units). One cached
// read powers every feed progress bar so it shows true curve fill toward the
// AMM, not the unpopulated per-token target. Chain-agnostic: reads live config,
// so it's correct on localnet and mainnet without a hardcoded number.
let gradThresholdCache: number | null = null;
export async function fetchGraduationThreshold(): Promise<number> {
  if (gradThresholdCache != null) return gradThresholdCache;
  try {
    const launchpad = await getLaunchpadContract();
    const cfg = await smartQuery<{ graduation_threshold: string }>(launchpad, {
      config: {},
    });
    const v = Number(cfg.graduation_threshold);
    gradThresholdCache = Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    gradThresholdCache = 0;
  }
  return gradThresholdCache;
}

export async function fetchToken(address: string): Promise<TokenListItem> {
  const [t, solUsd] = await Promise.all([
    request<IndexerToken>(`/tokens/${address}`),
    fetchBaseUsd(),
  ]);
  // The indexer's current_price / ansem_reserves only update once a trade is
  // indexed, so a freshly launched (still-on-curve) token read $0 price / MC /
  // liquidity. For an on-curve token, overlay the LIVE curve state from the
  // launchpad contract, which has the correct marginal price and reserves from
  // block one, so the header shows the real starting MC (~$10k) immediately.
  let poolValueBase: number | null = null;
  if (!t.graduated) {
    try {
      const curve = await smartQuery<{
        current_price: string;
        ansem_reserves: string;
        tokens_remaining: string;
      }>((await getLaunchpadContract()), { curve: { token_address: address } });
      const cp = Number(curve.current_price); // CHANSE per whole token
      // Curve current_price is per whole token; the indexer field is uchanse
      // per token (scaled 1e6), so multiply to match the frontend's math.
      if (Number.isFinite(cp) && cp > 0) t.current_price = String(Math.round(cp * 1e6));
      if (curve.ansem_reserves && Number(curve.ansem_reserves) > 0) {
        t.ansem_reserves = curve.ansem_reserves;
      }
      // Liquidity = the WHOLE pool: the CHANSE reserves PLUS the unsold tokens
      // valued at the current price (expressed in base-denom / CHANSE). A
      // bonding-curve pool holds both sides, so counting only the CHANSE side
      // under-reported it (showed ~$9 when the pool held thousands in tokens).
      const reservesBase = Number(curve.ansem_reserves) / 1e6;
      const tokensRemaining = Number(curve.tokens_remaining) / 1e6;
      if (Number.isFinite(reservesBase) && Number.isFinite(tokensRemaining) && cp > 0) {
        poolValueBase = reservesBase + tokensRemaining * cp;
      }
    } catch {
      /* fall back to the indexer values */
    }
  } else {
    // Graduated: the curve is spent and the real price + liquidity now live in
    // the AMM pool. The indexer's current_price / ansem_reserves can lag or read
    // a pre-migration value, so overlay the LIVE pool: use the AMM spot price
    // (CHANSE per whole token) and value the WHOLE pool (both sides) for
    // liquidity, so a graduated token shows its real MC and TVL, not a stale $.
    try {
      const pool = await smartQuery<{
        ansem_reserve: string;
        token_reserve: string;
        price: string;
      }>(await getAmmContract(), { pool: { token_address: address } });
      const ammPrice = Number(pool.price); // CHANSE per whole token
      if (Number.isFinite(ammPrice) && ammPrice > 0) {
        t.current_price = String(Math.round(ammPrice * 1e6));
      }
      const ansemBase = Number(pool.ansem_reserve) / 1e6;
      const tokenBase = Number(pool.token_reserve) / 1e6;
      if (Number.isFinite(ansemBase) && ansemBase > 0) {
        t.ansem_reserves = pool.ansem_reserve;
        if (Number.isFinite(tokenBase) && ammPrice > 0) {
          poolValueBase = ansemBase + tokenBase * ammPrice;
        }
      }
    } catch {
      /* fall back to the indexer values */
    }
  }
  const token = toToken(t, solUsd);
  // `ammSolReserve` feeds the header's Liquidity (x solUsd -> USD). For an
  // on-curve token, report the full pool value (both sides) computed above.
  if (poolValueBase != null) token.market.ammSolReserve = poolValueBase;
  return token;
}

// Legacy collectible aggregators: no equivalent on a plain launchpad.
export const fetchMarkets = async (): Promise<MarketInfo[]> =>
  (await fetchTokens()).map((t) => t.market);
export const fetchAggregator = async (): Promise<AggregatorRow[]> => [];

// ── candles ─────────────────────────────────────────────────────────────────
export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "12h" | "1d";
// The indexer now buckets all of these natively (1m|5m|15m|1h|4h|12h|1d).
const TF_TO_INDEXER: Record<Timeframe, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "12h": "12h",
  "1d": "1d",
};

export interface CandleResponse {
  token_address: string;
  timeframe: Timeframe;
  candles: Array<{
    time: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    trade_count: number;
  }>;
}

export async function fetchCandles(
  tokenAddress: string,
  timeframe: Timeframe,
  limit = 300,
): Promise<CandleResponse> {
  // Our /candles already returns { token_address, timeframe, candles:[{time(ISO),
  // open/high/low/close/volume(strings), trade_count}] } pass through.
  const data = await request<CandleResponse>(
    `/candles/${tokenAddress}?timeframe=${TF_TO_INDEXER[timeframe]}&limit=${limit}`,
  );
  return { ...data, timeframe };
}

// ── trades ──────────────────────────────────────────────────────────────────
interface IndexerTrade {
  time: string;
  tx_hash: string;
  source: string;
  action: string;
  direction: string;
  token_address: string;
  price_uchanse: string;
  volume_uchanse: string;
  volume_token: string;
  fee_uchanse: string;
  trader: string;
  token_name?: string | null;
  token_symbol?: string | null;
}

export interface TokenTrade {
  time: string;
  tx_hash: string;
  action: "buy" | "sell";
  trader: string;
  hodl_amount: string;
  token_amount: string;
  fee: string;
  phase: "curve" | "amm";
  price_sol: number;
}

export const TOKEN_TRADES_QUERY_KEY = (address: string) =>
  ["trades", "token", address] as const;

/**
 * Buy vs sell for display. Curve trades carry action "buy"/"sell" directly;
 * graduated pools emit action "swap" with a direction (ansem_to_token = buy,
 * token_to_ansem = sell). Collapsing everything-not-"sell" to "buy" mislabeled
 * every AMM sell as a buy, so derive the side from BOTH fields.
 */
export function tradeSide(action: string, direction: string): "buy" | "sell" {
  if (action === "sell") return "sell";
  if (action === "swap") return direction === "token_to_ansem" ? "sell" : "buy";
  return "buy"; // buy, buy_and_graduate
}

export async function fetchTokenTrades(
  tokenAddress: string,
  limit = 20,
): Promise<TokenTrade[]> {
  const { trades } = await request<{ trades: IndexerTrade[] }>(
    `/trades/recent?token_address=${tokenAddress}&limit=${limit}`,
  );
  return trades.map((tr) => ({
    time: tr.time,
    tx_hash: tr.tx_hash,
    action: tradeSide(tr.action, tr.direction),
    trader: tr.trader,
    hodl_amount: tr.volume_uchanse,
    token_amount: tr.volume_token,
    fee: tr.fee_uchanse,
    phase: tr.source === "amm" ? "amm" : "curve",
    price_sol: Number(tr.price_uchanse) / 1e6,
  }));
}

export interface RecentTrade {
  time: string;
  tx_hash: string;
  source: string;
  action: string;
  direction: string;
  token_address: string;
  price_uxyz: string;
  volume_uxyz: string;
  volume_token: string;
  fee_uxyz: string;
  trader: string;
  token_name: string | null;
  token_symbol: string | null;
}

export const RECENT_TRADES_QUERY_KEY = ["trades", "recent"] as const;

export async function fetchRecentTrades(limit = 50): Promise<RecentTrade[]> {
  const { trades } = await request<{ trades: IndexerTrade[] }>(
    `/trades/recent?limit=${limit}`,
  );
  return trades.map((tr) => ({
    time: tr.time,
    tx_hash: tr.tx_hash,
    source: tr.source,
    // Normalized buy/sell (AMM swaps carry action "swap" + a direction).
    action: tradeSide(tr.action, tr.direction),
    direction: tr.direction,
    token_address: tr.token_address,
    price_uxyz: tr.price_uchanse,
    volume_uxyz: tr.volume_uchanse,
    volume_token: tr.volume_token,
    fee_uxyz: tr.fee_uchanse,
    trader: tr.trader,
    token_name: tr.token_name ?? null,
    token_symbol: tr.token_symbol ?? null,
  }));
}

// ── wallet ──────────────────────────────────────────────────────────────────
export interface TokenHolder {
  address: string;
  balance: string;
}
export interface WalletTokenHolding {
  market: string;
  mint: string;
  name: string;
  symbol: string;
  image: string | null;
  balance: number;
}
export interface WalletCollectibleHolding {
  identifier: string;
  kind: string;
  name: string;
  grade?: string;
  category?: string;
  market?: string;
  collectionId?: string;
  copies: number;
  image: string | null;
}

export async function fetchWalletTokens(
  owner: string,
): Promise<WalletTokenHolding[]> {
  const { tokens } = await request<{
    tokens: Array<{
      address: string;
      name: string;
      symbol: string;
      balance: string;
      graduated: boolean;
    }>;
  }>(`/wallet/tokens?address=${owner}`);
  return tokens
    .map((t) => ({
      market: t.address,
      mint: t.address,
      name: t.name,
      symbol: t.symbol,
      image: null,
      balance: Number(t.balance) / 1e6,
    }))
    .sort((a, b) => b.balance - a.balance);
}

// No collectibles on this launchpad.
export async function fetchWalletCollectibles(): Promise<WalletCollectibleHolding[]> {
  return [];
}

export const TOKEN_HOLDERS_QUERY_KEY = (address: string) =>
  ["holders", address] as const;

// The indexer does not expose a holders route yet; return empty (the UI shows
// "no holders" rather than erroring). A CW20 all_accounts scan could back this
// later.
export async function fetchTokenHolders(
  tokenAddress: string,
): Promise<TokenHolder[]> {
  if (!tokenAddress) return [];
  try {
    // The token address IS its cw20 contract. List holder accounts, then read
    // each balance. Exclude the launchpad (it custodies the unsold curve supply
    // + LP reserve, not a real holder) and any zero balances.
    const launchpad = await getLaunchpadContract();
    const { accounts } = await smartQuery<{ accounts: string[] }>(tokenAddress, {
      all_accounts: { limit: 100 },
    });
    const holders = await Promise.all(
      accounts
        .filter((a) => a !== launchpad)
        .map(async (address) => {
          try {
            const { balance } = await smartQuery<{ balance: string }>(
              tokenAddress,
              { balance: { address } },
            );
            return { address, balance };
          } catch {
            return { address, balance: "0" };
          }
        }),
    );
    return holders
      .filter((h) => h.balance !== "0" && Number(h.balance) > 0)
      .sort((a, b) => Number(b.balance) - Number(a.balance));
  } catch {
    return [];
  }
}

/** A wallet's CW20 balance of a token, in whole tokens (0 if none/unqueryable).
 *  The token address IS its cw20 contract. Used by the Sell panel so a holder
 *  knows how much they can sell. */
export async function fetchTokenBalance(
  tokenAddress: string,
  address: string,
): Promise<number> {
  if (!tokenAddress || !address) return 0;
  try {
    const { balance } = await smartQuery<{ balance: string }>(tokenAddress, {
      balance: { address },
    });
    return Number(balance) / 1e6;
  } catch {
    return 0;
  }
}

// ── curve progress (from the launchpad curve query) ─────────────────────────
export interface CurveProgress {
  tokens_sold: string;
  tokens_remaining: string;
  hodl_reserves: string;
  graduation_threshold: string;
  progress_percent: number;
  current_price: string;
  graduated: boolean;
}

export async function fetchCurveProgress(
  tokenAddress: string,
): Promise<CurveProgress> {
  const curve = await smartQuery<{
    tokens_sold: string;
    tokens_remaining: string;
    ansem_reserves: string;
    current_price: string;
    graduated: boolean;
  }>((await getLaunchpadContract()), { curve: { token_address: tokenAddress } });
  const sold = Number(curve.tokens_sold);
  const remaining = Number(curve.tokens_remaining);
  const total = sold + remaining;
  return {
    tokens_sold: curve.tokens_sold,
    tokens_remaining: curve.tokens_remaining,
    hodl_reserves: curve.ansem_reserves,
    graduation_threshold: "0",
    progress_percent: total > 0 ? Math.min(100, (sold / total) * 100) : 0,
    current_price: curve.current_price,
    graduated: curve.graduated,
  };
}

// ── live feed (SSE, replaces the old WebSocket) ─────────────────────────────
export type WsMessage =
  | { type: "trade"; market: string; trade: BackendTrade }
  | { type: "index"; market: string; tick: IndexTick }
  | { type: "funding"; market: string; tick: FundingTick };

export type LiveConnectionStatus = "connecting" | "live" | "offline";

export function subscribe(
  onMessage: (message: WsMessage) => void,
  onStatus?: (status: LiveConnectionStatus) => void,
): () => void {
  if (typeof EventSource === "undefined") return () => {};
  onStatus?.("connecting");
  const es = new EventSource(INDEXER_SSE);
  es.onopen = () => onStatus?.("live");
  es.onerror = () => onStatus?.("offline");
  const emit = (ev: MessageEvent) => {
    try {
      const d = JSON.parse(ev.data) as { token_address?: string };
      // The consumer only uses this to invalidate queries by market; map any
      // indexer event to a trade-typed message carrying the token address.
      onMessage({
        type: "trade",
        market: d.token_address ?? "",
        trade: {} as BackendTrade,
      });
    } catch {}
  };
  es.addEventListener("trade", emit);
  es.addEventListener("token_launch", emit);
  es.addEventListener("graduation", emit);
  return () => es.close();
}

// ── legacy launch/escrow endpoints (removed; the create form now builds a
// CosmWasm create_token tx directly). Kept as throwing stubs so any lingering
// import resolves until those pages are rewritten. ──────────────────────────
export async function uploadImage(): Promise<string> {
  throw new Error("image upload is not supported; paste an image URL");
}
export async function checkTicker(ticker: string) {
  return { ticker, available: true };
}
export async function checkLaunchReadiness() {
  return { ready: true };
}
export async function createEscrow() {
  throw new Error("escrow launches are not supported on ansem-1");
}
export async function launchMarket(): Promise<{ market: string }> {
  throw new Error("use the CosmWasm create_token flow");
}
export async function startEscrowVerification() {
  throw new Error("not supported");
}
export async function checkEscrowVerification() {
  return { verified: false };
}
