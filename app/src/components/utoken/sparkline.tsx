"use client";

/**
 * `Sparkline` is now a candlestick chart, kept at this name and this path so
 * the home preview and the scanner keep importing what they already import.
 *
 * It was a direction-tinted polyline over an area fill, which on a venue where
 * most tokens have one trade drew a ramp and a long flat out of a single price.
 * The drawing lives in components/trading/candle-preview-chart.tsx; the props
 * are unchanged, `up` included, so no caller has to move.
 */
export { CandlePreviewChart as Sparkline } from "@/components/trading/candle-preview-chart";
