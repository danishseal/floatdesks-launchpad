"use client";

/**
 * HornLiveTracker - a per-pool readout of the coin's Horn(s), under the chart.
 *
 * HONEST, no simulation ever:
 *  - Graduated + a Horn attached: reads the AMM pool's hook and the horn's own
 *    on-chain config. Fee Decay (its fee changes over time) draws a live decay
 *    graph computed from launch_time / decay_seconds / start / end + wall-clock;
 *    Dynamic Fee shows its real base/discount tiers with NO time graph; anything
 *    else just names the horn. A Horn only draws a graph when its value actually
 *    changes over time.
 *  - Not graduated: shows the creator's SELECTED Horns (read from the launchpad
 *    curve) with a note that they activate at migration. No graph.
 *  - Graduated with no hook: says so plainly.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import type { TokenListItem } from "@/lib/api";
import { HORNS, type Horn } from "@/lib/horns-catalog";
import {
  useTokenHorn,
  useTokenCurveHorn,
  useDecayConfig,
  useDynfeeConfig,
  decayFeeBpsAt,
  type DecayConfig,
  type DynfeeConfig,
} from "@/hooks/use-token-horn";

type Readout = {
  headline: string;
  headlineLabel: string;
  caption: string;
  settled: boolean;
  /** 0..1 x-position of the "now" marker (graph only). */
  marker: number;
  /** Normalized height (0..1) of the curve at track x in [0,1] (graph only). */
  sample: (x: number) => number;
  startLabel: string;
  endLabel: string;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const pct = (v: number) => `${v.toFixed(2)}%`;
const ACCENT = "#2563eb";

// Horns whose fee changes over time get a live graph. Everything else shows its
// config without a fabricated curve.
const GRAPH_SLUGS = new Set(["decay"]);

function hornMeta(slug: string | null): Horn | undefined {
  return slug ? HORNS.find((h) => h.slug === slug) : undefined;
}
function hornArt(slug: string): string {
  return `/horns/art/${slug}.png`;
}

/* ------------------------------------------------------------------ */
/* Real (on-chain) readouts                                           */
/* ------------------------------------------------------------------ */

// Fee Decay, from the horn's real config + wall-clock time.
function realDecayReadout(cfg: DecayConfig, nowSec: number): Readout {
  const endSec = cfg.launchTime + cfg.decaySeconds;
  const feeBps = decayFeeBpsAt(cfg, nowSec);
  const settled = nowSec >= endSec;
  const u = cfg.decaySeconds > 0 ? clamp01((nowSec - cfg.launchTime) / cfg.decaySeconds) : 1;
  const remainingMin = Math.ceil(Math.max(0, endSec - nowSec) / 60);
  const startPct = cfg.startFeeBps / 100;
  const endPct = cfg.endFeeBps / 100;
  const range = cfg.startFeeBps - cfg.endFeeBps;
  return {
    headline: pct(feeBps / 100),
    headlineLabel: "Current fee",
    caption: settled
      ? `Settled to base ${pct(endPct)}`
      : `Decaying to ${pct(endPct)} base, ~${remainingMin}m remaining`,
    settled,
    marker: u,
    sample: (x) => {
      const f = cfg.startFeeBps + (cfg.endFeeBps - cfg.startFeeBps) * x;
      return range !== 0 ? clamp01((f - cfg.endFeeBps) / range) : 0;
    },
    startLabel: `${pct(startPct)} launch`,
    endLabel: `${pct(endPct)} base`,
  };
}

// Dynamic Fee: real base / discount tiers. Not time-varying, so no graph.
function realDynfeeReadout(cfg: DynfeeConfig): Readout {
  const basePct = cfg.baseFeeBps / 100;
  const discPct = cfg.discountFeeBps / 100;
  const minAnsem = Number(cfg.minAnsemStake) / 1e6;
  const minLabel = Number.isFinite(minAnsem)
    ? minAnsem.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : "-";
  return {
    headline: pct(basePct),
    headlineLabel: "Base fee",
    caption: `Floatdesk stakers pay ${pct(discPct)} with ${minLabel} Floatdesk staked`,
    settled: true,
    marker: 1,
    sample: () => 0,
    startLabel: `${pct(discPct)} staker`,
    endLabel: `${pct(basePct)} base`,
  };
}

