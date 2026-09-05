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
  terminal?: boolean;
  solUsd?: number;
}

// Indicator color palette
const COLORS: Record<string, string> = {
  sma7: "#4367d8",
  sma25: "#5b7ae0",
  sma99: "#3556be",
  ema7: "#8aa0ec",
  ema25: "#2747a7",
  bollUpper: "rgba(67, 103, 216, 0.35)",
  bollMiddle: "#4367d8",
  bollLower: "rgba(67, 103, 216, 0.35)",
};

const PRICE_UP_COLOR = "#39d98a";
const PRICE_DOWN_COLOR = "#ff646b";

function formatChartPrice(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
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
  terminal = false,
  solUsd = 0,
}: TradingChartCanvasProps) {
  const [legend, setLegend] = useState<LegendData | null>(null);

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
      const ts = Math.floor(
        new Date(candle.time).getTime() / 1000,
      ) as UTCTimestamp;
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

      closes.push(close);
      candleData.push({ time: ts, open, high, low, close });
      volumeData.push({
        time: ts,
        value: (Number(candle.volume) / 1e6) * volMul,
        color:
          close >= open
            ? "rgba(52, 211, 153, 0.55)"
            : "rgba(255, 255, 255, 0.5)",
      });
    }

    const rsi = calculateRSI(closes, 14);
    const macd = calculateMACD(closes, 12, 26, 9);

    return { timestamps, closes, candleData, volumeData, rsi, macd };
  }, [data, solUsd, multiplier]);

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
        textColor: "#9ca3af",
      },
      grid: {
        vertLines: { color: "rgba(156, 163, 175, 0.1)" },
        horzLines: { color: "rgba(156, 163, 175, 0.1)" },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: "rgba(156, 163, 175, 0.2)",
      },
      rightPriceScale: {
        borderColor: "rgba(156, 163, 175, 0.2)",
      },
      crosshair: {
        vertLine: { color: "rgba(156, 163, 175, 0.3)" },
        horzLine: { color: "rgba(156, 163, 175, 0.3)" },
      },
      localization: {
        priceFormatter: formatChartPrice,
      },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: PRICE_UP_COLOR,
      downColor: PRICE_DOWN_COLOR,
      borderVisible: false,
      wickUpColor: PRICE_UP_COLOR,
      wickDownColor: PRICE_DOWN_COLOR,
      priceLineColor: PRICE_DOWN_COLOR,
      priceLineVisible: true,
      lastValueVisible: true,
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
      if (width && chartRef.current) chartRef.current.applyOptions({ width });
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
  }, []);

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
          lastCandle.close >= lastCandle.open ? PRICE_UP_COLOR : PRICE_DOWN_COLOR,
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
        color: COLORS.sma7,
        width: 2,
      });
    }
    if (indicators.sma25) {
      wanted.set("sma25", {
        data: toLineData(
          computed.timestamps,
          calculateSMA(computed.closes, 25),
        ),
        color: COLORS.sma25,
        width: 2,
      });
    }
    if (indicators.sma99) {
      wanted.set("sma99", {
        data: toLineData(
          computed.timestamps,
          calculateSMA(computed.closes, 99),
        ),
        color: COLORS.sma99,
        width: 2,
      });
    }
    if (indicators.ema7) {
      wanted.set("ema7", {
        data: toLineData(
          computed.timestamps,
          calculateEMA(computed.closes, 7),
        ),
        color: COLORS.ema7,
        width: 2,
      });
    }
    if (indicators.ema25) {
      wanted.set("ema25", {
        data: toLineData(
          computed.timestamps,
          calculateEMA(computed.closes, 25),
        ),
        color: COLORS.ema25,
        width: 2,
      });
    }
    if (indicators.bollinger) {
      const bb = calculateBollingerBands(computed.closes, 20, 2);
      wanted.set("bollUpper", {
        data: toLineData(computed.timestamps, bb.upper),
        color: COLORS.bollUpper,
        width: 1,
      });
      wanted.set("bollMiddle", {
        data: toLineData(computed.timestamps, bb.middle),
        color: COLORS.bollMiddle,
        width: 1,
      });
      wanted.set("bollLower", {
        data: toLineData(computed.timestamps, bb.lower),
        color: COLORS.bollLower,
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

    chart.timeScale().fitContent();
  }, [computed, indicators]);

  const displayedLegend = legend ?? initialLegend;
  const up = displayedLegend ? displayedLegend.close >= displayedLegend.open : true;
  const change = displayedLegend ? displayedLegend.close - displayedLegend.open : 0;
  const changePct =
    displayedLegend && displayedLegend.open !== 0
      ? ((displayedLegend.close - displayedLegend.open) / displayedLegend.open) * 100
      : 0;

  return (
    <div>
      {/* OHLCV Legend */}
      <div className="flex min-h-[28px] flex-wrap items-center gap-x-3 gap-y-0.5 px-3 pt-2 pb-0.5 font-mono text-xs">
        <span className={terminal ? "font-sans text-[11px] font-medium text-[var(--color-text-muted)]" : "text-muted-foreground font-sans text-[11px] font-medium"}>
          {showMCap ? "Market Cap" : "Price"} (USD)
        </span>
        {displayedLegend && (
          <>
            <span>
              <span className="text-muted-foreground">O</span>
              <span className={terminal ? "text-[var(--color-text-primary)]" : up ? "text-blue-600" : "text-zinc-700"}>
                {formatChartPrice(displayedLegend.open)}
              </span>
            </span>
            <span>
              <span className="text-muted-foreground">H</span>
              <span className={terminal ? "text-[var(--color-text-primary)]" : "text-blue-600"}>
                {formatChartPrice(displayedLegend.high)}
              </span>
            </span>
            <span>
              <span className="text-muted-foreground">L</span>
              <span className={terminal ? "text-[var(--color-text-primary)]" : "text-zinc-700"}>
                {formatChartPrice(displayedLegend.low)}
              </span>
            </span>
            <span>
              <span className="text-muted-foreground">C</span>
              <span className={terminal ? "text-[var(--color-text-primary)]" : up ? "text-blue-600" : "text-zinc-700"}>
                {formatChartPrice(displayedLegend.close)}
              </span>
            </span>
            <span className={up ? "text-emerald-400" : "text-red-400"}>
              {up ? "+" : "-"}
              {formatChartPrice(Math.abs(change))} (
              {changePct >= 0 ? "+" : ""}
              {changePct.toFixed(2)}%)
            </span>
          </>
        )}
      </div>
      {displayedLegend && indicators.volume && (
        <div className="px-3 pb-1 text-xs font-mono">
          <span className={terminal ? "font-sans text-[11px] text-[var(--color-text-muted)]" : "text-muted-foreground font-sans text-[11px]"}>
            Volume
          </span>{" "}
          <span className={terminal ? "text-[var(--color-text-secondary)]" : "text-blue-500"}>
            {formatChartPrice(displayedLegend.volume)}
          </span>
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
