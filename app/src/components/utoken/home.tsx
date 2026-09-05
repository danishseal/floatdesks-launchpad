"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useTokens } from "@/hooks/use-tokens";
import { Sparkline } from "@/components/utoken/sparkline";
import { DEFAULT_TOKEN_SUPPLY } from "@/lib/chain-config";
import { type TokenListItem,
  graduationProgress,
} from "@/lib/api";

export function UtokenHome() {
  const { data: tokens, isLoading } = useTokens();
  const [previewAddress, setPreviewAddress] = useState<string | null>(null);

  const ranked = useMemo(
    () =>
      [...(tokens ?? [])].sort(
        (a, b) => capUsd(b) - capUsd(a),
      ),
    [tokens],
  );
  const featured = ranked;
  const previewToken = previewAddress
    ? ranked.find((token) => token.address === previewAddress) ?? null
    : null;

  return (
    <div className="space-y-8 font-sans">
      <TokenPreviewBanner token={previewToken} />

      <section className="w-full max-w-none">
        <div className="mb-4">
          <div>
            <h2 className="font-display text-[24px] font-semibold tracking-tight text-[var(--color-text-primary)]">
              Live coins
            </h2>
            <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">
              Live across the bonding curve and its graduated v4 pool.
            </p>
          </div>
        </div>
        {isLoading ? (
          <div className="grid grid-cols-1 overflow-hidden border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 18 }).map((_, i) => (
              <div key={i} className="aspect-video border-b border-r border-[var(--color-border-soft)] bg-[var(--color-bg-surface)]" />
            ))}
          </div>
        ) : (
          <FeaturedGrid items={featured} onPreview={setPreviewAddress} />
        )}
      </section>

      {/* Registry */}
      <Registry tokens={ranked} loading={isLoading} />
    </div>
  );
}

/* ---------------- Live detail preview ---------------- */

