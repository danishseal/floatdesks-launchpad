"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Horse } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useTokens } from "@/hooks/use-tokens";
import { useFloorlaunchLive } from "@/hooks/use-floorlaunch-live";
import { fetchGraduationThreshold, type TokenListItem } from "@/lib/api";
import { DEFAULT_TOKEN_SUPPLY } from "@/lib/chain-config";
import { formatDistanceToNow } from "date-fns";

function byNewest(tokens: TokenListItem[]): TokenListItem[] {
  return [...tokens].sort(
    (a, b) =>
      new Date(b.first_seen_at).getTime() - new Date(a.first_seen_at).getTime(),
  );
}

// Real bonding-curve fill toward AMM graduation: CHANSE raised on the curve
// (ansem_reserves, uchanse micro) over the launchpad's live graduation
// threshold. `thresholdMicro` comes from one cached config read; until it
// resolves we return null so the bar shows an indeterminate state rather than a
// fake 0%.
function curveProgress(
  token: TokenListItem,
  thresholdMicro: number,
): number | null {
  if (token.graduated) return 100;
  if (!thresholdMicro || thresholdMicro <= 0) return null;
  const raised = Number(token.hodl_reserves) || 0;
  return Math.min(100, Math.max(0, (raised / thresholdMicro) * 100));
}

export function TokenFeed() {
  const { data: tokens, isLoading, error } = useTokens();
  useFloorlaunchLive();
  const { data: gradThreshold = 0 } = useQuery({
    queryKey: ["graduation-threshold"],
    queryFn: fetchGraduationThreshold,
    staleTime: 5 * 60_000,
  });

  const rankedByCap = useMemo(() => {
    const src = tokens ?? [];
    return [...src]
      .sort(
        (a, b) =>
          Number(b.current_price) * b.market.solUsd -
          Number(a.current_price) * a.market.solUsd,
      )
      .slice(0, 12);
  }, [tokens]);

  const recentTokens = useMemo(
    () => byNewest(tokens ?? []).slice(0, 12),
    [tokens],
  );

  const protocol = useMemo(() => {
    const source = tokens ?? [];
    const volumeUsd = source.reduce(
      (sum, t) => sum + (Number(t.volume_total) / 1_000_000) * t.market.solUsd,
      0,
    );
    const feesUsd = source.reduce(
      (sum, t) => sum + (Number(t.creator_fees_total) / 1_000_000) * t.market.solUsd,
      0,
    );
    const swaps = source.reduce((sum, t) => sum + (t.trade_count_24h ?? 0), 0);
    return {
      launched: source.length,
      volumeUsd,
      creatorUsd: feesUsd,
      platformUsd: feesUsd * 0.15,
      swaps,
    };
  }, [tokens]);

  return (
    <div className="mx-auto max-w-[1440px] space-y-8">
      {/* ---- Promo banner ---- */}
      <HornsPromoBanner />

      {/* ---- COINS (ranked scroller) ---- */}
      <section className="space-y-3">
        <SectionHeader
          title="Coins"
          subtitle={`${protocol.launched} launched`}
          subtitle2="by marketcap"
          href="/explore"
        />
        <div className="-mx-1 flex gap-2.5 overflow-x-auto px-1 pb-1">
          {isLoading
            ? Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="h-[236px] w-[176px] shrink-0 animate-pulse rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)]/80"
                />
              ))
            : rankedByCap.map((token, i) => (
                <RankedCoin key={token.address} token={token} rank={i + 1} />
              ))}
          {!isLoading && rankedByCap.length === 0 && (
            <EmptyRail>No coins launched yet. Be the first.</EmptyRail>
          )}
        </div>
      </section>

      {/* ---- PROTOCOL (odometer stats) ---- */}
      <section className="space-y-3">
        <SectionHeader
          title="Protocol"
          subtitle="solo launches"
          href="/explore"
          hintLabel="full analytics"
        />
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] lg:grid-cols-4">
          <ProtocolStat
            label="Coins launched"
            digits={String(protocol.launched)}
            foot={`${protocol.swaps.toLocaleString()} swaps · 24h`}
          />
          <ProtocolStat
            label="Lifetime volume"
            digits={usdOdo(protocol.volumeUsd)}
            foot="curve + AMM"
          />
          <ProtocolStat
            label="Creator revenue"
            digits={usdOdo(protocol.creatorUsd)}
            foot="90% of LP fees"
          />
          <ProtocolStat
            label="Platform revenue"
            digits={usdOdo(protocol.platformUsd)}
            foot="launch fees + 10% LP"
          />
        </div>
      </section>

      {/* ---- NEW COINS (table) ---- */}
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-4">
          <SectionHeader title="New Coins" subtitle="the latest solo launches" plain />
          <Link
            href="/explore"
            className="flex items-center gap-1.5 font-display text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            browse all <ArrowRight size={12} />
          </Link>
        </div>
        {error && (
          <div className="rounded-[8px] border border-[var(--color-negative)]/30 bg-[var(--color-negative-soft)] p-4 text-center text-sm text-[var(--color-negative)]">
            Failed to load coins.
          </div>
        )}
        <div className="overflow-x-auto rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)]/80">
          <div className="min-w-[720px]">
            <div className="grid grid-cols-[minmax(240px,1fr)_140px_120px_110px_90px] items-center border-b border-[var(--color-border-soft)] px-4 py-2.5">
              {["Coin", "Market Cap", "Progress", "Age", "Activity"].map((h, i) => (
                <span
                  key={h}
                  className={`font-display text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--color-text-subtle)] ${i > 0 ? "text-right" : ""}`}
                >
                  {h}
                </span>
              ))}
            </div>
            {isLoading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[minmax(240px,1fr)_140px_120px_110px_90px] items-center border-b border-[var(--color-border-soft)] px-4 py-2.5 last:border-b-0"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="h-9 w-9 shrink-0 animate-pulse rounded-[5px] bg-[var(--color-bg-page)]" />
                      <div className="h-3 w-28 animate-pulse rounded bg-[var(--color-bg-page)]" />
                    </div>
                  </div>
                ))
              : recentTokens.map((token) => (
                  <NewCoinRow key={token.address} token={token} thresholdMicro={gradThreshold} />
                ))}
            {!isLoading && recentTokens.length === 0 && (
              <p className="px-5 py-12 text-center text-sm text-[var(--color-text-muted)]">
                No recently launched coins.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ---- Footer pitch bar ---- */}
      <LaunchFooterBar />
    </div>
  );
}

