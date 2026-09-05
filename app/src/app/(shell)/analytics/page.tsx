"use client";

import { useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { ChartLineUp, TrendUp, TrendDown, Minus } from "@phosphor-icons/react";
import {
  ANALYTICS_WINDOWS,
  deltaPct,
  num,
  useAnalyticsOverview,
  useLaunchesSeries,
  useTopTokens,
  useVolumeSeries,
  usdCompact,
  type AnalyticsWindow,
} from "@/lib/analytics";
import { VolumeChart, LaunchesChart } from "@/components/analytics/charts";

/**
 * Chain-wide analytics: Desk volume, activity and launches, served by this
 * app's own /api/float/analytics/* routes rather than the indexer, which has no
 * such endpoints. Everything is derived from real Desk trades and the launched
 * token list. The quote asset is USDG, so volume is already in dollars and
 * there is no denom left unpriced.
 */
export default function AnalyticsPage() {
  const [win, setWin] = useState<AnalyticsWindow>("24h");

  const overview = useAnalyticsOverview(win);
  const overview24 = useAnalyticsOverview("24h"); // fixed 24h tile, independent of selector
  const volume = useVolumeSeries(win);
  const launches = useLaunchesSeries(win);
  const top = useTopTokens(win, "volume", 12);

  const o = overview.data;
  const p = o?.prev ?? null;
  const o24 = overview24.data;

  // Bucket timestamps: hourly windows show day+hour, daily windows show the day.
  const daily = win === "30d" || win === "all";
  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return daily ? format(d, "MMM d") : format(d, "MMM d, HH:00");
  };

  const buy = o?.buyVolumeUsd ?? 0;
  const sell = o?.sellVolumeUsd ?? 0;
  const flow = buy + sell;
  const buyPct = flow > 0 ? (buy / flow) * 100 : 50;

  return (
    <div className="mx-auto max-w-[1160px] space-y-6 font-sans">
      {/* Header + window selector */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 font-display text-[24px] font-semibold tracking-tight text-[var(--color-text-primary)]">
            <ChartLineUp size={20} weight="fill" className="text-[var(--color-accent-strong)]" />
            Analytics
          </h1>
          <p className="mt-1 max-w-xl text-[13px] leading-5 text-[var(--color-text-secondary)]">
            Chain-wide volume and activity across every Floatdesk token. USD figures
            are USDG, the quote asset every market settles in.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-surface)] p-1">
          {ANALYTICS_WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => setWin(w.key)}
              className={`h-7 rounded-md px-3 font-display text-[12px] font-semibold uppercase tracking-[0.06em] transition-colors ${
                win === w.key
                  ? "bg-[var(--color-accent-solid)] text-[var(--color-on-accent)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--hairline)] sm:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label={`Volume · ${labelFor(win)}`}
          value={usdCompact(o?.volumeUsd)}
          delta={deltaPct(o?.volumeUsd ?? 0, p?.volumeUsd)}
          loading={overview.isLoading}
          accent
        />
        <StatTile
          label="24H Volume"
          value={usdCompact(o24?.volumeUsd)}
          delta={deltaPct(o24?.volumeUsd ?? 0, o24?.prev?.volumeUsd)}
          loading={overview24.isLoading}
        />
        <StatTile
          label="Trades"
          value={num(o?.tradeCount)}
          delta={deltaPct(o?.tradeCount ?? 0, p?.tradeCount)}
          loading={overview.isLoading}
        />
        <StatTile
          label="Unique Traders"
          value={num(o?.uniqueTraders)}
          delta={deltaPct(o?.uniqueTraders ?? 0, p?.uniqueTraders)}
          loading={overview.isLoading}
        />
        <StatTile
          label="Tokens Launched"
          value={num(o?.tokensLaunched)}
          delta={deltaPct(o?.tokensLaunched ?? 0, p?.tokensLaunched)}
          loading={overview.isLoading}
        />
        <StatTile
          label="Graduated"
          value={num(o?.tokensGraduated)}
          delta={deltaPct(o?.tokensGraduated ?? 0, p?.tokensGraduated)}
          loading={overview.isLoading}
        />
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Volume over time"
          subtitle={`Desk volume in USDG · ${labelFor(win)}`}
          right={
            flow > 0 ? (
              <div className="flex flex-col items-end gap-1">
                <div className="flex h-1.5 w-28 overflow-hidden rounded-full bg-[var(--color-bg-raised)]">
                  <div style={{ width: `${buyPct}%`, background: "#2563eb" }} />
                  <div style={{ width: `${100 - buyPct}%`, background: "#f0736c" }} />
                </div>
                <span className="font-mono text-[10px] text-[var(--color-text-muted)] tabular-nums">
                  {buyPct.toFixed(0)}% buy · {(100 - buyPct).toFixed(0)}% sell
                </span>
              </div>
            ) : null
          }
        >
          {volume.isLoading ? (
            <ChartSkeleton />
          ) : (
            <VolumeChart
              points={volume.data?.points ?? []}
              fmtValue={usdCompact}
              fmtTime={fmtTime}
            />
          )}
        </Card>

        <Card title="Launches & graduations" subtitle={`New tokens and curve fills · ${labelFor(win)}`}>
          {launches.isLoading ? (
            <ChartSkeleton />
          ) : (
            <LaunchesChart points={launches.data?.points ?? []} fmtTime={fmtTime} />
          )}
        </Card>
      </div>

      {/* Top tokens */}
      <Card title="Top tokens by volume" subtitle={labelFor(win)} noPad>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse">
            <thead>
              <tr className="border-b border-[var(--hairline)] text-left font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                <th className="px-4 py-2.5 font-medium">#</th>
                <th className="px-4 py-2.5 font-medium">Token</th>
                <th className="px-4 py-2.5 text-right font-medium">Volume</th>
                <th className="px-4 py-2.5 text-right font-medium">Trades</th>
                <th className="px-4 py-2.5 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {top.isLoading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-[var(--hairline)]">
                    <td colSpan={5} className="px-4 py-3">
                      <div className="h-4 w-full animate-pulse rounded bg-[var(--color-bg-raised)]" />
                    </td>
                  </tr>
                ))}
              {!top.isLoading && (top.data?.tokens.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">
                    No trades in this window yet.
                  </td>
                </tr>
              )}
              {top.data?.tokens.map((t, i) => (
                <tr
                  key={t.address}
                  className="border-b border-[var(--hairline)] transition-colors last:border-0 hover:bg-[var(--color-bg-raised)]"
                >
                  <td className="px-4 py-2.5 font-mono text-[12px] text-[var(--color-text-subtle)] tabular-nums">
                    {i + 1}
                  </td>
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/token/${t.address}`}
                      className="flex items-center gap-2 font-display text-[13px] font-semibold text-[var(--color-text-primary)] transition-colors hover:text-[var(--color-accent-strong)]"
                    >
                      ${t.symbol || t.address.slice(0, 6)}
                      {t.base_denom !== "usdg" && (
                        <span className="rounded-[3px] bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[9px] uppercase text-[var(--color-text-secondary)]">
                          {t.base_label}
                        </span>
                      )}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[12px] text-[var(--color-text-primary)] tabular-nums">
                    {t.volumeUsd != null
                      ? usdCompact(t.volumeUsd)
                      : `${num(Math.round(t.volumeBase))} ${t.base_label}`}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[12px] text-[var(--color-text-secondary)] tabular-nums">
                    {t.tradeCount.toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums">
                    <ChangeCell pct={t.priceChangePct} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Unpriced-denom honesty note */}
      {o && o.unpricedDenoms.length > 0 && (
        <p className="text-[11px] leading-4 text-[var(--color-text-subtle)]">
          Volume in {o.unpricedDenoms.map((d) => denomLabel(d)).join(", ")} is shown in base
          units and excluded from the USD totals: there is no live USD oracle for these
          denoms yet.
        </p>
      )}
    </div>
  );
}

