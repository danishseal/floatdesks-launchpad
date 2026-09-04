"use client";

/**
 * HornLivePools - the "Live Horns" explorer: every graduated LP that actually
 * has a Horn attached on-chain, with its REAL current fee, a live decay-window
 * countdown, its skim/split, and pool liquidity. One shared 1s clock drives all
 * the timers together.
 *
 * A time-limited Horn (Fee Decay) drops out of the LIVE list the moment its
 * window completes, and moves under a "History" toggle: a plain list, each row
 * linking out to that Horn on the block explorer. Non-time-limited Horns (e.g.
 * Dynamic Fee) stay live indefinitely.
 *
 * HONESTY: every figure is read from chain (the AMM pool hook + the horn's own
 * config). A pool with no horn never renders, so until coins graduate WITH a
 * horn this is an honest empty state, never a fabricated row.
 */

import { useMemo, useState, useEffect } from "react";
import Link from "next/link";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { useQueries } from "@tanstack/react-query";
import { useTokens } from "@/hooks/use-tokens";
import type { TokenListItem } from "@/lib/api";
import { explorerUrl } from "@/lib/floorlaunch/config";
import {
  loadTokenHorn,
  loadDecayConfig,
  useDynfeeConfig,
  decayFeeBpsAt,
  type AttachedHorn,
  type DecayConfig,
} from "@/hooks/use-token-horn";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const pct = (v: number) => `${v.toFixed(2)}%`;

function usd(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "-";
  return Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: v >= 1000 ? "compact" : "standard",
    maximumFractionDigits: v < 1 ? 4 : 2,
  }).format(v);
}

