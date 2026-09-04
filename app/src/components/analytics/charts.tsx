"use client";

// Inline-SVG charts for the Analytics page. The app already ships
// lightweight-charts (for token candlesticks), but these are small aggregate
// charts, so plain SVG keeps the page dependency-free and fully theme-native.
//
// Colors follow the dataviz skill:
//   - Volume is a single series, so it uses the blue brand accent (#2563eb). A lone
//     series needs no CVD separation, only contrast vs the surface (it passes).
//   - Launches vs Graduations is a TWO-series categorical encoding -> the
//     validated dark-mode pair emerald #22a04f + violet #6f4fd0 (passes the
//     six checks against surface #161616), plus a legend + 2px gaps as
//     secondary encoding so identity is never color-alone.
//
// SVG coordinates are rounded to avoid SSR/client hydration drift.

import { useState } from "react";

const ACCENT = "#2563eb"; // brand blue, volume single series
const LAUNCHED = "#22a04f"; // emerald (validated)
const GRADUATED = "#6f4fd0"; // violet (validated)

const r2 = (n: number) => Math.round(n * 100) / 100;

function Empty({ hint }: { hint: string }) {
  return (
    <div className="flex h-[220px] flex-col items-center justify-center gap-1 text-center">
      <p className="font-mono text-[12px] text-[var(--color-text-muted)]">No activity in this window</p>
      <p className="max-w-[220px] text-[11px] leading-4 text-[var(--color-text-subtle)]">{hint}</p>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Volume over time — area + line, crosshair tooltip                          */
/* ------------------------------------------------------------------------- */

export function VolumeChart({
  points,
  fmtValue,
  fmtTime,
}: {
  points: { t: string; volumeUsd: number; tradeCount: number }[];
  fmtValue: (v: number) => string;
  fmtTime: (iso: string) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length)
    return <Empty hint="Volume plots here once trades are indexed in the selected window." />;

  const W = 720;
  const H = 220;
  const padL = 8;
  const padR = 8;
  const padT = 12;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = Math.max(1, ...points.map((p) => p.volumeUsd));
  const n = points.length;
  const x = (i: number) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const y = (v: number) => padT + plotH - (v / max) * plotH;

  const linePts = points.map((p, i) => `${r2(x(i))},${r2(y(p.volumeUsd))}`);
  const linePath = `M${linePts.join("L")}`;
  const areaPath = `M${r2(x(0))},${r2(padT + plotH)}L${linePts.join("L")}L${r2(
    x(n - 1),
  )},${r2(padT + plotH)}Z`;

  // 3 recessive gridlines
  const grid = [0.25, 0.5, 0.75, 1].map((f) => ({ f, gy: r2(padT + plotH - f * plotH) }));
  const h = hover != null ? points[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: H }}
        preserveAspectRatio="none"
        role="img"
        aria-label="Volume over time"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const rx = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(((rx - padL) / plotW) * (n - 1));
          setHover(Math.max(0, Math.min(n - 1, i)));
        }}
      >
        <defs>
          <linearGradient id="volFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ACCENT} stopOpacity="0.28" />
            <stop offset="100%" stopColor={ACCENT} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {grid.map((g) => (
          <line
            key={g.f}
            x1={padL}
            x2={W - padR}
            y1={g.gy}
            y2={g.gy}
            stroke="var(--hairline)"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        ))}
        <path d={areaPath} fill="url(#volFill)" />
        <path d={linePath} fill="none" stroke={ACCENT} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {h && hover != null && (
          <>
            <line
              x1={r2(x(hover))}
              x2={r2(x(hover))}
              y1={padT}
              y2={padT + plotH}
              stroke={ACCENT}
              strokeWidth={1}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={r2(x(hover))} cy={r2(y(h.volumeUsd))} r={4} fill={ACCENT} stroke="#161616" strokeWidth={2} />
          </>
        )}
      </svg>
      {/* value axis labels (top-left, recessive) */}
      <div className="pointer-events-none absolute left-1 top-1 font-mono text-[10px] text-[var(--color-text-subtle)]">
        {fmtValue(max)}
      </div>
      {/* time ticks */}
      <div className="mt-1 flex justify-between font-mono text-[10px] text-[var(--color-text-subtle)]">
        <span>{fmtTime(points[0].t)}</span>
        {points.length > 2 && <span>{fmtTime(points[Math.floor(n / 2)].t)}</span>}
        <span>{fmtTime(points[n - 1].t)}</span>
      </div>
      {h && hover != null && (
        <div
          className="pointer-events-none absolute top-2 z-10 rounded-lg border border-[var(--hairline-strong)] bg-[var(--color-bg-raised)] px-2.5 py-1.5 shadow-lg"
          style={{ left: `calc(${(hover / Math.max(1, n - 1)) * 100}% )`, transform: "translateX(-50%)" }}
        >
          <p className="font-mono text-[10px] text-[var(--color-text-muted)]">{fmtTime(h.t)}</p>
          <p className="mt-0.5 font-mono text-[13px] font-semibold text-[var(--color-text-primary)] tabular-nums">
            {fmtValue(h.volumeUsd)}
          </p>
          <p className="font-mono text-[10px] text-[var(--color-text-secondary)] tabular-nums">
            {h.tradeCount.toLocaleString()} trades
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Launches + graduations — grouped bars, legend, hover tooltip               */
/* ------------------------------------------------------------------------- */

export function LaunchesChart({
  points,
  fmtTime,
}: {
  points: { t: string; launched: number; graduated: number }[];
  fmtTime: (iso: string) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = points.reduce((s, p) => s + p.launched + p.graduated, 0);
  if (!points.length || total === 0)
    return (
      <>
        <Legend />
        <Empty hint="Launches and graduations appear here as tokens are created and their curves fill." />
      </>
    );

  const W = 720;
  const H = 220;
  const padL = 8;
  const padR = 8;
  const padT = 12;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = Math.max(1, ...points.map((p) => Math.max(p.launched, p.graduated)));
  const n = points.length;
  const groupW = plotW / n;
  const gap = 2;
  const barW = Math.max(2, Math.min(18, groupW / 2 - gap));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const barH = (v: number) => (v / max) * plotH;
  const rad = (bw: number) => Math.min(4, bw / 2);

  const grid = [0.5, 1].map((f) => r2(padT + plotH - f * plotH));
  const h = hover != null ? points[hover] : null;

  return (
    <div className="relative">
      <Legend />
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: H }}
        preserveAspectRatio="none"
        role="img"
        aria-label="Launches and graduations over time"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const rx = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.floor((rx - padL) / groupW);
          setHover(Math.max(0, Math.min(n - 1, i)));
        }}
      >
        {grid.map((gy, i) => (
          <line
            key={i}
            x1={padL}
            x2={W - padR}
            y1={gy}
            y2={gy}
            stroke="var(--hairline)"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        ))}
        {points.map((p, i) => {
          const gx = padL + i * groupW + (groupW - (barW * 2 + gap)) / 2;
          const active = hover === i;
          return (
            <g key={i} opacity={hover == null || active ? 1 : 0.5}>
              {p.launched > 0 && (
                <rect
                  x={r2(gx)}
                  y={r2(y(p.launched))}
                  width={r2(barW)}
                  height={r2(barH(p.launched))}
                  rx={rad(barW)}
                  fill={LAUNCHED}
                />
              )}
              {p.graduated > 0 && (
                <rect
                  x={r2(gx + barW + gap)}
                  y={r2(y(p.graduated))}
                  width={r2(barW)}
                  height={r2(barH(p.graduated))}
                  rx={rad(barW)}
                  fill={GRADUATED}
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="pointer-events-none absolute left-1 top-8 font-mono text-[10px] text-[var(--color-text-subtle)]">
        {max}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-[var(--color-text-subtle)]">
        <span>{fmtTime(points[0].t)}</span>
        {points.length > 2 && <span>{fmtTime(points[Math.floor(n / 2)].t)}</span>}
        <span>{fmtTime(points[n - 1].t)}</span>
      </div>
      {h && hover != null && (
        <div
          className="pointer-events-none absolute top-8 z-10 rounded-lg border border-[var(--hairline-strong)] bg-[var(--color-bg-raised)] px-2.5 py-1.5 shadow-lg"
          style={{
            left: `calc(${((hover + 0.5) / n) * 100}%)`,
            transform: "translateX(-50%)",
          }}
        >
          <p className="font-mono text-[10px] text-[var(--color-text-muted)]">{fmtTime(h.t)}</p>
          <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-[var(--color-text-primary)] tabular-nums">
            <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: LAUNCHED }} />
            {h.launched} launched
          </p>
          <p className="flex items-center gap-1.5 font-mono text-[11px] text-[var(--color-text-primary)] tabular-nums">
            <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: GRADUATED }} />
            {h.graduated} graduated
          </p>
        </div>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="mb-2 flex items-center gap-4 font-mono text-[11px] text-[var(--color-text-secondary)]">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: LAUNCHED }} />
        Launched
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: GRADUATED }} />
        Graduated
      </span>
    </div>
  );
}
