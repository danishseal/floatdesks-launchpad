"use client";

import { formatTokenAmount, formatUsd, fromUxyz } from "@/lib/utils";
import { useXyzPrice } from "@/hooks/use-xyz-price";

interface TradePreviewProps {
  /** Estimated output amount in micro-units */
  estimatedOutput: string;
  /** Minimum output after slippage in micro-units */
  minOutput: string;
  /** Fee amount in micro-units */
  feeAmount: string;
  /** Current slippage percentage */
  slippagePercent: number;
  /** Output denomination label (e.g., "XYZ" or token symbol) */
  outputDenom: string;
  /** Whether output is in uxyz (true) or token micro-units (false) */
  outputIsXyz: boolean;
  /** New price after trade (optional, decimal XYZ string) */
  newPrice?: string;
  /** Price impact percentage (optional, for AMM swaps) */
  priceImpact?: string;
}

export function TradePreview({
  estimatedOutput,
  minOutput,
  feeAmount,
  slippagePercent,
  outputDenom,
  outputIsXyz,
  newPrice,
  priceImpact,
}: TradePreviewProps) {
  const { xyzPriceUsd } = useXyzPrice();

  const formatOutput = outputIsXyz
    ? (v: string) => formatUsd(fromUxyz(v) * xyzPriceUsd)
    : formatTokenAmount;

  const feeUsd = formatUsd(fromUxyz(feeAmount) * xyzPriceUsd);
  const newPriceUsd = newPrice
    ? formatUsd(Number(newPrice) * xyzPriceUsd)
    : null;

  return (
    <div className="space-y-2 rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] p-4 text-sm">
      <div className="flex justify-between">
        <span className="text-[var(--color-text-muted)]">You receive (est.)</span>
        <span className="font-mono text-zinc-900">
          {formatOutput(estimatedOutput)} {!outputIsXyz && outputDenom}
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-[var(--color-text-muted)]">
          Min after slippage ({slippagePercent}%)
        </span>
        <span className="font-mono text-zinc-900">
          {formatOutput(minOutput)} {!outputIsXyz && outputDenom}
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-[var(--color-text-muted)]">Fee</span>
        <span className="font-mono text-zinc-900">{feeUsd}</span>
      </div>
      {priceImpact && (
        <div className="flex justify-between">
          <span className="text-[var(--color-text-muted)]">Price impact</span>
          <span className="font-mono text-zinc-900">{priceImpact}%</span>
        </div>
      )}
      {newPriceUsd && (
        <div className="flex justify-between">
          <span className="text-[var(--color-text-muted)]">New price</span>
          <span className="font-mono text-zinc-900">{newPriceUsd}</span>
        </div>
      )}
    </div>
  );
}