function labelFor(w: AnalyticsWindow): string {
  return ANALYTICS_WINDOWS.find((x) => x.key === w)?.label ?? w;
}
function denomLabel(d: string): string {
  // Float denominates in USDG. The rest are ansem-1 denoms this page was forked
  // with; a label map that answers for a chain we are not on is how a wrong
  // ticker reaches a screen without anyone typing it.
  const m: Record<string, string> = { usdg: "USDG" };
  return m[d] ?? d.replace(/^u/, "").toUpperCase();
}

/* ------------------------------------------------------------------------- */

function StatTile({
  label,
  value,
  delta,
  loading,
  accent = false,
}: {
  label: string;
  value: string;
  delta: number | null;
  loading?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="bg-[var(--color-bg-page)] p-4">
      <p className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
        {label}
      </p>
      {loading ? (
        <div className="mt-2 h-6 w-20 animate-pulse rounded bg-[var(--color-bg-raised)]" />
      ) : (
        <p
          className={`mt-1.5 font-display text-[22px] font-semibold leading-none tabular-nums ${
            accent ? "text-[var(--color-accent-strong)]" : "text-[var(--color-text-primary)]"
          }`}
        >
          {value}
        </p>
      )}
      <div className="mt-1.5 h-4">{!loading && <Delta pct={delta} />}</div>
    </div>
  );
}

function Delta({ pct }: { pct: number | null }) {
  if (pct == null)
    return (
      <span className="flex items-center gap-1 font-mono text-[11px] text-[var(--color-text-subtle)]">
        <Minus size={11} weight="bold" /> —
      </span>
    );
  const up = pct >= 0;
  return (
    <span
      className={`flex items-center gap-1 font-mono text-[11px] tabular-nums ${
        up ? "text-[var(--color-accent-strong)]" : "text-[#f0736c]"
      }`}
    >
      {up ? <TrendUp size={11} weight="bold" /> : <TrendDown size={11} weight="bold" />}
      {up ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

function ChangeCell({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-[var(--color-text-subtle)]">—</span>;
  const up = pct >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 ${up ? "text-[var(--color-accent-strong)]" : "text-[#f0736c]"}`}>
      {up ? <TrendUp size={11} weight="bold" /> : <TrendDown size={11} weight="bold" />}
      {up ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

function Card({
  title,
  subtitle,
  right,
  children,
  noPad = false,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  noPad?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-[var(--hairline)] bg-[var(--color-bg-surface)]">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--hairline)] px-4 py-3">
        <div>
          <h2 className="font-display text-[14px] font-semibold text-[var(--color-text-primary)]">{title}</h2>
          {subtitle && <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{subtitle}</p>}
        </div>
        {right}
      </div>
      <div className={noPad ? "" : "p-4"}>{children}</div>
    </div>
  );
}

function ChartSkeleton() {
  return <div className="h-[240px] w-full animate-pulse rounded-lg bg-[var(--color-bg-raised)]" />;
}
