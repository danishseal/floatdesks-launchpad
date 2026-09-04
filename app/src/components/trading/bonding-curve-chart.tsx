"use client";

import { useCurveProgress } from "@/hooks/use-curve-progress";
import { useXyzPrice } from "@/hooks/use-xyz-price";
import { formatUsd } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

interface BondingCurveChartProps {
  tokenAddress: string;
}

export function BondingCurveChart({ tokenAddress }: BondingCurveChartProps) {
  const { data: progress, isLoading } = useCurveProgress(tokenAddress);
  const { xyzPriceUsd } = useXyzPrice();

  if (isLoading) {
    return (
      <div className="space-y-3 rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] p-4 shadow-sm">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-6 w-full rounded-sm" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }

  if (!progress) return null;

  if (progress.graduated) {
    return (
      <div className="space-y-3 rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-900">Bonding Curve</h3>
          <Badge variant="secondary">Graduated</Badge>
        </div>
        <p className="text-sm text-[var(--color-text-muted)]">
          This token has graduated to the AMM. The bonding curve is now closed.
        </p>
      </div>
    );
  }

  const solReserves = Number(progress.hodl_reserves);
  const gradThreshold = Number(progress.graduation_threshold);
  const progressPct = Math.min(progress.progress_percent, 100);

  const raisedUsd = (solReserves / 1e6) * xyzPriceUsd;
  const thresholdUsd = (gradThreshold / 1e6) * xyzPriceUsd;

  return (
    <div className="space-y-2 rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-900">Bonding Curve Progress</h3>
        <span className="text-xs font-mono font-medium text-zinc-700">
          {progressPct.toFixed(1)}%
        </span>
      </div>

      <div className="h-5 w-full overflow-hidden rounded-sm bg-[var(--color-bg-surface)]">
        <div
          className="h-full rounded-sm bg-primary transition-all duration-500"
          style={{ width: `${Math.max(progressPct, 0.5)}%` }}
        />
      </div>

      <div className="flex justify-between text-xs text-[var(--color-text-muted)]">
        <span>{formatUsd(raisedUsd)} raised</span>
        <span>{formatUsd(thresholdUsd)} to graduate</span>
      </div>
    </div>
  );
}
