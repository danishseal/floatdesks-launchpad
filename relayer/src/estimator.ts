import { SalePoint, EstimateDetail } from "./types.js";

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation filter: drop points further than k MADs. */
export function madFilter(points: SalePoint[], k = 3): {
  kept: SalePoint[];
  dropped: SalePoint[];
} {
  if (points.length < 3) return { kept: points, dropped: [] };
  const med = median(points.map((p) => p.lamports));
  const mad = median(points.map((p) => Math.abs(p.lamports - med)));
  if (mad === 0) return { kept: points, dropped: [] };
  const kept: SalePoint[] = [];
  const dropped: SalePoint[] = [];
  for (const p of points) {
    (Math.abs(p.lamports - med) <= k * mad ? kept : dropped).push(p);
  }
  return { kept, dropped };
}

/**
 * Recency-weighted median: each sale weighted by 1 / (1 + age_days) so a
 * print from today counts roughly twice a print from yesterday and the
 * long tail of the lookback window fades smoothly.
 */
export function recencyWeightedMedian(points: SalePoint[], nowTs: number): number {
  const weighted = points
    .map((p) => ({
      lamports: p.lamports,
      w: 1 / (1 + Math.max(0, nowTs - p.unixTs) / 86_400),
    }))
    .sort((a, b) => a.lamports - b.lamports);
  const total = weighted.reduce((s, p) => s + p.w, 0);
  let acc = 0;
  for (const p of weighted) {
    acc += p.w;
    if (acc >= total / 2) return p.lamports;
  }
  return weighted[weighted.length - 1].lamports;
}

/**
 * Full sale-based estimate with gates.
 *
 * Returns null when the market fails a gate (not enough sales, or the
 * estimate disagrees with the reference ask beyond the configured bound).
 * Callers must treat null as "hold the last on-chain value and alert",
 * never as zero.
 */
export function estimate(
  sales: SalePoint[],
  opts: {
    nowTs: number;
    minSales: number;
    referenceAskLamports: number | null;
    maxDisagreementBps: number;
  }
): EstimateDetail | null {
  if (sales.length < opts.minSales) return null;
  const { kept, dropped } = madFilter(sales);
  if (kept.length < opts.minSales) return null;
  let est = recencyWeightedMedian(kept, opts.nowTs);

  let deviationBps: number | null = null;
  if (opts.referenceAskLamports && opts.referenceAskLamports > 0) {
    const ask = opts.referenceAskLamports;
    deviationBps = Math.round(Math.abs(est - ask) / ask * 10_000);
    if (deviationBps > opts.maxDisagreementBps) return null;
    // Asks cap the estimate (free to fake high, costly to fake low).
    est = Math.min(est, Math.round(ask * 1.05));
  }

  return {
    estimateLamports: Math.round(est),
    salesUsed: kept.length,
    salesDropped: dropped.length,
    referenceAskLamports: opts.referenceAskLamports,
    deviationBps,
  };
}