// Attached horn whose numeric readout we cannot compute yet: names it, no fake value.
function liveMinimalReadout(name: string | null): Readout {
  return {
    headline: "-",
    headlineLabel: name ?? "Attached horn",
    caption: "Attached to this pool. Live schedule loading.",
    settled: true,
    marker: 0,
    sample: () => 0,
    startLabel: "on-chain",
    endLabel: "live",
  };
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export function HornLiveTracker({ token }: { token: TokenListItem }) {
  // Graduated pools: the attached hook is the source of truth.
  const attachedQ = useTokenHorn(token);
  const attached = attachedQ.data?.attached ? attachedQ.data : null;
  const attachedSlug = attached?.slug ?? null;

  // Pre-graduation: the creator's selected Horns from the launchpad curve.
  const curveHornQ = useTokenCurveHorn(token);
  const selectedSlugs = curveHornQ.data?.slugs ?? [];

  const decayQ = useDecayConfig(attachedSlug === "decay" ? attached!.address : null);
  const dynfeeQ = useDynfeeConfig(attachedSlug === "dynfee" ? attached!.address : null);

  // Real wall clock; only ticks while a live decay horn needs a per-second update.
  const decayLive = Boolean(attachedSlug === "decay" && decayQ.data);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    if (!decayLive) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const id = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [decayLive]);

  let readout: Readout | null = null;
  if (attachedSlug === "decay" && decayQ.data) {
    readout = realDecayReadout(decayQ.data, mounted ? nowSec : decayQ.data.launchTime);
  } else if (attachedSlug === "dynfee" && dynfeeQ.data) {
    readout = realDynfeeReadout(dynfeeQ.data);
  } else if (attached) {
    readout = liveMinimalReadout(attached.name);
  }
  const showGraph = Boolean(attachedSlug && GRAPH_SLUGS.has(attachedSlug) && readout);

  const meta = hornMeta(attachedSlug);
  const stateLabel = attached ? "live" : token.graduated ? "none" : "pending";
  const subtitle = attached
    ? meta
      ? `${meta.name} - ${meta.tagline}`
      : attached.name ?? "Attached horn"
    : token.graduated
      ? "Plain AMM pool, no Horn"
      : "Applied when the coin migrates";

  return (
    <section className="border-t border-[var(--color-border-soft)] px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-[13px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-primary)]">
            Horn tracker
          </h3>
          <p className="mt-1 truncate text-[11px] leading-4 text-[var(--color-text-muted)]">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {decayLive && readout && !readout.settled ? (
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: ACCENT, boxShadow: `0 0 6px ${ACCENT}` }}
            />
          ) : null}
          <span
            className={`rounded-[4px] border px-2 py-0.5 font-mono text-[10px] ${
              attached
                ? "border-[#2f7d3f] bg-[var(--color-accent-solid)]/10 text-[var(--color-accent-strong)]"
                : "border-[var(--color-border-soft)] text-[var(--color-text-muted)]"
            }`}
          >
            {stateLabel}
          </span>
        </div>
      </div>

      {attached && readout ? (
        <LiveReadout readout={readout} showGraph={showGraph} />
      ) : token.graduated ? (
        <div className="mt-3 rounded-[10px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-4 py-6 text-center">
          <p className="text-[13px] text-[var(--color-text-secondary)]">No Horn attached to this pool.</p>
          <p className="mt-1 text-[12px] text-[var(--color-text-subtle)]">This coin trades on the plain AMM.</p>
        </div>
      ) : (
        <PendingHorns slugs={selectedSlugs} loading={curveHornQ.isLoading} />
      )}
    </section>
  );
}

