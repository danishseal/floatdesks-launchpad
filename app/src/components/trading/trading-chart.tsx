"use client";

import { useEffect, useRef, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { TradingChartCanvas } from "./trading-chart-canvas";
import { TradingChartSkeleton } from "./trading-chart-skeleton";
import {
  IndicatorToolbar,
  DEFAULT_INDICATORS,
  type ActiveIndicators,
} from "./indicator-toolbar";
import type { CandleResponse, Timeframe } from "@/lib/api";

interface TradingChartProps {
  tokenAddress: string;
  terminal?: boolean;
  timeframe?: Timeframe;
  fallbackPrice?: number;
  solUsd?: number;
  candleData?: CandleResponse;
  candleLoading?: boolean;
  candleError?: Error | null;
  onRetry?: () => void;
}

export function TradingChart({
  tokenAddress,
  terminal = false,
  timeframe: controlledTimeframe,
  fallbackPrice,
  solUsd,
  candleData: data,
  candleLoading: isLoading = false,
  candleError: error,
  onRetry,
}: TradingChartProps) {
  const [internalTimeframe, setInternalTimeframe] = useState<Timeframe>("1m");
  const timeframe = controlledTimeframe ?? internalTimeframe;
  const [indicators, setIndicators] =
    useState<ActiveIndicators>(DEFAULT_INDICATORS);
  const showMCap = true;
  const terminalRootRef = useRef<HTMLDivElement>(null);
  const [terminalChartHeight, setTerminalChartHeight] = useState(520);

  useEffect(() => {
    if (!terminal || !terminalRootRef.current) return;
    const element = terminalRootRef.current;
    const resize = () => {
      setTerminalChartHeight(Math.max(360, element.clientHeight - 52));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [terminal, isLoading]);

  if (isLoading && !(fallbackPrice && fallbackPrice > 0)) {
    return <TradingChartSkeleton terminal={terminal} />;
  }

  if (error && !(fallbackPrice && fallbackPrice > 0)) {
    return (
      <div className="space-y-4">
        <div
          className="flex h-[400px] items-center justify-center border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)]"
        >
          <div className="space-y-2 text-center">
            <p className="font-medium text-[var(--color-negative)]">
              Price history unavailable
            </p>
            <p className="text-sm text-[var(--color-text-muted)]">
              {error instanceof Error ? error.message : "The chain's trade logs could not be read"}
            </p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // What is actually in the series, before anything is drawn from it.
  //
  // `trades` is the count of prints in a bucket. `toCandles` fills gaps with
  // the previous close so the series has no holes, and those filled buckets
  // carry trades: 0. Counting them would turn one trade into a chart of
  // hundreds, which is the shape this whole gate exists to refuse.
  const candles = data?.candles ?? [];
  let printed = 0;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const candle of candles) {
    printed += Number(candle.trades ?? 0);
    if (Number(candle.low) < low) low = Number(candle.low);
    if (Number(candle.high) > high) high = Number(candle.high);
  }
  // A range of exactly zero is one price repeated, not a trend. Drawing it
  // gives a confident flat line across the pane, which states a market holding
  // its level through a session. What it is, is a single number.
  const moved = candles.length > 0 && high > low;
  const chartData = moved ? data : null;

  // Loading is not emptiness. The skeleton above is skipped whenever a
  // fallbackPrice is passed, and the token page always passes one, so without
  // this branch a page that already knows its price renders "has not printed a
  // price" for as long as the log scan takes. That is seconds on a cold read,
  // and it is a stated measurement of no trading rather than an absence of one.
  // Only a read that has finished is allowed to report an absence.
  const vacant = moved
    ? null
    : isLoading || !data
      ? {
          head: "Loading price history",
          note: "Reading this market's trades from the chain",
        }
      : candles.length === 0 || printed === 0
      ? {
          head: "No trades yet",
          note: "This market has not printed a price",
        }
      : {
          head:
            printed === 1
              ? "One trade, no price movement yet"
              : `${printed} trades, all at one price`,
          note: "There is a single price here, so there is no series to draw",
        };

  return (
    <div
      ref={terminalRootRef}
      className={terminal ? "h-full min-h-0 space-y-0" : "space-y-3"}
    >
      {/* Top bar */}
      {!terminal && <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <Tabs
            value={timeframe}
            onValueChange={(v) => setInternalTimeframe(v as Timeframe)}
          >
            <TabsList>
              <TabsTrigger value="1m">1m</TabsTrigger>
              <TabsTrigger value="5m">5m</TabsTrigger>
              <TabsTrigger value="1h">1h</TabsTrigger>
              <TabsTrigger value="1d">1d</TabsTrigger>
            </TabsList>
          </Tabs>

        </div>
      </div>}

      {!terminal && <IndicatorToolbar indicators={indicators} onChange={setIndicators} />}

      {chartData ? (
        <div className={terminal ? "overflow-hidden border-0 bg-transparent" : "overflow-hidden rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] shadow-sm"}>
          <TradingChartCanvas
            data={chartData}
            indicators={indicators}
            showMCap={showMCap}
            chartHeight={terminal ? terminalChartHeight : 400}
            terminal={terminal}
            solUsd={solUsd}
          />
        </div>
      ) : (
        <div
          className={terminal ? "flex items-center justify-center bg-[var(--color-bg-page)]" : "flex h-[400px] items-center justify-center rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] shadow-sm"}
          style={terminal ? { height: terminalChartHeight } : undefined}
        >
          <div className="space-y-1.5 text-center">
            <p className="font-medium text-[var(--color-text-secondary)]">
              {vacant?.head}
            </p>
            <p className="text-sm text-[var(--color-text-muted)]">
              {vacant?.note}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
