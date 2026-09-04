"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  MagnifyingGlass,
  SquaresFour,
  Rows,
  CaretUp,
  CaretDown,
  Fire,
  Trophy,
} from "@phosphor-icons/react";
import { useTokens } from "@/hooks/use-tokens";
import { Sparkline } from "@/components/utoken/sparkline";
import { DEFAULT_TOKEN_SUPPLY } from "@/lib/chain-config";
import { fetchGraduationThreshold, type TokenListItem,
  graduationProgress,
} from "@/lib/api";
import { formatDistanceToNow } from "date-fns";

type Filter = "all" | "curve" | "amm";
type View = "table" | "grid";
type SortKey = "cap" | "volume" | "trades" | "price" | "new";
type SortDir = "desc" | "asc";

const SORT_LABELS: Record<SortKey, string> = {
  cap: "Market cap",
  volume: "24h volume",
  trades: "24h trades",
  price: "Price",
  new: "Newest",
};

export function Scanner() {
  const { data: tokens, isLoading, isFetching } = useTokens();
  const { data: threshold = 0 } = useQuery({
    queryKey: ["graduation-threshold"],
    queryFn: fetchGraduationThreshold,
    staleTime: 5 * 60_000,
  });

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<View>("table");
  const [sortKey, setSortKey] = useState<SortKey>("cap");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const all = tokens ?? [];

  // Market-wide stats: always the full universe, not the filtered view, so the
  // trend band reflects the whole chain rather than the current search.
  const stats = useMemo(() => marketStats(all), [all]);

  const rows = useMemo(() => {
    let list = [...all];
    if (filter !== "all") list = list.filter((t) => (filter === "amm" ? t.graduated : !t.graduated));
    const q = query.trim().toLowerCase();
    if (q)
      list = list.filter(
        (t) =>
          t.symbol?.toLowerCase().includes(q) ||
          t.name?.toLowerCase().includes(q) ||
          t.address.toLowerCase().includes(q),
      );
    const dir = sortDir === "desc" ? 1 : -1;
    list.sort((a, b) => (metric(b, sortKey) - metric(a, sortKey)) * dir);
    return list;
  }, [all, query, filter, sortKey, sortDir]);

  function onSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  return (
    <div className="space-y-5 font-sans">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-semibold tracking-tight text-[var(--color-text-primary)]">Scanner</h1>
          <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">
            Every coin on Floatdesk, across the bonding curve and its graduated v4 pool.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--hairline)] bg-[var(--color-bg-page)] px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
          <span className={`h-1.5 w-1.5 rounded-full bg-[var(--color-accent-solid)] ${isFetching ? "animate-pulse" : ""}`} />
          {isFetching ? "Syncing" : "Live"}
        </span>
      </div>

      {/* Trend band */}
      <TrendBand stats={stats} loading={isLoading} />

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-[10px] border border-[var(--hairline)] bg-[var(--color-bg-surface)] px-3">
          <MagnifyingGlass size={15} className="text-[var(--color-text-muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, ticker, address"
            className="h-full flex-1 bg-transparent text-[13px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-[11px] text-[var(--color-text-subtle)] transition-colors hover:text-[var(--color-text-secondary)]"
              aria-label="Clear search"
            >
              Clear
            </button>
          )}
        </div>

        {/* Venue filter: segmented control with a sliding thumb (matches home). */}
        <div className="relative grid grid-cols-3 rounded-[10px] bg-[var(--color-bg-raised)] p-0.5 ring-1 ring-[var(--hairline)]">
          <span
            className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-md bg-[var(--color-accent-solid)] transition-transform duration-200"
            style={{ width: "calc((100% - 4px) / 3)", transform: `translateX(${(["all", "curve", "amm"] as Filter[]).indexOf(filter) * 100}%)` }}
          />
          {(["all", "curve", "amm"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`relative z-10 h-7 whitespace-nowrap rounded-md px-3 text-[12px] font-medium transition-colors ${
                filter === f ? "text-[var(--color-on-accent)]" : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              }`}
            >
              {f === "amm" ? "Graduated" : f === "curve" ? "On curve" : "All"}
            </button>
          ))}
        </div>

        <select
          value={sortKey}
          onChange={(e) => {
            setSortKey(e.target.value as SortKey);
            setSortDir("desc");
          }}
          className="h-9 rounded-[10px] border border-[var(--hairline)] bg-[var(--color-bg-surface)] px-3 text-[13px] text-[var(--color-text-secondary)] outline-none"
          aria-label="Sort by"
        >
          {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
            <option key={k} value={k}>{SORT_LABELS[k]}</option>
          ))}
        </select>

        {/* View toggle */}
        <div className="flex items-center rounded-[10px] bg-[var(--color-bg-raised)] p-0.5 ring-1 ring-[var(--hairline)]">
          {(["table", "grid"] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-label={v === "table" ? "Table view" : "Grid view"}
              className={`flex h-7 w-8 items-center justify-center rounded-md transition-colors ${
                view === v ? "bg-[#3a3a3c] text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              {v === "table" ? <Rows size={15} weight="bold" /> : <SquaresFour size={15} weight="bold" />}
            </button>
          ))}
        </div>
      </div>

      {/* Result count */}
      <div className="flex items-center justify-between text-[12px] text-[var(--color-text-subtle)]">
        <span>
          <span className="font-mono tabular-nums text-[var(--color-text-secondary)]">{isLoading ? "-" : rows.length}</span>{" "}
          {rows.length === 1 ? "coin" : "coins"}
          {filter !== "all" && <span className="text-[var(--color-text-subtle)]"> · {filter === "amm" ? "graduated" : "on curve"}</span>}
        </span>
        <span className="hidden font-mono uppercase tracking-[0.08em] sm:inline">
          Sorted by {SORT_LABELS[sortKey]} {sortDir === "desc" ? "↓" : "↑"}
        </span>
      </div>

      {/* Results */}
      {view === "table" ? (
        <ScannerTable
          rows={rows}
          loading={isLoading}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          thresholdMicro={threshold}
        />
      ) : (
        <div key={`${filter}-${sortKey}-${sortDir}`} className="ansem-fade-in grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {isLoading
            ? Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="h-[150px] animate-pulse rounded-[10px] border border-[var(--hairline)] bg-[var(--color-bg-surface)]" />
              ))
            : rows.map((t) => <ScannerCard key={t.address} token={t} thresholdMicro={threshold} />)}
        </div>
      )}

      {!isLoading && rows.length === 0 && (
        <div className="rounded-[10px] border border-dashed border-[var(--hairline)] bg-[var(--color-bg-page)] py-16 text-center">
          <p className="text-[13px] text-[var(--color-text-secondary)]">No coins match your filters.</p>
          <p className="mt-1 text-[12px] text-[var(--color-text-subtle)]">
            Try clearing the search, or{" "}
            <Link href="/create" className="text-[var(--color-accent-strong)] hover:underline">launch one yourself</Link>.
          </p>
        </div>
      )}
    </div>
  );
}

/* ---------------- Trend band ---------------- */

interface Stats {
  total: number;
  onCurve: number;
  graduated: number;
  volUsd: number;
  trades: number;
  mcapUsd: number;
  top: TokenListItem | null;
  active: TokenListItem | null;
  newest: TokenListItem | null;
}

function marketStats(list: TokenListItem[]): Stats {
  let volUsd = 0;
  let trades = 0;
  let mcapUsd = 0;
  let graduated = 0;
  let top: TokenListItem | null = null;
  let active: TokenListItem | null = null;
  let newest: TokenListItem | null = null;
  for (const t of list) {
    volUsd += volUsdOf(t);
    trades += t.trade_count_24h ?? 0;
    mcapUsd += capUsd(t);
    if (t.graduated) graduated += 1;
    if (!top || capUsd(t) > capUsd(top)) top = t;
    if (!active || (t.trade_count_24h ?? 0) > (active.trade_count_24h ?? 0)) active = t;
    if (!newest || new Date(t.first_seen_at).getTime() > new Date(newest.first_seen_at).getTime()) newest = t;
  }
  return { total: list.length, onCurve: list.length - graduated, graduated, volUsd, trades, mcapUsd, top, active, newest };
}

function TrendBand({ stats, loading }: { stats: Stats; loading: boolean }) {
  if (loading) {
    return (
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-[64px] animate-pulse rounded-[10px] border border-[var(--hairline)] bg-[var(--color-bg-surface)]" />
        ))}
      </div>
    );
  }
  const gradPct = stats.total ? (stats.graduated / stats.total) * 100 : 0;
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
      <Metric label="Coins" value={String(stats.total)} sub={`${stats.onCurve} curve · ${stats.graduated} AMM`} />
      <Metric label="24h volume" value={usd(stats.volUsd)} sub="all pools" />
      <Metric label="24h trades" value={num(stats.trades)} sub="buys + sells" />
      <Metric label="Total mcap" value={usd(stats.mcapUsd)} sub="live universe" />
      <Metric label="Graduated" value={`${gradPct.toFixed(0)}%`} sub={`${stats.graduated} on the AMM`} />
      <Spotlight
        icon={<Trophy size={13} weight="fill" />}
        label="Top mcap"
        token={stats.top}
        value={stats.top ? usd(capUsd(stats.top)) : "-"}
      />
      <Spotlight
        icon={<Fire size={13} weight="fill" />}
        label="Most active"
        token={stats.active}
        value={stats.active ? `${num(stats.active.trade_count_24h ?? 0)} trades` : "-"}
      />
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[10px] border border-[var(--hairline)] bg-[var(--color-bg-page)] px-3 py-2.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-subtle)]">{label}</p>
      <p className="mt-1 font-mono text-[17px] font-semibold tabular-nums leading-none text-[var(--color-text-primary)]">{value}</p>
      {sub && <p className="mt-1.5 truncate text-[11px] text-[var(--color-text-muted)]">{sub}</p>}
    </div>
  );
}

function Spotlight({ icon, label, token, value }: { icon: ReactNode; label: string; token: TokenListItem | null; value: string }) {
  const body = (
    <div className="flex h-full items-center gap-2.5 rounded-[10px] border border-[var(--hairline)] bg-[var(--color-bg-page)] px-3 py-2.5 transition-colors hover:border-zinc-600">
      <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-raised)]">
        {token?.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={token.image} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full items-center justify-center text-[11px] text-[var(--color-text-subtle)]">
            {token?.symbol?.slice(0, 1) ?? "?"}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--color-accent-strong)]">
          <span className="text-[var(--color-accent-strong)]">{icon}</span>
          {label}
        </p>
        <p className="mt-0.5 truncate text-[13px] font-semibold text-[var(--color-text-primary)]">
          {token ? `$${token.symbol}` : "-"}
        </p>
        <p className="truncate font-mono text-[11px] tabular-nums text-[var(--color-text-muted)]">{value}</p>
      </div>
    </div>
  );
  if (!token) return body;
  return (
    <Link href={`/token/${token.address}`} className="block h-full">
      {body}
    </Link>
  );
}

/* ---------------- Table view ---------------- */

function ScannerTable({
  rows,
  loading,
  sortKey,
  sortDir,
  onSort,
  thresholdMicro,
}: {
  rows: TokenListItem[];
  loading: boolean;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  thresholdMicro: number;
}) {
  return (
    <div className="overflow-x-auto rounded-[10px] bg-[var(--color-bg-surface)] ring-1 ring-[var(--hairline)]">
      <table className="w-full min-w-[900px] text-left">
        <thead>
          <tr className="border-b border-[var(--hairline)] text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-subtle)]">
            <th className="px-4 py-3 font-medium">#</th>
            <th className="px-4 py-3 font-medium">Token</th>
            <th className="px-4 py-3 font-medium">Venue</th>
            <Th label="Price" k="price" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
            <th className="px-4 py-3 text-right font-medium">24h</th>
            <th className="px-4 py-3 font-medium">Trend</th>
            <Th label="Mcap" k="cap" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
            <Th label="24h vol" k="volume" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
            <Th label="Trades" k="trades" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
            <Th label="Age" k="new" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={10} className="px-4 py-10 text-center text-[13px] text-[var(--color-text-muted)]">Loading scanner…</td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={10} className="px-4 py-10 text-center text-[13px] text-[var(--color-text-muted)]">No coins.</td>
            </tr>
          ) : (
            rows.map((t, i) => <TableRow key={t.address} token={t} rank={i + 1} thresholdMicro={thresholdMicro} />)
          )}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
  align = "left",
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sortKey === k;
  return (
    <th className={`px-4 py-3 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 uppercase tracking-[0.06em] transition-colors ${
          active ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-subtle)] hover:text-[var(--color-text-secondary)]"
        } ${align === "right" ? "flex-row-reverse" : ""}`}
      >
        {label}
        {active ? (
          sortDir === "desc" ? <CaretDown size={10} weight="bold" /> : <CaretUp size={10} weight="bold" />
        ) : (
          <span className="w-[10px]" />
        )}
      </button>
    </th>
  );
}

function TableRow({ token, rank, thresholdMicro }: { token: TokenListItem; rank: number; thresholdMicro: number }) {
  const change = token.price_change_24h;
  const price = priceUsdOf(token);
  return (
    <tr className="group border-b border-[var(--hairline)] transition-colors last:border-0 hover:bg-[var(--color-bg-raised)]">
      <td className="px-4 py-3 font-mono text-[13px] tabular-nums text-[var(--color-text-subtle)]">{rank}</td>
      <td className="px-4 py-3">
        <Link href={`/token/${token.address}`} className="flex items-center gap-2.5">
          <div className="h-8 w-8 shrink-0 overflow-hidden rounded-lg bg-[var(--color-bg-raised)] ring-1 ring-[var(--hairline)]">
            {token.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={token.image} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full items-center justify-center text-[11px] text-[var(--color-text-subtle)]">{token.symbol?.slice(0, 1)}</span>
            )}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-[var(--color-accent-strong)] group-hover:underline">${token.symbol}</p>
            <p className="truncate text-[12px] text-[var(--color-text-muted)]">{token.name}</p>
          </div>
        </Link>
      </td>
      <td className="px-4 py-3"><VenueCell token={token} thresholdMicro={thresholdMicro} /></td>
      <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-[var(--color-text-primary)]">{fmtPrice(price)}</td>
      <td className={`px-4 py-3 text-right font-mono text-[13px] font-medium tabular-nums ${changeColor(change)}`}>
        {fmtChange(change)}
      </td>
      <td className="px-4 py-3">
        <Sparkline address={token.address} up={change == null ? true : change >= 0} />
      </td>
      <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-[var(--color-text-primary)]">{usd(capUsd(token))}</td>
      <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-[var(--color-text-secondary)]">{usd(volUsdOf(token))}</td>
      <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-[var(--color-text-secondary)]">{num(token.trade_count_24h ?? 0)}</td>
      <td className="px-4 py-3 text-right font-mono text-[12px] tabular-nums text-[var(--color-text-muted)]">{ageShort(token.first_seen_at)}</td>
    </tr>
  );
}

/** Venue as a tag, plus a thin migration bar for on-curve coins. */
function VenueCell({ token, thresholdMicro }: { token: TokenListItem; thresholdMicro: number }) {
  if (token.graduated) return <VenueBadge graduated />;
  const pct = gradProgress(token, thresholdMicro);
  return (
    <div className="w-[112px]">
      <div className="flex items-center justify-between">
        <VenueBadge graduated={false} />
        {pct != null && <span className="font-mono text-[10px] tabular-nums text-[var(--color-text-muted)]">{pct.toFixed(0)}%</span>}
      </div>
      {pct != null && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--color-bg-raised)]">
          <div className="h-full rounded-full bg-[var(--color-accent-solid)]" style={{ width: `${Math.max(3, pct)}%` }} />
        </div>
      )}
    </div>
  );
}

/* ---------------- Grid view ---------------- */

function ScannerCard({ token, thresholdMicro }: { token: TokenListItem; thresholdMicro: number }) {
  const router = useRouter();
  const change = token.price_change_24h;
  const up = change == null ? true : change >= 0;
  const cap = capUsd(token);
  const vol = volUsdOf(token);
  const creator = token.creator ?? token.address;
  const pct = token.graduated ? null : gradProgress(token, thresholdMicro);

  function openCreator(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    router.push(`/creator/${creator}`);
  }

  return (
    <Link
      href={`/token/${token.address}`}
      className="group flex flex-col rounded-[10px] border border-[var(--hairline)] bg-[var(--color-bg-surface)] p-3.5 transition-colors hover:border-zinc-500"
    >
      {/* Identity */}
      <div className="flex items-center gap-2.5">
        <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-raised)]">
          {token.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={token.image} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full items-center justify-center text-sm text-[var(--color-text-subtle)]">{token.symbol?.slice(0, 1)}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[14px] font-semibold text-[var(--color-text-primary)]">{token.name}</p>
            <span className={`ml-auto shrink-0 font-mono text-[12px] font-semibold tabular-nums ${changeColor(change)}`}>
              {fmtChange(change)}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="text-[12px] font-semibold text-[var(--color-accent-strong)]">${token.symbol}</span>
            <VenueBadge graduated={token.graduated} />
            <span className="ml-auto shrink-0">
              <Sparkline address={token.address} up={up} width={64} height={22} />
            </span>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="mt-3 grid grid-cols-3 divide-x divide-[var(--hairline)] rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-page)]">
        <Cell label="Mcap" value={usd(cap)} />
        <Cell label="24h vol" value={usd(vol)} />
        <Cell label="24h tx" value={num(token.trade_count_24h ?? 0)} />
      </div>

      {/* Migration progress for on-curve coins */}
      {pct != null && (
        <div className="mt-2.5">
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-subtle)]">
            <span>Migration</span>
            <span className="font-mono tabular-nums text-[var(--color-accent-strong)]">{pct.toFixed(0)}% to AMM</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-raised)]">
            <div className="h-full rounded-full bg-[var(--color-accent-solid)] transition-[width] duration-500" style={{ width: `${Math.max(3, pct)}%` }} />
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="mt-2.5 flex items-center justify-between text-[11px] text-[var(--color-text-subtle)]">
        <button type="button" onClick={openCreator} className="relative z-10 truncate transition-colors hover:text-[var(--color-accent-strong)]">
          by {short(creator, 4)}
        </button>
        <span className="font-mono tabular-nums">{ageShort(token.first_seen_at)}</span>
      </div>
    </Link>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</p>
      <p className="mt-0.5 font-mono text-[13px] font-semibold tabular-nums text-[var(--color-text-primary)]">{value}</p>
    </div>
  );
}

/* ---------------- Shared bits ---------------- */

function VenueBadge({ graduated }: { graduated: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
        graduated ? "bg-[var(--color-accent-solid)]/15 text-[var(--color-accent-strong)]" : "bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]"
      }`}
    >
      {graduated ? "AMM" : "Curve"}
    </span>
  );
}

