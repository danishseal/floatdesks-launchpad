/**
 * Data layer, repointed from the ansem-1 CosmWasm stack to Float on Robinhood
 * Chain. Reads come from the Float indexer (proxied through /api/float so the
 * browser never needs the :8462 origin) and from live contract calls.
 *
 * Every exported name and type shape is preserved so the ~20 UI components that
 * import from here keep compiling. Where a field has no Float equivalent it is
 * filled with a neutral value rather than a fabricated one, and the functions
 * that had no equivalent at all now say so instead of silently returning a stub.
 *
 * The one conversion worth stating: a launched token is quoted in its
 * UNDERLYING fSHARE, not in a stablecoin. `current_price` stays in the old
 * 1e6-scaled convention but the unit is fSHARE-per-token, and `solUsd` carries
 * the underlying's USD mark so the existing USD math in the components lands on
 * the right number.
 */

import {
  tokenCurve, markPx, publicClient, balanceOf, launchpadParams,
} from "@/lib/float/chain";
import { resolve } from "@/lib/float/registry";

const API = "/api/float";

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** A row from the Float indexer's /tokens. */
interface IndexerToken {
  token: string;
  underlying: string;
  creator: string;
  name: string;
  symbol: string;
  block: number;
  image: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  graduated: number;
  last_px: string | null;
  raised: string | null;
  underlying_ticker: string | null;
  underlying_spot: number | null;
  underlying_px: string | null;
}

interface IndexerTrade {
  id: number;
  block: number;
  tx: string;
  asset_id: string;
  side: string;
  who: string;
  quote: string;
  base: string;
  px: string;
  fee_bps: number;
  ts?: number | null;
}

// ── oracle: underlying -> USD ───────────────────────────────────────────────
// Everything shown in USD resolves through the Desk's mark for the underlying
// equity, which is the venue price, not the raw oracle print.
let baseUsdCache: { rate: number; at: number } | null = null;

export async function fetchBaseUsd(): Promise<number> {
  const now = Date.now();
  if (baseUsdCache && now - baseUsdCache.at < 30_000) return baseUsdCache.rate;
  try {
    const listings = await request<Array<{ asset_id: string; px: string; status: number }>>("/listings");
    const live = listings.find((l) => l.status === 0) ?? listings[0];
    const rate = live ? Number(live.px) / 1e8 : 0;
    baseUsdCache = { rate: Number.isFinite(rate) ? rate : 0, at: now };
    return baseUsdCache.rate;
  } catch {
    return baseUsdCache?.rate ?? 0;
  }
}

/** USD mark for one underlying, cached briefly. */
const markCache = new Map<string, { usd: number; at: number }>();

async function underlyingUsd(assetId: string): Promise<number> {
  const hit = markCache.get(assetId);
  if (hit && Date.now() - hit.at < 30_000) return hit.usd;
  try {
    const raw = await markPx(assetId as `0x${string}`);
    const usd = Number(raw) / 1e8;
    markCache.set(assetId, { usd, at: Date.now() });
    return usd;
  } catch {
    return hit?.usd ?? 0;
  }
}

// ── preserved shapes ────────────────────────────────────────────────────────

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
  /** Float: the underlying market's assetId this token is quoted in. */
  base_denom: string;
  /** Float: the fSHARE ticker, e.g. "fMOUTAI". */
  base_label: string;
  market: MarketInfo;
  listing: ListingMeta;
}

export interface BackendCandle {
  time: number; open: number; high: number; low: number; close: number;
  volume: number; trades: number;
}
export interface BackendTrade {
  ts: number; side: "buy" | "sell"; priceSol: number; solAmount: number;
  tokenAmount: number; phase: "curve" | "amm"; sig: string; user: string;
}
export interface IndexTick { ts: number; value: number }
export interface FundingTick { ts: number; rateBpsPerDay: number; mark: number; index: number }
export interface AggregatorRow {
  market: string; ticker: string; name: string; image: string | null;
  priceUsd: number; change24h: number | null;
}

/**
 * MarketInfo for a launched token. Fields that describe a collectible venue
 * (items, insurance, funding) have no Float equivalent and stay neutral; the
 * ones the UI actually renders are real.
 */
