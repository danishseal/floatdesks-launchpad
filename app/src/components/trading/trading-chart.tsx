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
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900">Price Chart</h2>
        </div>
        <div className="flex h-[400px] items-center justify-center rounded-2xl border border-destructive/40 bg-destructive/15">
          <div className="text-center space-y-2">
            <p className="font-medium text-destructive">
              Failed to load chart
            </p>
            <p className="text-sm text-[var(--color-text-muted)]">
              {error instanceof Error ? error.message : "Unknown error"}
            </p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const hasData = data && data.candles.length > 0;
  // No synthetic candle before the first trade: the chart stays empty until
  // there's real activity, so nothing misleading shows on a fresh market.
  const chartData = hasData ? data : null;

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
          <div className="text-center space-y-2">
            <p className={terminal ? "text-[var(--color-text-secondary)]" : "text-[var(--color-text-muted)]"}>
              No trading data available yet
            </p>
            <p className={terminal ? "text-sm text-[var(--color-text-muted)]" : "text-sm text-[var(--color-text-subtle)]"}>
              Chart will appear after first trade
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