/* ---------- promo banner (above COINS) ---------- */

// Image banner slot with a FIXED 1194:315 aspect ratio; it scales
// proportionally with the content width (never a fixed pixel height). Because
// the ratio is locked and the art matches it, object-cover fills without
// cropping. Build artwork at 1194 x 315 (export @2x = 2388 x 630). Drop the file
// at /public/promo-banner.png; until then a labeled placeholder shows.
const BANNER_ASPECT = "1194 / 315";
const BANNER_SRC = "/promo-banner.png";

function HornsPromoBanner() {
  const [failed, setFailed] = useState(false);
  return (
    <Link
      href="/horns"
      className="group relative block w-full overflow-hidden rounded-[10px] border border-[var(--color-border-soft)] transition-colors hover:border-[var(--color-border)]"
      style={{ aspectRatio: BANNER_ASPECT }}
    >
      {!failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={BANNER_SRC}
          alt="Horns"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-r from-[#0f1a12] via-[#0d1410] to-[#0a0a0b]">
          <div className="flex items-center gap-2">
            <Horse size={18} weight="fill" className="text-[var(--color-accent-strong)]" />
            <span className="font-display text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--color-accent-strong)]">
              Horns banner
            </span>
          </div>
          <p className="font-mono text-[12px] text-[var(--color-text-muted)]">
            drop artwork at <span className="text-[var(--color-text-secondary)]">public/promo-banner.png</span>
          </p>
          <p className="font-mono text-[11px] text-[var(--color-text-subtle)]">ratio 1194 : 315, art @2x: 2388 × 630</p>
        </div>
      )}
    </Link>
  );
}

/* ---------- footer pitch bar (pew-style) ---------- */