function TokenPreviewBanner({
  token,
}: {
  token: TokenListItem | null;
}) {
  if (!token) return <StarterBanner />;

  const change = token.price_change_24h;
  const priceUsd = (Number(token.current_price) / 1e6) * token.market.solUsd;
  const volumeUsd = (Number(token.volume_24h) / 1e6) * token.market.solUsd;
  const liquidityUsd = (Number(token.hodl_reserves) / 1e6) * token.market.solUsd;
  const progress = graduationProgress(token) ?? 4;

  return (
    <section className="grid overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg-surface)] lg:h-[420px] lg:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.7fr)]" aria-label={`${token.name} live market preview`} aria-live="polite">
      <div className="flex min-h-[250px] min-w-0 flex-col border-b border-[var(--color-border-soft)] p-5 lg:min-h-0 lg:border-b-0 lg:border-r">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Live market preview</p>
            <div className="mt-2 flex items-baseline gap-3">
              <h1 className="font-display text-[24px] font-semibold uppercase leading-none tracking-[-0.02em] text-[var(--color-text-primary)] sm:text-[30px]">
                {token.name}
              </h1>
              <span className="font-mono text-[12px] font-semibold text-[var(--color-accent-strong)]">${token.symbol}</span>
            </div>
          </div>
          <div className="text-right">
            <p className="font-mono text-[20px] font-semibold tabular-nums text-[var(--color-text-primary)]">{formatPrice(priceUsd)}</p>
            <p className={`mt-1 font-mono text-[11px] font-semibold ${change == null ? "text-[var(--color-text-muted)]" : change >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}`}>
              {change == null ? "No 24h change" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}% · 24h`}
            </p>
          </div>
        </div>

        <div className="mt-4 flex min-h-[120px] flex-1 items-end overflow-hidden border-b border-l border-[var(--color-border-soft)] px-2 pb-2 [&>svg]:h-full [&>svg]:w-full">
          <Sparkline address={token.address} up={change == null ? true : change >= 0} width={760} height={170} />
        </div>

        <div className="mt-2 flex shrink-0 items-center justify-between gap-4 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
          <span>Recent price · 1h candles</span>
          <span>Hover a coin below to inspect</span>
        </div>
      </div>

      <aside className="flex min-h-0 min-w-0 flex-col p-5">
        <div className="flex shrink-0 items-start gap-3 border-b border-[var(--color-border-soft)] pb-3">
          <div className="h-11 w-11 shrink-0 overflow-hidden bg-[var(--color-bg-raised)]">
            {token.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={token.image} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full items-center justify-center font-display text-lg text-[var(--color-text-subtle)]">{token.symbol?.slice(0, 1) || "?"}</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-display text-[15px] font-semibold uppercase text-[var(--color-text-primary)]">{token.name}</p>
                <p className="mt-0.5 font-mono text-[10px] text-[var(--color-accent-strong)]">${token.symbol}</p>
              </div>
              <VenueBadge token={token} />
            </div>
          </div>
        </div>

        <dl className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-3 py-4 font-mono text-[10px]">
          <PreviewStat label="Market cap" value={usd(capUsd(token))} />
          <PreviewStat label="Volume · 24h" value={usd(volumeUsd)} />
          <PreviewStat label="Liquidity" value={usd(liquidityUsd)} />
          <PreviewStat label="Trades · 24h" value={String(token.trade_count_24h ?? 0)} />
          <PreviewStat label="Pair" value={`${token.symbol}/${token.base_label}`} />
          <PreviewStat label="Contract" value={short(token.address)} />
        </dl>

        <div className="mt-auto shrink-0 border-t border-[var(--color-border-soft)] pt-3">
          <div className="flex items-center justify-between font-mono text-[10px] text-[var(--color-text-muted)]">
            <span>{token.graduated ? "AMM live" : "Bonding progress"}</span>
            <span className="font-semibold text-[var(--color-text-primary)]">{progress.toFixed(0)}%</span>
          </div>
          <div className="mt-2 h-1.5 bg-[var(--color-bg-raised)]">
            <div className="h-full bg-[var(--color-accent-solid)]" style={{ width: `${progress}%` }} />
          </div>
          <Link href={`/token/${token.address}`} className="mt-3 flex h-9 items-center justify-between bg-[var(--color-text-primary)] px-3 font-mono text-[11px] font-semibold text-[var(--color-bg-surface)] hover:bg-[var(--color-accent-solid)]">
            <span>Open full market</span>
            <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </aside>
    </section>
  );
}

function StarterBanner() {
  return (
    <section className="flex min-h-[380px] items-center justify-center overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-5 py-8 lg:h-[420px]" aria-label="Start a new coin">
      <div className="w-full max-w-[520px] text-center">
        <h1 className="font-neue-bit text-[clamp(3rem,6vw,5rem)] font-bold lowercase leading-[0.8] tracking-[-0.025em] text-[var(--color-text-primary)]">
          [start a new coin]
        </h1>
        <p className="mx-auto mt-7 max-w-[430px] text-[15px] leading-6 text-[var(--color-text-secondary)]">
          Choose a name, image, and ticker. Floatdesk handles the market and bonding curve.
        </p>

        <Link href="/create" className="mx-auto mt-6 flex h-11 max-w-[360px] items-center justify-between bg-[var(--color-accent-solid)] px-4 font-mono text-[12px] font-semibold text-[var(--color-on-accent)] hover:bg-[var(--color-accent-strong)]">
          <span>Launch your coin</span>
          <span aria-hidden="true">→</span>
        </Link>
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.09em] text-[var(--color-text-muted)]">
          Hover over any live coin to preview its market
        </p>
      </div>
    </section>
  );
}

/* ---------------- Static featured grid ---------------- */

function FeaturedGrid({
  items,
  onPreview,
}: {
  items: TokenListItem[];
  onPreview: (address: string | null) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="flex h-[320px] items-center justify-center border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] text-sm text-[var(--color-text-muted)]">
        No coins launched yet.
      </div>
    );
  }

  return (
    <div
      className="grid grid-cols-1 overflow-hidden border border-[var(--color-border)] bg-[var(--color-border-soft)] sm:grid-cols-2 lg:grid-cols-4"
      aria-label="Live coins"
      onMouseLeave={() => onPreview(null)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onPreview(null);
      }}
    >
      {items.map((token) => (
        <FeaturedCard key={token.address} token={token} onPreview={onPreview} />
      ))}
    </div>
  );
}

function FeaturedCard({
  token,
  onPreview,
}: {
  token: TokenListItem;
  onPreview: (address: string | null) => void;
}) {
  const change = token.price_change_24h;
  const graduated = token.graduated;
  const pct = graduationProgress(token) ?? 4;

  return (
    <Link
      href={`/token/${token.address}`}
      onMouseEnter={() => onPreview(token.address)}
      onFocus={() => onPreview(token.address)}
      className="group relative flex min-w-0 flex-col border-b border-r border-[var(--color-border-soft)] bg-[var(--color-bg-page)] hover:z-10 hover:bg-[var(--color-bg-surface)] hover:shadow-[inset_0_-3px_0_var(--color-accent-solid)] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-accent-solid)]"
    >
      <div className="relative aspect-video w-full overflow-hidden bg-[var(--color-bg-raised)]">
        {token.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={token.image} alt={`${token.name} token artwork`} className="block h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center font-display text-[clamp(2rem,5vw,4rem)] font-semibold text-[var(--color-text-subtle)]">
            {token.symbol?.slice(0, 1) || "?"}
          </div>
        )}

      </div>

      <div className="flex flex-1 flex-col px-3 pb-2.5 pt-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-display text-[13px] font-semibold uppercase leading-[1.15] tracking-[0.03em] text-[var(--color-text-primary)]">
              {token.name}
            </p>
            <p className="mt-1 font-mono text-[10px] font-semibold text-[var(--color-accent-strong)]">
              ${token.symbol}
            </p>
          </div>
          {graduated && <VenueBadge token={token} />}
        </div>

        <p className="mt-1.5 line-clamp-1 min-h-[14px] text-[10px] leading-[1.3] text-[var(--color-text-secondary)] group-hover:text-[var(--color-text-primary)]">
          {token.description?.trim() || `${token.name} is trading live on the Floatdesk market.`}
        </p>

        <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-1.5 font-mono text-[9px]">
          <span className="text-[var(--color-text-muted)]">Mkt cap</span>
          <span className="font-semibold text-[var(--color-text-primary)]">{usd(capUsd(token))}</span>
          {change != null && (
            <span className={change >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}>
              {change >= 0 ? "+" : ""}{change.toFixed(1)}%
            </span>
          )}
          {!graduated && <span className="ml-auto text-[var(--color-text-secondary)]">{pct.toFixed(0)}%</span>}
        </div>
      </div>

      {!graduated && (
        <div className="h-0.5 w-full bg-[var(--color-border-soft)]">
          <div className="h-full bg-[var(--color-accent-solid)]" style={{ width: `${pct}%` }} />
        </div>
      )}
    </Link>
  );
}

function PreviewStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{label}</dt>
      <dd className="mt-0.5 truncate font-semibold text-[var(--color-text-primary)]">{value}</dd>
    </div>
  );
}

/* ---------------- Registry ---------------- */

type Filter = "all" | "curve" | "amm";

const REGISTRY_FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "curve", label: "On curve" },
  { value: "amm", label: "Graduated" },
];

function Registry({ tokens, loading }: { tokens: TokenListItem[]; loading: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const rows = useMemo(
    () =>
      tokens.filter((t) =>
        filter === "all" ? true : filter === "amm" ? t.graduated : !t.graduated,
      ),
    [tokens, filter],
  );
  const activeFilterIndex = REGISTRY_FILTERS.findIndex(({ value }) => value === filter);

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-[24px] font-semibold tracking-tight text-[var(--color-text-primary)]">
          The Bullpen <span className="font-sans text-[13px] font-normal text-[var(--color-text-muted)]">{tokens.length} tokens</span>
        </h2>
        {/* Segmented control */}
        <div
          className="relative grid grid-cols-3 rounded-lg bg-[var(--color-bg-raised)] p-0.5 ring-1 ring-[var(--hairline)]"
          role="group"
          aria-label="Filter tokens"
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-md bg-[var(--color-accent-solid)] shadow-[0_1px_2px_rgba(0,0,0,0.12)] transition-transform duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transition-none"
            style={{ width: "calc((100% - 4px) / 3)", transform: `translate3d(${activeFilterIndex * 100}%, 0, 0)` }}
          />
          {REGISTRY_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={`relative z-10 h-7 rounded-md px-3 font-sans text-[12px] font-medium transition-[color,transform] duration-200 ease-out active:scale-[0.97] motion-reduce:transition-none ${
                filter === value ? "text-[var(--color-on-accent)]" : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl bg-[var(--color-bg-surface)] ring-1 ring-[var(--hairline)]">
        <table className="w-full min-w-[860px] text-left">
          <thead>
            <tr className="border-b border-[var(--hairline)] text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-subtle)]">
              <th className="px-4 py-3 font-medium">#</th>
              <th className="px-4 py-3 font-medium">Token</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Price</th>
              <th className="px-4 py-3 text-right font-medium">24h</th>
              <th className="px-4 py-3 font-medium">Trend</th>
              <th className="px-4 py-3 text-right font-medium">Mcap</th>
              <th className="px-4 py-3 text-right font-medium">Holders</th>
              <th className="px-4 py-3 font-medium">Contract</th>
            </tr>
          </thead>
          <tbody key={filter} className="ansem-fade-in" aria-live="polite">
            {loading ? (
              <tr><td colSpan={9} className="px-4 py-10 text-center font-sans text-[13px] text-[var(--color-text-muted)]">Loading registry…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-10 text-center font-sans text-[13px] text-[var(--color-text-muted)]">No tokens.</td></tr>
            ) : (
              rows.map((t, i) => <RegistryRow key={t.address} token={t} rank={i + 1} />)
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RegistryRow({ token, rank }: { token: TokenListItem; rank: number }) {
  const change = token.price_change_24h;
  const priceUsd = (Number(token.current_price) / 1e6) * token.market.solUsd;
  return (
    <tr className="group border-b border-[var(--hairline)] transition-colors duration-200 last:border-0 hover:bg-[var(--color-bg-raised)]">
      <td className="px-4 py-3 tabular-nums text-[13px] text-[var(--color-text-subtle)]">{rank}</td>
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
            <p className="text-[14px] font-semibold text-[var(--color-accent-strong)] group-hover:underline">{token.symbol}</p>
            <p className="truncate text-[12px] font-medium text-[var(--color-text-muted)]">{token.name}</p>
          </div>
        </Link>
      </td>
      <td className="px-4 py-3"><StatusPill token={token} /></td>
      <td className="px-4 py-3 text-right tabular-nums text-[13px] text-[var(--color-text-primary)]">
        {priceUsd > 0 ? (priceUsd >= 0.01 ? usd(priceUsd) : `$${Number(priceUsd.toPrecision(2))}`) : "-"}
      </td>
      <td className={`px-4 py-3 text-right text-[13px] font-medium tabular-nums ${change == null ? "text-[var(--color-text-subtle)]" : change >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}`}>
        {change == null ? "-" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`}
      </td>
      <td className="px-4 py-3"><Sparkline address={token.address} up={change == null ? true : change >= 0} /></td>
      <td className="px-4 py-3 text-right tabular-nums text-[13px] text-[var(--color-text-primary)]">{usd(capUsd(token))}</td>
      <td className="px-4 py-3 text-right tabular-nums text-[13px] text-[var(--color-text-secondary)]">{token.trade_count_24h ?? 0}</td>
      <td className="px-4 py-3 tabular-nums text-[12px] text-[var(--color-text-muted)]">{short(token.address)}</td>
    </tr>
  );
}

function VenueBadge({ token }: { token: TokenListItem }) {
  const graduated = token.graduated;
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        graduated ? "bg-[var(--color-accent-solid)]/15 text-[var(--color-accent-strong)]" : "bg-[var(--color-bg-raised)] text-[var(--color-text-secondary)]"
      }`}
    >
      {graduated ? "Floatdesk AMM" : "Bonding"}
    </span>
  );
}

/** Status as a progress-bar pill: bonding fill, or full green when graduated. */
function StatusPill({ token }: { token: TokenListItem }) {
  const graduated = token.graduated;
  let pct = 100;
  let label = "Pool on AMM";
  if (!graduated) {
    const p = graduationProgress(token);
    pct = p ?? 6;
    label = p === null ? "Bonding" : `Bonding ${p.toFixed(0)}%`;
  }
  return (
    <div className="relative h-[19px] w-[148px] overflow-hidden rounded-md bg-[var(--color-bg-raised)]">
      <div
        className={`absolute inset-y-0 left-0 rounded-md ${graduated ? "bg-[var(--color-positive)]/25" : "bg-[var(--color-accent-solid)]/25"}`}
        style={{ width: `${pct}%` }}
      />
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold text-[var(--color-text-primary)]">{label}</span>
    </div>
  );
}

/* helpers */
function capUsd(t: TokenListItem): number {
  return (Number(t.current_price) / 1e6) * t.market.solUsd * DEFAULT_TOKEN_SUPPLY;
}
function usd(v: number): string {
  return Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(v || 0);
}
function formatPrice(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0";
  return v >= 0.01 ? usd(v) : `$${Number(v.toPrecision(3))}`;
}
function short(a: string): string {
  return a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a;
}
