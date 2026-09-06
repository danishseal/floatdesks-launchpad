"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useCandles } from "@/hooks/use-candles";
import type { Timeframe } from "@/lib/api";

/**
 * Candlesticks for one token, from the same /candles series the token page
 * draws. SVG rather than canvas because callers size this with `[&>svg]`
 * rules and expect the root element to be the svg itself.
 *
 * Two things this refuses to do, because both are how the polyline it replaces
 * was lying:
 *
 * 1. Draw a shape over a series with no movement in it. Most launches on this
 *    venue have zero or one trade, and one trade is one price. The polyline
 *    drew that as a confident ramp into a long flat, with an area fill under
 *    it, tinted by the coin's 24h direction. It read as a picture of a market.
 *    It was a picture of a single number. With nothing to chart, this says so
 *    in words and draws nothing.
 *
 * 2. Colour a carried-forward bucket like a traded one. `toCandles` fills gaps
 *    with the previous close so the series has no holes, which is right, but a
 *    filled gap is not a print. DOZE is 7 trades across 3 of its 428 one-minute
 *    buckets. Drawing the other 425 in the same green asserts 425 trades that
 *    never happened, so they are drawn muted, as the flat carried ticks they
 *    are, and the count is stated above the series.
 */

/** Below this height there is no room for a sentence, so the states go visual. */
const COMPACT_HEIGHT = 56;

interface CandlePreviewChartProps {
  address: string;
  /**
   * Accepted for compatibility with the callers that already pass it. The
   * candles carry their own direction per bucket, so a series-wide "up" flag
   * borrowed from the 24h change would only ever disagree with them.
   */
  up?: boolean;
  width?: number;
  height?: number;
  timeframe?: Timeframe;
  /**
   * Multiply every axis label by this before formatting. The series itself is
   * unchanged: market cap is price times a fixed supply, so the shape is
   * identical and only the numbers on the axis differ. Pass the supply to read
   * the chart in market cap, which is how the home preview and the token page
   * are both denominated. Default 1, which is price per token.
   */
  labelScale?: number;
}

interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Prints in this bucket. Zero means the bucket was carried forward. */
  n: number;
}