function LaunchFooterBar() {
  return (
    <section className="rounded-[10px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)]/80 px-5 py-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        {/* Left: pitch */}
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] text-[var(--color-accent-strong)]">
            <Horse size={16} weight="fill" />
          </span>
          <div>
            <p className="font-display text-[14px] font-semibold tracking-tight text-[var(--color-text-primary)]">
              Graduate to a locked ANSEM AMM pool with Horns attached
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-[var(--color-text-subtle)]">
              bonding curve → AMM · liquidity locked · swap fees skim to holders
            </p>
          </div>
        </div>

        {/* Right: creator share of fees, ANSEM vs others */}
        <div className="w-full max-w-[280px] shrink-0 space-y-1.5">
          <FeeShareBar label="ansem.fun" value={90} tone="#2563eb" display="90/10" />
          <FeeShareBar label="others" value={70} tone="#3a3a42" display="70/30" />
          <p className="pt-0.5 text-right font-display text-[9px] uppercase tracking-[0.16em] text-[var(--color-text-subtle)]">
            Creator share of LP fees
          </p>
        </div>
      </div>
    </section>
  );
}

function FeeShareBar({
  label,
  value,
  tone,
  display,
}: {
  label: string;
  value: number;
  tone: string;
  display: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 font-mono text-[11px] text-[var(--color-text-secondary)]">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-bg-raised)]">
        <span className="block h-full rounded-full" style={{ width: `${value}%`, background: tone }} />
      </div>
      <span className="mono w-10 shrink-0 text-right text-[11px] font-semibold text-[var(--color-text-secondary)]">
        {display}
      </span>
    </div>
  );
}

/* ---------- section header ---------- */

function SectionHeader({
  title,
  subtitle,
  subtitle2,
  href,
  hintLabel,
  plain = false,
}: {
  title: string;
  subtitle?: string;
  subtitle2?: string;
  href?: string;
  hintLabel?: string;
  plain?: boolean;
}) {
  const left = (
    <div className="flex items-baseline gap-3">
      <span className="eyebrow">{title}</span>
      {subtitle && <span className="eyebrow-sub">{subtitle}</span>}
      {subtitle2 && <span className="eyebrow-sub">{subtitle2}</span>}
    </div>
  );
  if (plain) return left;
  return (
    <div className="flex items-end justify-between gap-4">
      {left}
      {href && (
        <Link
          href={href}
          className="flex items-center gap-1.5 font-display text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
        >
          {hintLabel ?? "browse all"} <ArrowRight size={12} />
        </Link>
      )}
    </div>
  );
}

/* ---------- ranked coin card ---------- */

