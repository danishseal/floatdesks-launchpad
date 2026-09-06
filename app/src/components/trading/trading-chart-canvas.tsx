"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type UTCTimestamp,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
} from "lightweight-charts";
import type { CandleResponse } from "@/lib/api";
import { DEFAULT_TOKEN_SUPPLY } from "@/lib/chain-config";
import type { ActiveIndicators } from "./indicator-toolbar";
import {
  calculateSMA,
  calculateEMA,
  calculateBollingerBands,
  calculateRSI,
  calculateMACD,
} from "@/lib/indicators";
import { RsiChart } from "./rsi-chart";
import { MacdChart } from "./macd-chart";

interface TradingChartCanvasProps {
  data: CandleResponse;
  indicators: ActiveIndicators;
  showMCap: boolean;
  chartHeight?: number;
  /**
   * Accepted because the token page passes it. The legend used to fork its
   * colours on it, one branch on design tokens and one on raw Tailwind greys
   * and blues that belong to no palette here. There is one theme, so there is
   * one legend now, and the flag no longer changes anything.
   */
  terminal?: boolean;
  solUsd?: number;
}

/**
 * The chart paints to a canvas, so it needs resolved colour strings and cannot
 * be handed `var(--token)`. The tokens are read off the document once rather
 * than the palette being written out again in hex here, which is how the price
 * candles ended up neon green and neon red on a cream page.
 *
 * `CanvasText` is the last resort for a stylesheet that never arrived, not a
 * design choice: if it ever shows, the whole page is unstyled anyway.
 */
function readPalette() {
  const root =
    typeof document === "undefined"
      ? null
      : getComputedStyle(document.documentElement);
  const token = (name: string, fallback = "CanvasText") =>
    root?.getPropertyValue(name).trim() || fallback;
  return {
    up: token("--color-positive"),
    down: token("--color-negative"),
    /** Buckets with no print in them. See the carried-forward note below. */
    quiet: token("--color-text-subtle"),
    text: token("--color-text-muted"),
    grid: token("--color-border-soft"),
    border: token("--color-border-muted"),
    crosshair: token("--color-text-subtle"),
    /** A bucket that closed where it opened. See the doji note below. */
    flat: token("--color-text-primary"),
    // Resolved, not `var(--font-sans)`: the axis labels are drawn with the
    // canvas `font` property, which does not do custom-property substitution.
    font: token("--font-sans", "sans-serif"),
    indicator: {
      sma7: token("--color-accent-solid"),
      sma25: token("--color-accent-strong"),
      sma99: token("--color-text-secondary"),
      ema7: token("--color-accent-solid"),
      ema25: token("--color-text-muted"),
      band: token("--color-border-muted"),
    },
  };
}

