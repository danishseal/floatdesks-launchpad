"use client";

// Chain-wide analytics client. Reads /api/float/analytics/*, which this app
// serves itself: the Float indexer has no analytics routes, and because it
// answers an unknown path with 200 and its endpoint listing, pointing at it
// meant parsing that menu as data. Everything is derived from real Desk trades
// and the launched token list; volume is quoted in USDG, which is already
// dollars, so `volumeUsd` needs no conversion and `byDenom` carries the single
// quote asset.

import { useQuery } from "@tanstack/react-query";
import { INDEXER_HTTP } from "@/lib/floorlaunch/config";

export type AnalyticsWindow = "24h" | "7d" | "30d" | "all";
export const ANALYTICS_WINDOWS: { key: AnalyticsWindow; label: string }[] = [
  { key: "24h", label: "24H" },
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
  { key: "all", label: "All" },
];

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${INDEXER_HTTP}${path}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// ── overview ────────────────────────────────────────────────────────────────
export interface DenomVolume {
  denom: string;
  label: string;
  volumeBase: number;
  volumeUsd: number | null;
  buyVolumeBase: number;
  sellVolumeBase: number;
  tradeCount: number;
  priced: boolean;
}
export interface OverviewTotals {
  volumeUsd: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  tradeCount: number;
  uniqueTraders: number;
  tokensLaunched: number;
  tokensGraduated: number;
  byDenom: DenomVolume[];
  unpricedDenoms: string[];
}
export interface AnalyticsOverview extends OverviewTotals {
  window: AnalyticsWindow;
  prev: OverviewTotals | null;
}

export function useAnalyticsOverview(window: AnalyticsWindow) {
  return useQuery({
    queryKey: ["analytics", "overview", window],
    queryFn: () => get<AnalyticsOverview>(`/analytics/overview?window=${window}`),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

// ── volume series ───────────────────────────────────────────────────────────
export interface VolumePoint {
  t: string;
  volumeUsd: number;
  tradeCount: number;
}
export interface VolumeSeries {
  window: AnalyticsWindow;
  bucket: number;
  points: VolumePoint[];
}

export function useVolumeSeries(window: AnalyticsWindow) {
  return useQuery({
    queryKey: ["analytics", "volume-series", window],
    queryFn: () => get<VolumeSeries>(`/analytics/volume-series?window=${window}`),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

// ── top tokens ──────────────────────────────────────────────────────────────
export interface TopToken {
  address: string;
  symbol: string;
  base_denom: string;
  base_label: string;
  volumeBase: number;
  volumeUsd: number | null;
  tradeCount: number;
  priceChangePct: number | null;
}
export interface TopTokens {
  window: AnalyticsWindow;
  by: "volume" | "trades";
  tokens: TopToken[];
}

export function useTopTokens(
  window: AnalyticsWindow,
  by: "volume" | "trades" = "volume",
  limit = 12,
) {
  return useQuery({
    queryKey: ["analytics", "top-tokens", window, by, limit],
    queryFn: () =>
      get<TopTokens>(`/analytics/top-tokens?window=${window}&by=${by}&limit=${limit}`),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

// ── launches series ─────────────────────────────────────────────────────────
export interface LaunchPoint {
  t: string;
  launched: number;
  graduated: number;
}
export interface LaunchesSeries {
  window: AnalyticsWindow;
  bucket: number;
  points: LaunchPoint[];
}

export function useLaunchesSeries(window: AnalyticsWindow) {
  return useQuery({
    queryKey: ["analytics", "launches-series", window],
    queryFn: () => get<LaunchesSeries>(`/analytics/launches-series?window=${window}`),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

// ── formatting helpers ──────────────────────────────────────────────────────
export function usdCompact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  if (Math.abs(v) >= 1000)
    return Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(v);
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: v < 1 ? 4 : 2 })}`;
}

export function num(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return v.toLocaleString("en-US");
}

/** Percent delta between current and prior; null when the base is 0/absent. */
export function deltaPct(cur: number, prev: number | null | undefined): number | null {
  if (prev == null || !Number.isFinite(prev) || prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}
