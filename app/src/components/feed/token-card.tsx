"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type MouseEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import { ArrowUpRight, Check, CopySimple } from "@phosphor-icons/react";
import type { TokenListItem } from "@/lib/api";
import { DEFAULT_TOKEN_SUPPLY } from "@/lib/chain-config";

interface TokenCardProps { token: TokenListItem }

export function TokenCard({ token }: TokenCardProps) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const creatorAddr = token.creator ?? token.address;

  function openCreator(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    router.push(`/creator/${creatorAddr}`);
  }
  const change = getChange(token);
  const solUsd = token.market.solUsd;
  const marketCapUsd = (Number(token.current_price) / 1e6) * DEFAULT_TOKEN_SUPPLY * solUsd;
  const volumeUsd = (Number(token.volume_24h) / 1_000_000) * solUsd;

  async function copyTokenAddress(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    await navigator.clipboard.writeText(token.mint);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <Link href={`/token/${token.address}`} className="block min-w-0">
      <article className="group rounded-[10px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)]/80 p-3 transition-colors hover:border-[var(--color-border)]">
        {/* Identity row */}
        <div className="flex items-center gap-2.5">
          <div className="h-11 w-11 shrink-0 overflow-hidden rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)]">
            {token.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={token.image} alt={token.symbol ?? "token"} className="h-full w-full object-cover" />
            ) : <div className="flex h-full w-full items-center justify-center text-sm text-[var(--color-text-muted)]">{token.symbol?.slice(0, 1)}</div>}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <p className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--color-text-primary)]">{token.name ?? "Unknown Token"}</p>
              {change != null && (
                <span className={`mono shrink-0 text-[11px] font-semibold ${change >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}`}>
                  {change >= 0 ? "+" : ""}{change.toFixed(1)}%
                </span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1">
              <span className="truncate font-mono text-[11px] text-[var(--color-text-muted)]">${token.symbol ?? "TOKEN"}</span>
              <button
                type="button"
                onClick={copyTokenAddress}
                aria-label="Copy token address"
                title={copied ? "Copied" : "Copy token address"}
                className="relative z-10 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--color-text-subtle)] transition-colors hover:text-[var(--color-text-primary)]"
              >
                {copied ? <Check size={11} weight="bold" /> : <CopySimple size={11} />}
              </button>
              <span
                className={`ml-auto shrink-0 rounded-[3px] border px-1.5 py-0.5 font-display text-[9px] font-semibold uppercase tracking-[0.1em] ${
                  token.graduated ? "border-[#26323f] bg-[#141b24] text-[#8ab4ff]" : "border-[var(--color-border-soft)] bg-[var(--color-bg-page)] text-[var(--color-text-muted)]"
                }`}
              >
                {token.graduated ? "AMM" : "Curve"}
              </span>
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="mt-3 flex items-center justify-between rounded-[7px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)]/80 px-3 py-2">
          <Metric label="MC" value={formatUsd(marketCapUsd)} />
          <span className="h-6 w-px bg-[var(--color-bg-hover)]" />
          <Metric label="24h Vol" value={formatUsd(volumeUsd)} align="right" />
        </div>

        {/* Footer */}
        <div className="mt-2 flex items-center justify-between text-[10px] text-[var(--color-text-subtle)]">
          <button
            type="button"
            onClick={openCreator}
            className="relative z-10 truncate transition-colors hover:text-[var(--color-accent-strong)]"
            title="View creator"
          >
            by {truncate(creatorAddr, 4)}
          </button>
          <span className="flex items-center gap-1">
            {formatAge(token.first_seen_at)}
            <ArrowUpRight size={12} className="opacity-0 transition-opacity group-hover:opacity-100" />
          </span>
        </div>
      </article>
    </Link>
  );
}

function Metric({ label, value, align = "left" }: { label: string; value: string; align?: "left" | "right" }) {
  return (
    <div className={align === "right" ? "text-right" : ""}>
      <p className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-subtle)]">{label}</p>
      <p className="mono mt-0.5 text-[13px] font-semibold text-[var(--color-text-primary)]">{value}</p>
    </div>
  );
}
function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  return Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}
function getChange(token: TokenListItem): number | null { return token.price_change_24h; }
function formatAge(value: string): string { const date = new Date(value); return isNaN(date.getTime()) ? "just now" : formatDistanceToNow(date, { addSuffix: true }); }
function truncate(value: string, size: number): string { return value.length <= size * 2 ? value : `${value.slice(0, size)}...${value.slice(-size)}`; }