function marketFor(t: IndexerToken, underlyingUsdPx: number, curve?: {
  rQuote: bigint; gradTarget: bigint; vQuote: bigint; vToken: bigint; sold: bigint;
}): MarketInfo {
  const raised = curve ? Number(curve.rQuote) / 1e18 : Number(t.raised ?? 0) / 1e18;
  return {
    market: t.token,
    solUsd: underlyingUsdPx,
    collection: t.underlying_ticker ?? "",
    synthMint: t.token,
    status: t.graduated ? "graduated" : "curve",
    venue: t.graduated ? "v4" : "curve",
    frozen: false,
    indexPerToken: 0,
    markPerToken: Number(t.last_px ?? 0),
    cardIndexSol: 0,
    unitsPerItem: 1,
    indexLastTs: 0,
    feedAgeSec: null,
    // Liquidity, expressed in the underlying: the raise plus the unsold supply
    // valued at the marginal curve price, which is both sides of the pool.
    ammSolReserve: raised,
    ammTokenReserve: curve ? Number(curve.vToken - curve.sold) / 1e18 : 0,
    insuranceSol: 0,
    totalCollateralSol: 0,
    curveSolRaised: raised,
    curveVirtualSol: curve ? Number(curve.vQuote) / 1e18 : 0,
    curveVirtualTokens: curve ? Number(curve.vToken) / 1e18 : 0,
    graduationTargetSol: curve ? Number(curve.gradTarget) / 1e18 : 0,
    fundingIndex: "0",
    maxOpenInterest: 0,
    itemsDeposited: 0,
  };
}

function toToken(t: IndexerToken, underlyingUsdPx: number, curve?: {
  rQuote: bigint; gradTarget: bigint; vQuote: bigint; vToken: bigint; sold: bigint; graduated: boolean;
}): TokenListItem {
  const links: Record<string, string | undefined> = {};
  if (t.website) links.website = t.website;
  if (t.twitter) links.twitter = t.twitter;
  if (t.telegram) links.telegram = t.telegram;

  const graduated = curve ? curve.graduated : Boolean(t.graduated);
  // last_px from the indexer is fSHARE per token as a float; the preserved
  // convention is a 1e6-scaled string.
  const px = Number(t.last_px ?? 0);

  return {
    address: t.token,
    mint: t.token,
    name: t.name,
    symbol: t.symbol,
    image: t.image,
    description: null,
    social_links: Object.values(links).filter(Boolean) as string[],
    creator: t.creator,
    source: "launchpad",
    graduated,
    created_at: null,
    first_seen_at: String(t.block),
    // Consumers read this as `Number(current_price) / 1e6` = fSHARE per token.
    // A curve price of ~1e-8 rounds to zero as an integer, so keep the decimal.
    current_price: String(px * 1e6),
    // Consumers read this as `Number(hodl_reserves) / 1e6` = whole units of the
    // quote asset, so keep that convention rather than passing the raw 1e18
    // on-chain value, which reported every curve as fully graduated.
    hodl_reserves: String((Number(t.raised ?? 0) / 1e18) * 1e6),
    volume_24h: "0",
    volume_total: "0",
    creator_fees_total: "0",
    trade_count_24h: 0,
    price_change_24h: null,
    base_denom: t.underlying,
    base_label: `f${t.underlying_ticker ?? "SHARE"}`,
    market: marketFor(t, underlyingUsdPx, curve),
    listing: {
      ticker: t.symbol,
      name: t.name,
      image: t.image,
      links,
      feeReceiver: { kind: "creator", value: t.creator },
      identifier: t.token,
      launchedBy: t.creator,
    },
  };
}

// ── token data ──────────────────────────────────────────────────────────────

export async function fetchTokens(): Promise<TokenListItem[]> {
  const rows = await request<IndexerToken[]>("/tokens?limit=200");
  const rates = new Map<string, number>();
  await Promise.all(
    [...new Set(rows.map((r) => r.underlying))].map(async (u) => {
      rates.set(u, await underlyingUsd(u));
    }),
  );
  // Read each curve, not just the indexer row. Every graduation target is set
  // at launch from its own underlying's mark, so without the curve a list item
  // has no target to measure progress against and the whole board falls back to
  // a placeholder. The RPC batches these, and the token count is small.
  const curves = await Promise.all(
    rows.map((t) => tokenCurve(t.token as `0x${string}`).catch(() => undefined)),
  );
  return rows.flatMap((t, i) => {
    const c = curves[i];
    // A launchpad that has never seen this token returns a zero struct rather
    // than reverting, so an indexer pointed at a different deployment would
    // otherwise surface tokens that do not exist on the active chain.
    if (c && c.gradTarget === 0n && c.sold === 0n && c.rQuote === 0n) return [];
    const token = toToken(t, rates.get(t.underlying) ?? 0, c);
    if (c) {
      token.hodl_reserves = String((Number(c.rQuote) / 1e18) * 1e6);
      if (!c.graduated) {
        const q = Number(c.vQuote + c.rQuote);
        const b = Number(c.vToken - c.sold);
        if (b > 0) token.current_price = String((q / b) * 1e6);
      }
    }
    return [token];
  });
}

