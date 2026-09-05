"use client";

import { useQuery } from "@tanstack/react-query";

/** Shapes returned by /api/float/pools. Amounts are stringified base units. */
export interface PoolsMarket {
  assetId: `0x${string}`;
  ticker: string;
  displayName: string;
  token: `0x${string}`;
  status: 0 | 1 | 2;
  spot: boolean;
  markPx: string;
  oraclePx: string | null;
  oracleUpdatedAt: number | null;
  marketOpen: boolean | null;
  oiCapQuote: string;
  oiCapEffective: string | null;
  netOI: string;
  baseSpreadBps: number;
  ahSpreadBps: number;
  totalStaked: string | null;
  volume24h: number;
  volume7d: number;
  traderFees7d: number;
  trades: number;
}

export interface PoolsToken {
  token: `0x${string}`;
  name: string;
  symbol: string;
  underlyingTicker: string;
  raised: string;
  gradTarget: string;
  sold: string;
  graduated: boolean;
  /** CurveFunder quotes its curve in USDG (6dp), TokenLaunchpad in the
   *  underlying fSHARE (18dp). The row has to know which it is reading. */
  quoteIsUsdg?: boolean;
  poolId?: string;
  /** Launched on a launcher the Registry no longer points at. */
  superseded?: boolean;
}

export interface PoolsResponse {
  network: { key: string; label: string; chainId: number; explorer: string; registry: string; testnet: boolean };
  venue: "token-launchpad" | "curve-funder" | null;
  quote: { address: `0x${string}`; symbol: string; decimals: number };
  desk: {
    address: `0x${string}`; available: string; equity: string; totalShares: string;
    sharePrice: number; txFeeBps: number; stakerFeeBps: number; withdrawDelay: number;
  };
  /** Null when the funder could not be read; the queue row is then omitted. */
  funder: {
    address: `0x${string}`; assetId: `0x${string}`; target: string; funded: string;
    queueLength: number; feeBalance: string;
    /** False when contribute() would revert NotQueued. */
    acceptsContribution: boolean;
  } | null;
  launchpad: Record<string, string> | null;
  markets: PoolsMarket[];
  /** When measured is false, every volume and fee below is unmeasured, not zero. */
  indexer: {
    reachable: boolean;
    error: string | null;
    status: "unreachable" | "wrong-chain" | "unverified" | "ok";
    desk: string | null;
    measured: boolean;
  };
  /** Markets that could not be read, with the reason. Normally empty. */
  unreadable: Array<{ assetId: string; reason: string }>;
  tokens: PoolsToken[];
  totals: { volume24h: number; volume7d: number; traderFees7d: number; tradeCount: number };
  asOf: number;
}

export const POOLS_QUERY_KEY = ["float", "pools"] as const;

export function usePools() {
  return useQuery<PoolsResponse>({
    queryKey: POOLS_QUERY_KEY,
    queryFn: async () => {
      const r = await fetch("/api/float/pools", { cache: "no-store" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `pools -> HTTP ${r.status}`);
      }
      return r.json();
    },
    refetchInterval: 15_000,
  });
}

// ---------------------------------------------------------------- formatting

/** USDG and every quote amount on Float is 6dp. */
export const QUOTE_DP = 6;

export function fromUnits(raw: string | bigint, decimals: number): number {
  return Number(BigInt(raw)) / 10 ** decimals;
}

export function usd(n: number, opts: { max?: number; min?: number } = {}): string {
  const { min = 0, max = n >= 1000 ? 0 : 2 } = opts;
  return n.toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: min, maximumFractionDigits: max,
  });
}

export function pct(n: number, dp = 2): string {
  return `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(dp)}%`;
}

export const STATUS_LABEL: Record<number, string> = {
  0: "Live",
  1: "Settle only",
  2: "Halted",
};

/** Oracle price is 1e8-scaled; mark price shares that scale. */
export function px8(raw: string | null): number {
  return raw ? Number(BigInt(raw)) / 1e8 : 0;
}

export function duration(secs: number): string {
  if (secs % 86400 === 0) return `${secs / 86400}d`;
  if (secs % 3600 === 0) return `${secs / 3600}h`;
  return `${Math.round(secs / 60)}m`;
}