/** USD per token. Same shape the header uses, so the two agree on screen. */
function priceLabel(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "-";
  if (v >= 1000) return `$${Math.round(v).toLocaleString("en-US")}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  return `$${Number(v.toPrecision(2)).toExponential(1)}`;
}

/** Green up, red down, neutral ink for a bucket that closed where it opened. */
function candleInk(k: { rising: boolean; flat: boolean }): string {
  if (k.flat) return "var(--color-text-primary)";
  return k.rising ? "var(--color-positive)" : "var(--color-negative)";
}

/** What the series actually contains, before anything is drawn from it. */
function readSeries(bars: Bar[]) {
  let prints = 0;
  let tradedBuckets = 0;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const b of bars) {
    prints += b.n;
    if (b.n > 0) tradedBuckets += 1;
    if (b.l < low) low = b.l;
    if (b.h > high) high = b.h;
  }
  return {
    prints,
    tradedBuckets,
    low,
    high,
    /** A range of exactly zero is one price repeated, not a trend. */
    moved: high > low,
  };
}

export function CandlePreviewChart({
  address,
  width = 72,
  height = 26,
  timeframe = "1h",
  labelScale = 1,
}: CandlePreviewChartProps) {
  const { data, isLoading, error } = useCandles(address, timeframe);

  // The svg is stretched to its container by the caller's CSS, so its own
  // attributes are only the starting guess. Measuring it keeps the viewBox at
  // the rendered size, which keeps hairlines at one pixel and label text at
  // the size it says it is rather than whatever the scale factor makes of it.
  const svgRef = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState({ w: width, h: height });
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const bars = useMemo<Bar[]>(
    () =>
      (data?.candles ?? []).map((k) => ({
        t: Number(k.time),
        o: Number(k.open),
        h: Number(k.high),
        l: Number(k.low),
        c: Number(k.close),
        n: Number(k.trades ?? 0),
      })),
    [data],
  );

  const large = box.h >= COMPACT_HEIGHT;
  const gutter = large ? 52 : 0;
  const padY = large ? 20 : 3;
  const innerW = Math.max(1, box.w - gutter - 2);
  const innerH = Math.max(1, box.h - padY * 2);

  const drawn = useMemo(() => {
    if (!bars.length) return null;
    const facts = readSeries(bars);
    // A series with no range still draws. It used to be refused here, on the
    // same reasoning the main chart used, and the same answer applies: a curve
    // quotes a real price from the moment it launches, so the series opens at
    // that quote and a market with one trade has a move to show. A token with
    // no trades at all draws its opening quote as a flat line, which is true.

    // Enough buckets to fill the width without drawing sub-pixel candles.
    const capacity = Math.max(12, Math.min(200, Math.floor(innerW / 4)));
    let window = bars.slice(-capacity);
    let stats = readSeries(window);
    // Every window ends at the latest bucket, so it can end in a long carried
    // tail with no range of its own. Widen to the whole series rather than
    // report no movement on a token that has some. Widening rather than just
    // rescaling keeps the caption counting the candles that are drawn: a
    // caption about buckets the reader cannot see is the same class of claim
    // this component exists to stop making.
    if (!stats.moved) {
      window = bars;
      stats = facts;
    }
    const lo = stats.low;
    const hi = stats.high;
    const flat = hi === lo;
    const span = hi - lo || 1;

    const slot = innerW / window.length;
    const body = Math.max(1, Math.min(slot * 0.6, 26));
    // A flat series has no range to scale into, and the plain formula would
    // pin it to the top of the box. Centre it instead.
    const y = (v: number) =>
      flat ? padY + innerH / 2 : padY + ((hi - v) / span) * innerH;

    const candles = window.map((b, i) => {
      const cx = 1 + slot * (i + 0.5);
      const top = y(Math.max(b.o, b.c));
      const bottom = y(Math.min(b.o, b.c));
      return {
        key: `${b.t}-${i}`,
        cx,
        x: cx - body / 2,
        w: body,
        // A one-print bucket has open === close. That is a doji, and a flat
        // line is what a doji looks like, so it is not padded out into a body
        // that would imply a range it did not have. Two pixels rather than
        // one only so a traded doji cannot be mistaken for a carried tick,
        // which is drawn at one pixel and half faded.
        y: top,
        h: Math.max(b.n > 0 ? 2 : 1, bottom - top),
        wickTop: y(b.h),
        wickBottom: y(b.l),
        traded: b.n > 0,
        // A bucket that opened and closed at the same price went nowhere, so
        // it is drawn in the neutral ink. Most buckets on this venue are a
        // single print, and painting those green would put a rise on the
        // chart that the trade did not contain: MARIO's last print is a doji
        // at a twentieth of its high.
        rising: b.c > b.o,
        flat: b.c === b.o,
      };
    });

    return {
      candles,
      lo,
      hi,
      stats,
      drawnCount: window.length,
      carried: window.length - stats.tradedBuckets,
    };
  }, [bars, innerW, innerH, padY]);

  // What the chart area says when there is nothing to draw. Each of these is a
  // different claim and they are kept apart on purpose: a source that could not
  // be read, a market that has never printed, and a market that printed once
  // are three different facts about a token.
  let vacant: { head: string; note: string } | null = null;
  if (error) {
    vacant = {
      head: "Price history unavailable",
      note: "The chain's trade logs could not be read",
    };
  } else if (isLoading && !bars.length) {
    vacant = { head: "Reading trade logs", note: "" };
  } else if (!bars.length) {
    vacant = {
      head: "No trades yet",
      note: "This market has not printed a price",
    };
  }

  const caption = drawn
    ? `${drawn.stats.prints} ${drawn.stats.prints === 1 ? "trade" : "trades"} across ${drawn.stats.tradedBuckets} of ${drawn.drawnCount} candles` +
      (drawn.carried > 0 ? `, ${drawn.carried} carried forward` : "")
    : vacant
      ? `${vacant.head}${vacant.note ? `. ${vacant.note}` : ""}`
      : "";

  const sans = { fontFamily: "var(--font-sans)" } as const;

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      viewBox={`0 0 ${box.w} ${box.h}`}
      role="img"
      aria-label={caption}
    >
      <title>{caption}</title>

      {vacant && (
        <>
          {/* A dashed rule, never a solid one. At table size there is no room
              for the sentence, so the line itself has to read as absence. */}
          <line
            x1={0}
            y1={box.h / 2}
            x2={box.w}
            y2={box.h / 2}
            stroke="var(--color-text-subtle)"
            strokeWidth={1}
            strokeDasharray="3 4"
            opacity={0.5}
          />
          {large && (
            <>
              {/* The dashed rule runs behind the sentence, so it is masked
                  out under it rather than struck through the words. */}
              <rect
                x={box.w / 2 - Math.min(box.w - 8, 440) / 2}
                y={box.h / 2 - 22}
                width={Math.min(box.w - 8, 440)}
                height={44}
                fill="var(--color-bg-surface)"
              />
              <text
                x={box.w / 2}
                y={vacant.note ? box.h / 2 - 2 : box.h / 2 + 4}
                textAnchor="middle"
                style={sans}
                fontSize={13}
                fontWeight={500}
                fill="var(--color-text-secondary)"
              >
                {vacant.head}
              </text>
              {vacant.note && (
                <text
                  x={box.w / 2}
                  y={box.h / 2 + 15}
                  textAnchor="middle"
                  style={sans}
                  fontSize={11}
                  fill="var(--color-text-muted)"
                >
                  {vacant.note}
                </text>
              )}
            </>
          )}
        </>
      )}

      {drawn && (
        <>
          {/* Hairlines at the extremes so the two labels are attached to
              something and the empty middle reads as range, not as a gap in
              the drawing. */}
          {large &&
            [padY, padY + innerH].map((y) => (
              <line
                key={y}
                x1={0}
                y1={y}
                x2={box.w - gutter}
                y2={y}
                stroke="var(--color-border-soft)"
                strokeWidth={1}
                strokeDasharray="2 4"
              />
            ))}
          {drawn.candles.map((k) =>
            k.traded ? (
              <g
                key={k.key}
                fill={candleInk(k)}
                stroke={candleInk(k)}
              >
                <line
                  x1={k.cx}
                  y1={k.wickTop}
                  x2={k.cx}
                  y2={k.wickBottom}
                  strokeWidth={1}
                />
                <rect x={k.x} y={k.y} width={k.w} height={k.h} stroke="none" />
              </g>
            ) : (
              // No print in this bucket. Drawn as the flat carried tick it is,
              // in the muted ink, so a quiet stretch cannot be mistaken for a
              // run of trades that held their price.
              <rect
                key={k.key}
                x={k.x}
                y={k.y}
                width={k.w}
                height={1}
                fill="var(--color-text-subtle)"
                opacity={0.4}
              />
            ),
          )}

          {large && (
            <>
              <text
                x={box.w - gutter + 6}
                y={padY + 4}
                style={sans}
                fontSize={10}
                fill="var(--color-text-muted)"
              >
                {priceLabel((drawn.hi / 1e6) * labelScale)}
              </text>
              <text
                x={box.w - gutter + 6}
                y={padY + innerH}
                style={sans}
                fontSize={10}
                fill="var(--color-text-muted)"
              >
                {priceLabel((drawn.lo / 1e6) * labelScale)}
              </text>
              <text
                x={1}
                y={11}
                style={sans}
                fontSize={10}
                fill="var(--color-text-muted)"
              >
                {caption}
              </text>
            </>
          )}
        </>
      )}
    </svg>
  );
}