export async function fetchToken(address: string): Promise<TokenListItem> {
  const t = await request<IndexerToken | null>(`/tokens?token=${address}`);
  if (!t) throw new Error(`no token ${address}`);
  // The indexer's last_px only moves once a trade is indexed, so read the curve
  // for the live marginal price: a freshly launched token otherwise reads zero.
  let curve: Awaited<ReturnType<typeof tokenCurve>> | undefined;
  try {
    curve = await tokenCurve(address as `0x${string}`);
  } catch {
    /* pre-index or wrong venue: indexer values stand */
  }
  const usdPx = await underlyingUsd(t.underlying);
  const token = toToken(t, usdPx, curve);
  if (curve) {
    token.hodl_reserves = String((Number(curve.rQuote) / 1e18) * 1e6);
  }
  if (curve && !curve.graduated) {
    // Marginal price on a constant-product curve with virtual reserves.
    const q = Number(curve.vQuote + curve.rQuote);
    const b = Number(curve.vToken - curve.sold);
    if (b > 0) token.current_price = String((q / b) * 1e6);
  }
  return token;
}

export const fetchMarkets = async (): Promise<MarketInfo[]> =>
  (await fetchTokens()).map((t) => t.market);
export const fetchAggregator = async (): Promise<AggregatorRow[]> => [];

// ── 24h change, derived from candles ────────────────────────────────────────
const CHANGE_WINDOW_S = 24 * 60 * 60;

export async function fetchTokenChange24h(tokenAddress: string): Promise<number | null> {
  try {
    const candles = await request<Array<{ t: number; o: number; c: number }>>(
      `/candles?token=${tokenAddress}&bucket=3600&limit=200`,
    );
    if (candles.length < 1) return null;
    const now = candles[candles.length - 1].c;
    const cutoff = candles[candles.length - 1].t - CHANGE_WINDOW_S;
    const before = [...candles].reverse().find((c) => c.t <= cutoff);
    const ref = before ? before.c : candles[0].o;
    if (!(now > 0 && ref > 0)) return null;
    return ((now - ref) / ref) * 100;
  } catch {
    return null;
  }
}

export async function fetchTokenChanges(
  addresses: string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  await Promise.all(addresses.map(async (a) => out.set(a, await fetchTokenChange24h(a))));
  return out;
}

let gradCache: number | null = null;

export async function fetchGraduationThreshold(): Promise<number> {
  if (gradCache !== null) return gradCache;
  try {
    const p = await launchpadParams();
    gradCache = Number(p.graduationUsd) / 1e6;
  } catch {
    gradCache = 0;
  }
  return gradCache;
}

// ── candles ─────────────────────────────────────────────────────────────────
export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "12h" | "1d";

const TF_SECONDS: Record<Timeframe, number> = {
  "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "12h": 43200, "1d": 86400,
};

export interface CandleResponse {
  token_address: string;
  timeframe: Timeframe;
  candles: Array<{
    time: number; open: number; high: number; low: number; close: number;
    volume: number; trades: number;
  }>;
}

export async function fetchCandles(
  tokenAddress: string,
  timeframe: Timeframe = "1h",
  limit = 300,
): Promise<CandleResponse> {
  const bucket = TF_SECONDS[timeframe];
  const rows = await request<Array<{ t: number; o: number; h: number; l: number; c: number }>>(
    `/candles?token=${tokenAddress}&bucket=${bucket}&limit=${limit}`,
  ).catch(() => []);
  return {
    token_address: tokenAddress,
    timeframe,
    candles: rows.map((r) => ({
      time: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: 0, trades: 0,
    })),
  };
}

// ── trades ──────────────────────────────────────────────────────────────────

export interface TokenTrade {
  time: string; tx_hash: string; action: "buy" | "sell"; trader: string;
  hodl_amount: string; token_amount: string; fee: string;
  phase: "curve" | "amm"; price_sol: number;
}

export const TOKEN_TRADES_QUERY_KEY = (address: string) =>
  ["trades", "token", address] as const;