/* ---------------- data + format helpers ---------------- */

function metric(t: TokenListItem, key: SortKey): number {
  switch (key) {
    case "cap": return capUsd(t);
    case "volume": return volUsdOf(t);
    case "trades": return t.trade_count_24h ?? 0;
    case "price": return Number(t.current_price) || 0;
    case "new": return new Date(t.first_seen_at).getTime() || 0;
  }
}

function capUsd(t: TokenListItem): number {
  return (Number(t.current_price) / 1e6) * t.market.solUsd * DEFAULT_TOKEN_SUPPLY;
}
function volUsdOf(t: TokenListItem): number {
  return (Number(t.volume_24h) / 1e6) * t.market.solUsd;
}
function priceUsdOf(t: TokenListItem): number {
  return (Number(t.current_price) / 1e6) * t.market.solUsd;
}

/** Curve fill toward graduation, or null when the threshold is unavailable. */
function gradProgress(t: TokenListItem, thresholdMicro: number): number | null {
  if (thresholdMicro <= 0) return null;
  return graduationProgress(t) ?? 0;
}

function changeColor(change: number | null): string {
  if (change == null) return "text-[var(--color-text-subtle)]";
  return change >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]";
}
function fmtChange(change: number | null): string {
  if (change == null) return "-";
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
}
function fmtPrice(v: number): string {
  if (!v) return "-";
  return v >= 0.01 ? usd(v) : `$${Number(v.toPrecision(2))}`;
}
function usd(v: number): string {
  return Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(v || 0);
}
function num(v: number): string {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v || 0);
}
function short(a: string, n: number): string {
  return a.length <= n * 2 ? a : `${a.slice(0, n)}…${a.slice(-n)}`;
}
function ageShort(v: string): string {
  const d = new Date(v);
  if (isNaN(d.getTime())) return "-";
  return formatDistanceToNow(d, { addSuffix: false })
    .replace("about ", "")
    .replace(" minutes", "m").replace(" minute", "m")
    .replace(" hours", "h").replace(" hour", "h")
    .replace(" days", "d").replace(" day", "d")
    .replace(" months", "mo").replace(" month", "mo")
    .replace(" years", "y").replace(" year", "y")
    .replace("less than am", "<1m");
}