function formatChartPrice(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  // One decimal of K collapses a whole axis onto one label: a market opening
  // at $1,224 printed "$1.2K" on every gridline. Markets on this venue live in
  // exactly that band, opening at $1,224 and graduating at $15,001, so print
  // the number until K notation is actually buying brevity.
  if (v >= 1e5) return `$${(v / 1e3).toFixed(0)}K`;
  if (v >= 1e3) return `$${Math.round(v).toLocaleString("en-US")}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  if (v >= 0.0001) return `$${v.toFixed(6)}`;
  return `$${v.toExponential(2)}`;
}

function toLineData(
  timestamps: UTCTimestamp[],
  values: (number | null)[],
): LineData<UTCTimestamp>[] {
  const result: LineData<UTCTimestamp>[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (values[i] !== null) {
      result.push({ time: timestamps[i], value: values[i]! });
    }
  }
  return result;
}

interface LegendData {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function TradingChartCanvas({
  data,
  indicators,
  showMCap,
  chartHeight = 400,
  solUsd = 0,
}: TradingChartCanvasProps) {
  const [legend, setLegend] = useState<LegendData | null>(null);

  // Read once and held, so the mount effect and the data effect cannot end up
  // drawing against two different palettes. State rather than a ref because the
  // identity has to be stable enough to sit in a dependency array.
  const [palette] = useState(readPalette);

  // Main chart refs
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const initialChartHeightRef = useRef(chartHeight);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const overlaysRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());

  const multiplier = showMCap ? DEFAULT_TOKEN_SUPPLY : 1;

  // Pre-compute data for all indicators
  const computed = useMemo(() => {
    const priceMul = (solUsd || 1) * multiplier;
    const volMul = solUsd || 1;
    const timestamps: UTCTimestamp[] = [];
    const closes: number[] = [];
    const candleData: CandlestickData<UTCTimestamp>[] = [];
    const volumeData: HistogramData<UTCTimestamp>[] = [];

    for (const candle of data.candles) {
      // `candle.time` is already unix SECONDS, which is the unit the chart
      // wants. It used to go through `new Date(number)`, which reads a number
      // as milliseconds: every bucket landed in January 1970 and the hourly
      // spacing collapsed to 3.6 seconds, so the time axis printed the same
      // minute under every candle on the page.
      const ts = candle.time as UTCTimestamp;
      timestamps.push(ts);

      const rawOpen = (Number(candle.open) / 1e6) * priceMul;
      const rawHigh = (Number(candle.high) / 1e6) * priceMul;
      const rawLow = (Number(candle.low) / 1e6) * priceMul;
      const close = (Number(candle.close) / 1e6) * priceMul;

      // The candle's own open, not the previous candle's close.
      //
      // This used to carry the previous close forward, to stop a single-trade
      // bucket drawing as a flat doji back when the candle feed was empty and
      // every bucket had at most one print in it. Against a real series it
      // states something false: DOZE's second hour opened at $265.65 and the
      // carried open drew it from $72.53, one candle covering a move that took
      // an hour and four trades, and the legend read "O $269.60" on a candle
      // whose open was $270.24. A doji is what a bucket with one trade IS, and
      // drawing it as a line is the honest picture of that.
      const open = rawOpen;
      const high = Math.max(rawHigh, open, close);
      const low = Math.min(rawLow, open, close);

      // Did anything actually trade in this bucket, or is this one of the flat
      // ticks `toCandles` carries across a gap so the series has no holes? The
      // fill is right, but it is not a print, and drawing it in the same green
      // states a trade that did not happen. DOZE is 7 trades across 3 of its
      // 428 one-minute buckets; the other 425 are this.
      const traded = Number(candle.trades ?? 0) > 0;
      const rising = close > open;
      // A bucket that opened and closed at the same price went nowhere. Most
      // buckets on this venue hold a single print, and a single print is
      // exactly that, so painting them green put a rise on the chart that the
      // trade did not contain. They take the neutral ink instead.
      const flat = close === open;

      closes.push(close);
      candleData.push(
        !traded
          ? {
              time: ts,
              open,
              high,
              low,
              close,
              color: palette.quiet,
              wickColor: palette.quiet,
              borderColor: palette.quiet,
            }
          : flat
          ? {
              time: ts,
              open,
              high,
              low,
              close,
              color: palette.flat,
              wickColor: palette.flat,
              borderColor: palette.flat,
            }
          : { time: ts, open, high, low, close },
      );
      volumeData.push({
        time: ts,
        value: (Number(candle.volume) / 1e6) * volMul,
        // The volume bar takes the muted ink on an unchanged bucket rather
        // than the candle's near-black, which at bar size reads as emphasis
        // on the quietest hour of the series.
        color: !traded
          ? palette.quiet
          : flat
            ? palette.text
            : rising
              ? palette.up
              : palette.down,
      });
    }

    const rsi = calculateRSI(closes, 14);
    const macd = calculateMACD(closes, 12, 26, 9);

    const printed = data.candles.reduce(
      (sum, c) => sum + Number(c.trades ?? 0),
      0,
    );
    const tradedBuckets = data.candles.filter(
      (c) => Number(c.trades ?? 0) > 0,
    ).length;

    return {
      timestamps,
      closes,
      candleData,
      volumeData,
      rsi,
      macd,
      printed,
      tradedBuckets,
    };
  }, [data, solUsd, multiplier, palette]);

  const initialLegend = useMemo<LegendData | null>(() => {
    const last = computed.candleData[computed.candleData.length - 1];
    const lastVol = computed.volumeData[computed.volumeData.length - 1];
    if (!last) return null;
    return {
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      volume: lastVol?.value ?? 0,
    };
  }, [computed]);

  // Initialize main chart on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: initialChartHeightRef.current,
      layout: {
        background: { color: "transparent" },
        textColor: palette.text,
        fontFamily: palette.font,
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: palette.border,
      },
      rightPriceScale: {
        borderColor: palette.border,
      },
      crosshair: {
        vertLine: { color: palette.crosshair },
        horzLine: { color: palette.crosshair },
      },
      localization: {
        priceFormatter: formatChartPrice,
      },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: palette.up,
      downColor: palette.down,
      borderVisible: false,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
      priceLineColor: palette.down,
      priceLineVisible: true,
      lastValueVisible: true,
      // A series with no range gives the scale nothing to spread, so it
      // labelled every gridline with the same number: a token that has only
      // its opening quote printed "$1.2K" thirteen times down the axis. Give a
      // degenerate range a band to breathe in, so the labels differ and the
      // flat line sits in the middle of it rather than filling the pane.
      autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } | null } | null) => {
        const res = original();
        const r = res?.priceRange;
        if (!r) return res;
        if (r.maxValue > r.minValue) return res;
        const v = r.maxValue;
        const pad = Math.abs(v) * 0.02 || 1;
        return { ...res, priceRange: { minValue: v - pad, maxValue: v + pad } };
      },
    });
    // No room reserved for volume, because volume has its own pane now. While
    // it was an overlay the price scale gave up its bottom to it, and the axis
    // went on labelling that reserved band by extrapolating BELOW the data: a
    // price chart printing -$400. Shrinking the margin only moved the threshold
    // (SLEEPY's low sits a tenth of the way up its own range and still went
    // negative). A separate pane removes the reservation instead of tuning it.
    candleSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.1, bottom: 0.08 },
    });
    candleSeriesRef.current = candleSeries;

    const VOLUME_PANE = 1;
    const volumeSeries = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      VOLUME_PANE,
    );
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.2, bottom: 0 },
    });
    // A quarter of the height, floored so it stays readable on a short chart.
    const panes = chart.panes();
    if (panes[VOLUME_PANE]) {
      panes[VOLUME_PANE].setHeight(Math.max(70, Math.round(initialChartHeightRef.current * 0.22)));
    }
    volumeSeriesRef.current = volumeSeries;

    // OHLCV legend on crosshair move
    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData.size) {
        setLegend(null);
        return;
      }
      const cd = param.seriesData.get(candleSeries) as
        | { open: number; high: number; low: number; close: number }
        | undefined;
      const vd = param.seriesData.get(volumeSeries) as
        | { value: number }
        | undefined;
      if (cd && "open" in cd) {
        setLegend({
          open: cd.open,
          high: cd.high,
          low: cd.low,
          close: cd.close,
          volume: vd?.value ?? 0,
        });
      }
    });

    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (!width || !chartRef.current) return;
      chartRef.current.applyOptions({ width });
      // Re-fit, or the bars keep the spacing they were given at the old width.
      // fitContent ran once after setData; every resize after that (the panel
      // opening, the drag handle, a window change) left a short series drawn
      // at its former spacing, which is why a 17 candle chart rendered as
      // slivers with dead space either side.
      chartRef.current.timeScale().fitContent();
    });
    resizeObserver.observe(containerRef.current);

    const overlays = overlaysRef.current;

    return () => {
      resizeObserver.disconnect();
      overlays.clear();
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
    // `palette` is read once into a ref, so it is stable and this still mounts
    // the chart exactly once.
  }, [palette]);

  useEffect(() => {
    chartRef.current?.applyOptions({ height: chartHeight });
  }, [chartHeight]);

  // Update chart data + overlay indicators
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !candleSeriesRef.current || !volumeSeriesRef.current) return;
    if (!computed.candleData.length) return;

    candleSeriesRef.current.setData(computed.candleData);

    // The last-value price line tracks the latest close automatically; recolor
    // it to the last candle's direction so it reads green on an up close and red
    // on a down close instead of being pinned to one color.
    const lastCandle = computed.candleData[computed.candleData.length - 1];
    if (lastCandle) {
      candleSeriesRef.current.applyOptions({
        priceLineColor:
          lastCandle.close === lastCandle.open
            ? palette.flat
            : lastCandle.close > lastCandle.open
              ? palette.up
              : palette.down,
      });
    }

    // Volume
    volumeSeriesRef.current.setData(
      indicators.volume ? computed.volumeData : [],
    );

    // Build wanted overlays
    const wanted = new Map<
      string,
      { data: LineData<UTCTimestamp>[]; color: string; width: number }
    >();

    if (indicators.sma7) {
      wanted.set("sma7", {
        data: toLineData(
          computed.timestamps,
          calculateSMA(computed.closes, 7),
        ),
        color: palette.indicator.sma7,
        width: 2,
      });
    }
    if (indicators.sma25) {
      wanted.set("sma25", {
        data: toLineData(
          computed.timestamps,
          calculateSMA(computed.closes, 25),
        ),
        color: palette.indicator.sma25,
        width: 2,
      });
    }
    if (indicators.sma99) {
      wanted.set("sma99", {
        data: toLineData(
          computed.timestamps,
          calculateSMA(computed.closes, 99),
        ),
        color: palette.indicator.sma99,
        width: 2,
      });
    }
    if (indicators.ema7) {
      wanted.set("ema7", {
        data: toLineData(
          computed.timestamps,
          calculateEMA(computed.closes, 7),
        ),
        color: palette.indicator.ema7,
        width: 2,
      });
    }
    if (indicators.ema25) {
      wanted.set("ema25", {
        data: toLineData(
          computed.timestamps,
          calculateEMA(computed.closes, 25),
        ),
        color: palette.indicator.ema25,
        width: 2,
      });
    }
    if (indicators.bollinger) {
      const bb = calculateBollingerBands(computed.closes, 20, 2);
      wanted.set("bollUpper", {
        data: toLineData(computed.timestamps, bb.upper),
        color: palette.indicator.band,
        width: 1,
      });
      wanted.set("bollMiddle", {
        data: toLineData(computed.timestamps, bb.middle),
        color: palette.indicator.sma25,
        width: 1,
      });
      wanted.set("bollLower", {
        data: toLineData(computed.timestamps, bb.lower),
        color: palette.indicator.band,
        width: 1,
      });
    }

    // Remove stale overlays
    for (const [name, series] of overlaysRef.current) {
      if (!wanted.has(name)) {
        chart.removeSeries(series);
        overlaysRef.current.delete(name);
      }
    }

    // Add or update overlays
    for (const [name, config] of wanted) {
      let series = overlaysRef.current.get(name);
      if (!series) {
        series = chart.addSeries(LineSeries, {
          color: config.color,
          lineWidth: config.width as 1 | 2 | 3 | 4,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        overlaysRef.current.set(name, series);
      }
      series.setData(config.data);
    }

    // Fill the pane, and keep the bars wide while doing it.
    //
    // fitContent alone leaves a short series narrow: it fits the DATA, and a
    // handful of candles fitted to a wide pane still get whatever spacing the
    // chart last had. Pinning the logical range to the series makes the bars
    // span the full width, so a market with 17 candles draws 17 wide candles
    // rather than a cluster of slivers.
    const bars = computed.candleData.length;
    chart.timeScale().fitContent();
    if (bars > 0) {
      // Half a bar of air at each end. Ending exactly at bars - 0.5 puts the
      // newest candle flush against the price axis, which clipped it: the
      // trade showed in the volume pane and its body did not.
      chart.timeScale().setVisibleLogicalRange({ from: -1, to: bars });
    }
  }, [computed, indicators, palette]);

  const displayedLegend = legend ?? initialLegend;
  const up = displayedLegend ? displayedLegend.close > displayedLegend.open : true;
  const unchanged = displayedLegend
    ? displayedLegend.close === displayedLegend.open
    : false;
  const change = displayedLegend ? displayedLegend.close - displayedLegend.open : 0;
  const changePct =
    displayedLegend && displayedLegend.open !== 0
      ? ((displayedLegend.close - displayedLegend.open) / displayedLegend.open) * 100
      : 0;

  // What the drawn series is made of, said in the header rather than left for
  // the reader to infer from a long grey stretch. A bucket with no print in it
  // is carried forward so the series has no holes; that is the right fill and
  // the wrong thing to count as activity, so both numbers are shown.
  const provenance =
    computed.candleData.length > 0
      ? `${computed.printed} ${computed.printed === 1 ? "trade" : "trades"} across ` +
        `${computed.tradedBuckets} of ${computed.candleData.length} candles` +
        (computed.candleData.length > computed.tradedBuckets
          ? `, ${computed.candleData.length - computed.tradedBuckets} carried forward`
          : "")
      : null;

  return (
    <div>
      {/* OHLCV legend. Sans throughout, tabular figures so the numbers do not
          shuffle sideways as the crosshair moves across the series. */}
      <div className="flex min-h-[28px] flex-wrap items-center gap-x-3 gap-y-0.5 px-3 pt-2 pb-0.5 text-[11px] tabular-nums">
        <span className="text-[11px] font-medium text-[var(--color-text-muted)]">
          {showMCap ? "Market Cap" : "Price"} (USD)
        </span>
        {displayedLegend && (
          <>
            {(
              [
                ["O", displayedLegend.open],
                ["H", displayedLegend.high],
                ["L", displayedLegend.low],
                ["C", displayedLegend.close],
              ] as const
            ).map(([key, value]) => (
              <span key={key}>
                <span className="text-[var(--color-text-muted)]">{key} </span>
                <span className="font-medium text-[var(--color-text-primary)]">
                  {formatChartPrice(value)}
                </span>
              </span>
            ))}
            {/* A bucket that closed where it opened did not rise, so it is
                not reported in the rise colour with a plus in front of it. */}
            <span
              className={
                unchanged
                  ? "font-medium text-[var(--color-text-secondary)]"
                  : up
                    ? "font-medium text-[var(--color-positive)]"
                    : "font-medium text-[var(--color-negative)]"
              }
            >
              {unchanged
                ? "unchanged"
                : `${up ? "+" : "-"}${formatChartPrice(Math.abs(change))} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`}
            </span>
            {indicators.volume && (
              <span>
                <span className="text-[var(--color-text-muted)]">Volume </span>
                <span className="text-[var(--color-text-secondary)]">
                  {formatChartPrice(displayedLegend.volume)}
                </span>
              </span>
            )}
          </>
        )}
      </div>
      {provenance && (
        <div className="px-3 pb-1.5 text-[10px] text-[var(--color-text-muted)]">
          {provenance}
        </div>
      )}

      <div ref={containerRef} className="w-full" />

      {indicators.rsi && (
        <RsiChart timestamps={computed.timestamps} values={computed.rsi} />
      )}
      {indicators.macd && (
        <MacdChart timestamps={computed.timestamps} macd={computed.macd} />
      )}
    </div>
  );
}