function LiveReadout({ readout, showGraph }: { readout: Readout; showGraph: boolean }) {
  return (
    <div
      className={`mt-3 gap-3 rounded-[10px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] p-3 ${
        showGraph ? "grid sm:grid-cols-[minmax(0,150px)_minmax(0,1fr)]" : "block"
      }`}
    >
      <div className="flex flex-col justify-center">
        <p className="text-[9px] uppercase tracking-[0.16em] text-[var(--color-text-subtle)]">
          {readout.headlineLabel}
        </p>
        <p className="mt-1 font-mono text-[30px] font-bold leading-none tabular-nums text-[var(--color-text-primary)]">
          {readout.headline}
        </p>
        <p className="mt-2 text-[11px] leading-4 text-[var(--color-text-secondary)]">{readout.caption}</p>
        {!showGraph ? (
          <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            <span className="rounded border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-1.5 py-0.5">
              {readout.startLabel}
            </span>
            <span className="rounded border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-1.5 py-0.5">
              {readout.endLabel}
            </span>
          </div>
        ) : null}
      </div>

      {showGraph ? (
        <div className="flex flex-col justify-center">
          <TrajectoryTrack readout={readout} accent={ACCENT} />
          <div className="mt-1.5 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--color-text-subtle)]">
            <span>{readout.startLabel}</span>
            <span>{readout.endLabel}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PendingHorns({ slugs, loading }: { slugs: string[]; loading: boolean }) {
  const metas = slugs.map((s) => hornMeta(s)).filter((h): h is Horn => Boolean(h));
  return (
    <div className="mt-3 rounded-[10px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] p-4">
      <p className="text-[12px] leading-5 text-[var(--color-text-secondary)]">
        These Horns activate when the coin migrates to the AMM.
      </p>
      {metas.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          {metas.map((h) => (
            <Link
              key={h.slug}
              href="/horns"
              className="flex items-center gap-2.5 rounded-lg px-1 py-1 transition-colors hover:bg-[var(--color-bg-page)]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={hornArt(h.slug)} alt="" className="h-8 w-8 shrink-0 object-contain" />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{h.name}</span>
                <span className="block truncate text-[11px] text-[var(--color-text-subtle)]">{h.tagline}</span>
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="mt-1.5 text-[12px] text-[var(--color-text-subtle)]">
          {loading
            ? "Reading the coin's Horn selection..."
            : "The creator's Horn selection appears here once the coin is on its curve."}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Trajectory sparkline (thick line + round dot; drawn for time-varying horns) */
/* ------------------------------------------------------------------ */

function TrajectoryTrack({ readout, accent }: { readout: Readout; accent: string }) {
  const W = 100;
  const H = 40;
  const PAD = 4;
  const N = 48;

  const yFor = (h: number) => PAD + (1 - clamp01(h)) * (H - 2 * PAD);
  const pts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const x = i / N;
    pts.push(`${(x * W).toFixed(2)},${yFor(readout.sample(x)).toFixed(2)}`);
  }
  const line = `M ${pts.join(" L ")}`;
  const area = `${line} L ${W},${(H - PAD).toFixed(2)} L 0,${(H - PAD).toFixed(2)} Z`;
  const markerX = Number((clamp01(readout.marker) * W).toFixed(2));
  const markerY = Number(yFor(readout.sample(clamp01(readout.marker))).toFixed(2));

  const gradId = "hornTrackGrad";
  return (
    <div
      className="relative h-[128px] w-full"
      role="img"
      aria-label={`${readout.headlineLabel} trajectory: ${readout.caption}`}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.14" />
            <stop offset="70%" stopColor={accent} stopOpacity="0.03" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line
          x1="0"
          y1={(H - PAD).toFixed(2)}
          x2={W}
          y2={(H - PAD).toFixed(2)}
          stroke="#2a2a30"
          strokeWidth="1"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
        <path d={area} fill={`url(#${gradId})`} />
        <path
          d={line}
          fill="none"
          stroke={accent}
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {/* "now" dot in pixel space so it stays a perfect circle. */}
      <span
        className="pointer-events-none absolute h-[11px] w-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          left: `${markerX}%`,
          top: `${(markerY / H) * 100}%`,
          background: accent,
          boxShadow: `0 0 10px ${accent}, 0 0 2px ${accent}`,
          border: "2px solid #0a0a0b",
        }}
      />
    </div>
  );
}