function RankedCoin({ token, rank }: { token: TokenListItem; rank: number }) {
  const solUsd = token.market.solUsd;
  const cap = (Number(token.current_price) / 1e6) * DEFAULT_TOKEN_SUPPLY * solUsd;
  const change = token.price_change_24h;
  return (
    <Link
      href={`/token/${token.address}`}
      className="group relative flex w-[176px] shrink-0 flex-col overflow-hidden rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)]/80 transition-colors hover:border-[var(--color-border-soft)]"
    >
      <span className="absolute left-2 top-2 z-10 flex h-6 min-w-6 items-center justify-center rounded-[4px] bg-black/70 px-1.5 font-display text-[11px] font-bold text-[var(--color-text-primary)] backdrop-blur-sm">
        {rank}
      </span>
      <div className="relative aspect-square w-full overflow-hidden bg-[var(--color-bg-page)]">
        {token.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={token.image} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
        ) : (
          <div className="flex h-full w-full items-center justify-center font-display text-3xl text-zinc-700">
            {token.symbol?.[0]}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 p-2.5">
        <div className="flex items-center gap-1.5">
          <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--color-text-primary)]">
            {token.name ?? "Unknown"}
          </p>
          {token.graduated && (
            <span className="shrink-0 rounded-[3px] border border-[#26323f] bg-[#141b24] px-1.5 py-0.5 font-display text-[9px] font-semibold uppercase tracking-[0.1em] text-[#8ab4ff]">
              AMM
            </span>
          )}
        </div>
        <p className="truncate font-mono text-[11px] text-[var(--color-text-muted)]">${token.symbol ?? "TOKEN"}</p>
        <div className="mt-0.5 flex items-center justify-between">
          <span className="mono text-[13px] font-semibold text-[var(--color-text-primary)]">{formatUsd(cap)}</span>
          {change != null && (
            <span className={`mono text-[11px] font-semibold ${change >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}`}>
              {change >= 0 ? "+" : ""}{change.toFixed(1)}%
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

/* ---------- protocol odometer stat ---------- */

function ProtocolStat({
  label,
  digits,
  foot,
}: {
  label: string;
  digits: string;
  foot: string;
}) {
  return (
    <div className="bg-[var(--color-bg-page)] px-4 py-4">
      <p className="font-display text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--color-text-subtle)]">
        {label}
      </p>
      <div className="mt-2.5">
        <Odometer value={digits} />
      </div>
      <p className="mt-2.5 text-[11px] text-[var(--color-text-subtle)]">{foot}</p>
    </div>
  );
}

function Odometer({ value }: { value: string }) {
  return (
    <span className="odo text-[22px] leading-none">
      {value.split("").map((ch, i) =>
        /[0-9]/.test(ch) ? (
          <span key={i} className="odo-d">{ch}</span>
        ) : (
          <span key={i} className="odo-sep">{ch}</span>
        ),
      )}
    </span>
  );
}

/* ---------- new coins row ---------- */

function NewCoinRow({ token, thresholdMicro }: { token: TokenListItem; thresholdMicro: number }) {
  const router = useRouter();
  const creatorAddr = token.creator ?? token.address;
  const cap = (Number(token.current_price) / 1e6) * token.market.solUsd * DEFAULT_TOKEN_SUPPLY;
  const progress = curveProgress(token, thresholdMicro);
  const launched = new Date(token.first_seen_at);
  const age = Number.isNaN(launched.getTime())
    ? "just now"
    : formatDistanceToNow(launched, { addSuffix: true });
  const activity = token.trade_count_24h ?? 0;

  return (
    <Link
      href={`/token/${token.address}`}
      className="grid grid-cols-[minmax(240px,1fr)_140px_120px_110px_90px] items-center border-b border-[var(--color-border-soft)] px-4 py-2.5 transition-colors last:border-b-0 hover:bg-[var(--color-bg-page)]"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="h-9 w-9 shrink-0 overflow-hidden rounded-[5px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)]">
          {token.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={token.image} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full items-center justify-center text-xs text-[var(--color-text-subtle)]">
              {token.symbol?.slice(0, 1) ?? "?"}
            </span>
          )}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{token.name ?? "Unknown"}</p>
            <span className="shrink-0 font-mono text-[10px] uppercase text-[var(--color-text-subtle)]">[{token.symbol ?? "TKN"}]</span>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              router.push(`/creator/${creatorAddr}`);
            }}
            className="relative z-10 block max-w-full truncate text-left font-mono text-[10px] text-[var(--color-text-subtle)] transition-colors hover:text-[var(--color-accent-strong)]"
            title="View creator"
          >
            by {truncate(creatorAddr, 4)}
          </button>
        </div>
      </div>
      <span className="mono text-right text-[13px] font-semibold text-[var(--color-text-primary)]">{formatUsd(cap)}</span>
      <div className="flex items-center justify-end gap-2">
        <div className="h-1 w-14 overflow-hidden rounded-full bg-[var(--color-bg-hover)]">
          <span
            className={`block h-full rounded-full ${token.graduated ? "bg-[#8ab4ff]" : "bg-[var(--color-accent-solid)]"}`}
            style={{ width: `${progress ?? 0}%` }}
          />
        </div>
        <span className="mono w-7 text-right text-[11px] text-[var(--color-text-muted)]">
          {token.graduated ? "AMM" : progress == null ? "·" : `${progress.toFixed(0)}%`}
        </span>
      </div>
      <span className="text-right text-[12px] text-[var(--color-text-muted)]">{age}</span>
      <span className="mono text-right text-[12px] text-[var(--color-text-secondary)]">{activity} tx</span>
    </Link>
  );
}

function EmptyRail({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[236px] flex-1 items-center justify-center rounded-[8px] border border-dashed border-[var(--color-border-soft)] px-6 text-center text-sm text-[var(--color-text-subtle)]">
      {children}
    </div>
  );
}

/* ---------- formatting ---------- */

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  return Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

// Odometer wants a plain grouped number with a leading $ so each digit boxes up.
function usdOdo(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  const rounded = Math.round(value);
  return "$" + rounded.toLocaleString("en-US");
}

function truncate(value: string, size: number): string {
  return value.length <= size * 2 ? value : `${value.slice(0, size)}…${value.slice(-size)}`;
}