export function tradeSide(action: string, direction: string): "buy" | "sell" {
  if (action === "sell") return "sell";
  if (action === "buy") return "buy";
  return direction === "token_to_base" || direction === "sell" ? "sell" : "buy";
}

/**
 * Per-token trades. Empty until the indexer exposes them.
 *
 * This used to return the Desk trades for the token's UNDERLYING, on the
 * reasoning that they are the flow moving its quote asset. That was wrong in
 * the way that is hardest to see: the rows were real, accurate and about a
 * different subject, and the page rendered them as this token's transactions.
 * A token with one curve buy showed "Transactions (2)" and "1 buys, $9.92K vol"
 * from somebody else's fMOUTAI purchases.
 *
 * The indexer holds the right rows in its token_trades table, which /candles
 * reads, but exposes no endpoint returning them individually. Until it does,
 * this returns nothing and the panel shows its own empty state, which is the
 * same call already made for holders. Wrong data is worse than none.
 */
export async function fetchTokenTrades(): Promise<TokenTrade[]> {
  return [];
}

export interface RecentTrade {
  time: string; tx_hash: string; source: string; action: string; direction: string;
  token_address: string; price_uxyz: string; volume_uxyz: string; volume_token: string;
  fee_uxyz: string; trader: string; token_name: string | null; token_symbol: string | null;
}

export const RECENT_TRADES_QUERY_KEY = ["trades", "recent"] as const;

export async function fetchRecentTrades(limit = 50): Promise<RecentTrade[]> {
  const [rows, listings] = await Promise.all([
    request<IndexerTrade[]>(`/trades?limit=${limit}`).catch(() => []),
    request<Array<{ asset_id: string; ticker: string }>>("/listings").catch(() => []),
  ]);
  const name = new Map(listings.map((l) => [l.asset_id.toLowerCase(), l.ticker]));
  return rows.map((r) => {
    const ticker = name.get(r.asset_id?.toLowerCase() ?? "") ?? null;
    return {
      time: r.ts ? new Date(r.ts * 1000).toISOString() : String(r.block),
      tx_hash: r.tx,
      source: "desk",
      action: r.side === "sell" ? "sell" : "buy",
      direction: r.side === "sell" ? "token_to_base" : "base_to_token",
      token_address: r.asset_id,
      price_uxyz: r.px,
      volume_uxyz: r.quote,
      volume_token: r.base,
      fee_uxyz: String(Math.round((Number(r.quote) * (r.fee_bps ?? 0)) / 10_000)),
      trader: r.who,
      token_name: ticker ? `f${ticker}` : null,
      token_symbol: ticker ? `f${ticker}` : null,
    };
  });
}

// ── holders and balances ────────────────────────────────────────────────────

export interface TokenHolder {
  address: string;
  balance: string;
  /** Set when the address is protocol machinery (the curve holding unsold
   *  supply, the Desk, a stake vault), so it does not read as a whale. */
  label?: string | null;
}
export interface WalletTokenHolding {
  market: string; mint: string; name: string; symbol: string;
  image: string | null; balance: number;
}
export interface WalletCollectibleHolding {
  identifier: string; kind: string; name: string; grade?: string; category?: string;
  market?: string; collectionId?: string; copies: number; image: string | null;
}

export const TOKEN_HOLDERS_QUERY_KEY = (address: string) =>
  ["holders", address] as const;

/**
 * Holder distribution, derived from the token's own Transfer logs by
 * /api/float/holders. The Float indexer builds no holder index, but an ERC-20's
 * holder set is recoverable from its logs, so it is recovered rather than left
 * as the empty list this used to return.
 */
export async function fetchTokenHolders(address: string): Promise<TokenHolder[]> {
  const r = await request<{ holders?: TokenHolder[]; truncated?: boolean }>(
    `/holders?token=${address}`,
  ).catch(() => null);
  return r?.holders ?? [];
}

export async function fetchTokenBalance(
  tokenAddress: string,
  owner: string,
): Promise<number> {
  try {
    const raw = await balanceOf(tokenAddress as `0x${string}`, owner as `0x${string}`);
    return Number(raw) / 1e18;
  } catch {
    return 0;
  }
}

export async function fetchWalletTokens(owner: string): Promise<WalletTokenHolding[]> {
  const rows = await request<IndexerToken[]>("/tokens?limit=200").catch(() => []);
  const held = await Promise.all(
    rows.map(async (t) => {
      const balance = await fetchTokenBalance(t.token, owner);
      return balance > 0
        ? { market: t.token, mint: t.token, name: t.name, symbol: t.symbol, image: t.image, balance }
        : null;
    }),
  );
  return held.filter(Boolean) as WalletTokenHolding[];
}