/** One shared per-second clock (unix seconds) so every row's timer ticks together. */
function useNowSec(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

type Row = {
  token: TokenListItem;
  horn: AttachedHorn;
  decayCfg?: DecayConfig;
  /** A time-limited horn whose window has elapsed. */
  completed: boolean;
};

export function HornLivePools() {
  const { data: tokens, isLoading } = useTokens();
  const nowSec = useNowSec();
  const [showHistory, setShowHistory] = useState(false);

  const graduated = useMemo(() => (tokens ?? []).filter((t) => t.graduated), [tokens]);

  // Batch the attach read for every graduated pool (shares react-query cache
  // with each token page's tracker, so no duplicate fetches).
  const attachQueries = useQueries({
    queries: graduated.map((t) => ({
      queryKey: ["token-horn", t.address, t.graduated],
      queryFn: () => loadTokenHorn(t),
      staleTime: 180_000,
    })),
  });

  const attached = useMemo(
    () =>
      graduated
        .map((token, i) => ({ token, horn: attachQueries[i]?.data }))
        .filter((r): r is { token: TokenListItem; horn: AttachedHorn } =>
          Boolean(r.horn?.attached && r.horn.address),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graduated, attachQueries.map((q) => q.data?.slug ?? "").join(",")],
  );

  // Fee Decay configs (drive both the live fee and the completed/active split).
  const decayHorns = useMemo(() => attached.filter((r) => r.horn.slug === "decay"), [attached]);
  const decayQueries = useQueries({
    queries: decayHorns.map((r) => ({
      queryKey: ["decay-config", r.horn.address],
      queryFn: () => loadDecayConfig(r.horn.address as string),
      staleTime: 60_000,
    })),
  });
  const decayByAddr = useMemo(() => {
    const m = new Map<string, DecayConfig>();
    decayHorns.forEach((r, i) => {
      const c = decayQueries[i]?.data;
      if (c && r.horn.address) m.set(r.horn.address, c);
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decayHorns, decayQueries.map((q) => q.data?.launchTime ?? 0).join(",")]);

  const rows: Row[] = attached.map((r) => {
    const decayCfg = r.horn.slug === "decay" ? decayByAddr.get(r.horn.address as string) : undefined;
    const completed = decayCfg ? nowSec >= decayCfg.launchTime + decayCfg.decaySeconds : false;
    return { ...r, decayCfg, completed };
  });
  const active = rows.filter((r) => !r.completed);
  const history = rows.filter((r) => r.completed);

  const resolving = attachQueries.some((q) => q.isLoading);

  return (
    <section className="rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-bg-page)]/80 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-[16px] font-bold tracking-tight text-[var(--color-text-primary)]">Live Horns</h2>
          <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
            Graduated pools running a Horn right now, with their real fee and window.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-[4px] border border-[var(--color-border-soft)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
            {active.length} live
          </span>
          {history.length > 0 ? (
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              className={`rounded-[4px] border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                showHistory
                  ? "border-[#3a3a42] bg-[var(--color-bg-surface)] text-[var(--color-text-primary)]"
                  : "border-[var(--color-border-soft)] text-[var(--color-text-muted)] hover:border-[var(--color-border)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              History {history.length}
            </button>
          ) : null}
        </div>
      </div>

      {active.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-4 py-10 text-center">
          <p className="text-[13px] text-[var(--color-text-secondary)]">
            {isLoading || resolving ? "Reading pools..." : "No pool is running a Horn yet."}
          </p>
          <p className="mt-1.5 text-[12px] text-[var(--color-text-subtle)]">
            When a coin graduates with a Horn attached, it appears here live with its fee and countdown.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b border-[var(--color-border-soft)] font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-subtle)]">
                <th className="py-2 pr-3 font-normal">Pool</th>
                <th className="py-2 pr-3 font-normal">Horn</th>
                <th className="py-2 pr-3 font-normal">Current fee</th>
                <th className="py-2 pr-3 font-normal">Window</th>
                <th className="py-2 pr-3 font-normal">Skim</th>
                <th className="py-2 pr-3 text-right font-normal">Liquidity</th>
              </tr>
            </thead>
            <tbody>
              {active.map((r) => (
                <HornPoolRow key={r.token.address} row={r} nowSec={nowSec} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Horn history: completed time-limited horns, as a list linking to the explorer. */}
      {showHistory && history.length > 0 ? (
        <div className="mt-4 border-t border-[var(--color-border-soft)] pt-4">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-subtle)]">
            Completed
          </p>
          <ul className="space-y-1">
            {history.map((r) => (
              <li key={r.token.address}>
                <a
                  href={explorerUrl("address", r.horn.address as string)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-[var(--color-bg-page)]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-[var(--color-text-secondary)]">
                      ${r.token.symbol}{" "}
                      <span className="font-normal text-[var(--color-text-subtle)]">{r.horn.name ?? r.horn.slug}</span>
                    </span>
                    <span className="block truncate text-[11px] text-[var(--color-text-subtle)]">
                      {r.decayCfg
                        ? `Decayed to base ${pct(r.decayCfg.endFeeBps / 100)}`
                        : "Window completed"}
                    </span>
                  </span>
                  <ArrowSquareOut size={13} className="shrink-0 text-[var(--color-text-subtle)]" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function HornPoolRow({ row, nowSec }: { row: Row; nowSec: number }) {
  const { token, horn, decayCfg } = row;
  const isDynfee = horn.slug === "dynfee";
  const dynfeeQ = useDynfeeConfig(isDynfee ? horn.address : null);

  let feeLabel = "-";
  let windowLabel = "Live";
  let progress: number | null = null;
  if (decayCfg) {
    feeLabel = pct(decayFeeBpsAt(decayCfg, nowSec) / 100);
    const endSec = decayCfg.launchTime + decayCfg.decaySeconds;
    progress =
      decayCfg.decaySeconds > 0
        ? clamp01((nowSec - decayCfg.launchTime) / decayCfg.decaySeconds)
        : 1;
    const mins = Math.ceil((endSec - nowSec) / 60);
    windowLabel = `~${mins}m to base ${pct(decayCfg.endFeeBps / 100)}`;
  } else if (isDynfee && dynfeeQ.data) {
    feeLabel = pct(dynfeeQ.data.baseFeeBps / 100);
    windowLabel = `Reactive, staker ${pct(dynfeeQ.data.discountFeeBps / 100)}`;
  } else if (horn.slug === "decay" || isDynfee) {
    windowLabel = "Loading schedule";
  }

  const skimLabel =
    horn.skimBps != null
      ? `${(horn.skimBps / 100).toFixed(1)}%${
          horn.ansemBps != null ? ` (${horn.ansemBps / 100}/${(horn.chanseBps ?? 0) / 100})` : ""
        }`
      : "-";
  const liquidity = usd(token.market.ammSolReserve * token.market.solUsd);

  return (
    <tr className="border-b border-[var(--color-border-soft)] text-[13px] transition-colors hover:bg-[var(--color-bg-page)]">
      <td className="py-3 pr-3">
        <Link href={`/token/${token.address}`} className="group flex items-center gap-2.5">
          {token.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={token.image} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="h-7 w-7 shrink-0 rounded-full bg-[var(--color-bg-surface)]" />
          )}
          <span className="min-w-0">
            <span className="block truncate font-semibold text-[var(--color-text-primary)] group-hover:text-[var(--color-text-primary)]">
              ${token.symbol}
            </span>
            <span className="block truncate text-[11px] text-[var(--color-text-subtle)]">{token.name}</span>
          </span>
        </Link>
      </td>
      <td className="py-3 pr-3">
        <span className="rounded-[4px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
          {horn.name ?? horn.slug ?? "Horn"}
        </span>
      </td>
      <td className="py-3 pr-3 font-mono tabular-nums text-[var(--color-text-primary)]">{feeLabel}</td>
      <td className="py-3 pr-3">
        <span className="block text-[12px] text-[var(--color-text-secondary)]">{windowLabel}</span>
        {progress != null ? (
          <span className="mt-1 block h-1 w-28 overflow-hidden rounded-full bg-[var(--color-bg-surface)]">
            <span
              className="block h-full rounded-full bg-[var(--color-accent-solid)]"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </span>
        ) : null}
      </td>
      <td className="py-3 pr-3 font-mono text-[12px] text-[var(--color-text-secondary)]">{skimLabel}</td>
      <td className="py-3 pr-3 text-right font-mono tabular-nums text-[var(--color-text-secondary)]">{liquidity}</td>
    </tr>
  );
}
