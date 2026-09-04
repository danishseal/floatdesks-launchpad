"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  type IChartApi,
  type UTCTimestamp,
  LineSeries,
  HistogramSeries,
} from "lightweight-charts";
import type { MACDResult } from "@/lib/indicators";

interface MacdChartProps {
  timestamps: UTCTimestamp[];
  macd: MACDResult;
}

export function MacdChart({ timestamps, macd }: MacdChartProps) {
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
      },
      crosshair: {
        vertLine: { color: "rgba(156, 163, 175, 0.3)" },
        horzLine: { color: "rgba(156, 163, 175, 0.3)" },
      },
    });
    chartRef.current = chart;

    // Histogram
    const histSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
    });
    histSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.6, bottom: 0 },
    });

    // MACD line
    const macdSeries = chart.addSeries(LineSeries, {
      color: "#4367d8",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    // Signal line
    const signalSeries = chart.addSeries(LineSeries, {
      color: "#3556be",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    // Build data
    const macdData = [];
    const signalData = [];
    const histData = [];

    for (let i = 0; i < timestamps.length; i++) {
      if (macd.macd[i] !== null) {
        macdData.push({ time: timestamps[i], value: macd.macd[i]! });
      }
      if (macd.signal[i] !== null) {
        signalData.push({ time: timestamps[i], value: macd.signal[i]! });
      }
      if (macd.histogram[i] !== null) {
        histData.push({
          time: timestamps[i],
          value: macd.histogram[i]!,
          color:
            macd.histogram[i]! >= 0
              ? "rgba(117, 251, 110, 0.7)"
              : "rgba(113, 113, 122, 0.8)",
        });
      }
    }

    histSeries.setData(histData);
    macdSeries.setData(macdData);
    signalSeries.setData(signalData);
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
  }, [timestamps, macd]);

  return (
    <div className="border-t border-zinc-900/80">
      <div className="px-2 py-1 text-xs font-medium text-[var(--color-text-muted)]">
        MACD(12, 26, 9)
      </div>
      <div ref={containerRef} className="w-full" />
    </div>
  );
}