/** No collectible venue on Float. */
export async function fetchWalletCollectibles(): Promise<WalletCollectibleHolding[]> {
  return [];
}

// ── curve progress ──────────────────────────────────────────────────────────

export interface CurveProgress {
  tokens_sold: string;
  tokens_remaining: string;
  hodl_reserves: string;
  graduation_threshold: string;
  progress_percent: number;
  current_price: string;
  graduated: boolean;
}

export async function fetchCurveProgress(tokenAddress: string): Promise<CurveProgress> {
  const c = await tokenCurve(tokenAddress as `0x${string}`);
  const raised = Number(c.rQuote);
  const target = Number(c.gradTarget);
  const remaining = Number(c.vToken - c.sold);
  const q = Number(c.vQuote + c.rQuote);
  return {
    tokens_sold: c.sold.toString(),
    tokens_remaining: (c.vToken - c.sold).toString(),
    hodl_reserves: String((Number(c.rQuote) / 1e18) * 1e6),
    graduation_threshold: c.gradTarget.toString(),
    // Progress is the RAISE against its target, which is what graduates the
    // curve. Supply sold is not the gate.
    progress_percent: target > 0 ? Math.min(100, (raised / target) * 100) : 0,
    current_price: remaining > 0 ? String((q / remaining) * 1e6) : "0",
    graduated: c.graduated,
  };
}

/**
 * Fill toward graduation, 0-100, or null when the target is not known yet.
 *
 * Always measured against the token's OWN gradTarget, which is set at launch
 * from the underlying's mark and so differs per token. A single global
 * threshold cannot work here: the raise is denominated in the underlying
 * fSHARE, not in dollars, and comparing the two reported every curve as 100%.
 */
export function graduationProgress(token: TokenListItem): number | null {
  if (token.graduated) return 100;
  const target = token.market.graduationTargetSol;
  if (!target || target <= 0) return null;
  return Math.min(100, Math.max(0, (token.market.curveSolRaised / target) * 100));
}

// ── live feed ───────────────────────────────────────────────────────────────
export type WsMessage =
  | { type: "trade"; market: string; trade: BackendTrade }
  | { type: "index"; market: string; tick: IndexTick }
  | { type: "funding"; market: string; tick: FundingTick };

export type LiveConnectionStatus = "connecting" | "live" | "offline";

/**
 * The Float indexer has no SSE or WebSocket, so this polls its cursor and
 * emits when new trades land. Same signature as the stream it replaces.
 */
export function subscribe(
  onMessage: (message: WsMessage) => void,
  onStatus?: (status: LiveConnectionStatus) => void,
): () => void {
  let stopped = false;
  let lastTrades = -1;
  onStatus?.("connecting");

  const tick = async () => {
    if (stopped) return;
    try {
      const s = await request<{ trades: number }>("/status");
      onStatus?.("live");
      if (lastTrades >= 0 && s.trades !== lastTrades) {
        onMessage({
          type: "trade",
          market: "",
          trade: { ts: Date.now(), side: "buy", priceSol: 0, solAmount: 0, tokenAmount: 0, phase: "curve", sig: "", user: "" },
        });
      }
      lastTrades = s.trades;
    } catch {
      onStatus?.("offline");
    }
  };

  void tick();
  const id = setInterval(tick, 10_000);
  return () => { stopped = true; clearInterval(id); };
}

// ── launch helpers ──────────────────────────────────────────────────────────
// Launching goes straight to the TokenLaunchpad contract from the wizard, so
// the old escrow/verification dance has no Float equivalent. These throw rather
// than resolving to a stub, so a caller wired to them fails loudly.

const NO_EQUIVALENT = "Not available on Float: launches call TokenLaunchpad directly.";

export async function uploadImage(): Promise<string> { throw new Error(NO_EQUIVALENT); }
export async function checkTicker() { throw new Error(NO_EQUIVALENT); }
export async function checkLaunchReadiness() { throw new Error(NO_EQUIVALENT); }
export async function createEscrow() { throw new Error(NO_EQUIVALENT); }
export async function launchMarket(): Promise<{ market: string }> { throw new Error(NO_EQUIVALENT); }
export async function startEscrowVerification() { throw new Error(NO_EQUIVALENT); }
export async function checkEscrowVerification() { throw new Error(NO_EQUIVALENT); }

/** Kept so callers that imported it still resolve. */
export { resolve as resolveContract, publicClient };
