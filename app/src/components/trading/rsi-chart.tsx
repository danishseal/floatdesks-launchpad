"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  type IChartApi,
  type UTCTimestamp,
  LineSeries,
} from "lightweight-charts";

interface RsiChartProps {
  timestamps: UTCTimestamp[];
  values: (number | null)[];
}

export function RsiChart({ timestamps, values }: RsiChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 120,
      layout: { background: { color: "transparent" }, textColor: "#9ca3af" },
      grid: {
        vertLines: { color: "rgba(156, 163, 175, 0.1)" },
        horzLines: { color: "rgba(156, 163, 175, 0.1)" },
      },
      timeScale: { visible: false },
      rightPriceScale: {
        borderColor: "rgba(156, 163, 175, 0.2)",
        scaleMargins: { top: 0.05, bottom: 0.05 },
      },
      crosshair: {
        vertLine: { color: "rgba(156, 163, 175, 0.3)" },
        horzLine: { color: "rgba(156, 163, 175, 0.3)" },
      },
    });
    chartRef.current = chart;

    // Overbought / oversold reference lines
    const ob = chart.addSeries(LineSeries, {
      color: "rgba(117, 251, 110, 0.35)",
      lineWidth: 1,
      lineStyle: 2, // dashed
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    const os = chart.addSeries(LineSeries, {
      color: "rgba(113, 113, 122, 0.4)",
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    // RSI line
    const rsiSeries = chart.addSeries(LineSeries, {
      color: "#4367d8",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
    });

    // Build data
    const lineData = [];
    const obData = [];
    const osData = [];
    for (let i = 0; i < timestamps.length; i++) {
      obData.push({ time: timestamps[i], value: 70 });
      osData.push({ time: timestamps[i], value: 30 });
      if (values[i] !== null) {
        lineData.push({ time: timestamps[i], value: values[i]! });
      }
    }
    ob.setData(obData);
    os.setData(osData);
    rsiSeries.setData(lineData);
    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [timestamps, values]);

  return (
    <div className="border-t border-zinc-900/80">
      <div className="px-2 py-1 text-xs font-medium text-[var(--color-text-muted)]">RSI(14)</div>
      <div ref={containerRef} className="w-full" />
    </div>
  );
}
