"use client";

import { useTokenTrades } from "@/hooks/use-token-trades";
import { useXyzPrice } from "@/hooks/use-xyz-price";
import { formatUsd } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { explorerUrl } from "@/lib/floorlaunch/config";

interface RecentTradesProps {
  tokenAddress: string;
  tokenSymbol: string;
}

export function RecentTrades({ tokenAddress, tokenSymbol }: RecentTradesProps) {
  const { data: trades, isLoading } = useTokenTrades(tokenAddress);
  const { xyzPriceUsd } = useXyzPrice();

  return (
    <div className="h-full">
      <h2 className="mb-3 text-lg font-semibold text-zinc-900">Recent Transactions</h2>
      <div className="min-h-[22rem] overflow-hidden rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border-soft)] bg-[var(--color-bg-surface)]">
                <th className="px-4 py-3 text-left font-medium text-[var(--color-text-muted)]">
                  Time
                </th>
                <th className="px-4 py-3 text-left font-medium text-[var(--color-text-muted)]">
                  Type
                </th>
                <th className="px-4 py-3 text-right font-medium text-[var(--color-text-muted)]">
                  USD
                </th>
                <th className="px-4 py-3 text-right font-medium text-[var(--color-text-muted)]">
                  {tokenSymbol}
                </th>
                <th className="px-4 py-3 text-left font-medium text-[var(--color-text-muted)]">
                  Trader
                </th>
                <th className="px-4 py-3 text-right font-medium text-[var(--color-text-muted)]">
                  Tx
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-4 py-3">
                        <Skeleton className="h-4 w-16" />
                      </td>
                      <td className="px-4 py-3">
                        <Skeleton className="h-4 w-10" />
                      </td>
                      <td className="px-4 py-3">
                        <Skeleton className="h-4 w-20 ml-auto" />
                      </td>
                      <td className="px-4 py-3">
                        <Skeleton className="h-4 w-20 ml-auto" />
                      </td>
                      <td className="px-4 py-3">
                        <Skeleton className="h-4 w-24" />
                      </td>
                      <td className="px-4 py-3">
                        <Skeleton className="h-4 w-8 ml-auto" />
                      </td>
                    </tr>
                  ))}
                </>
              )}

              {!isLoading && trades && trades.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-[var(--color-text-muted)]"
                  >
                    No trades yet
                  </td>
                </tr>
              )}

              {trades?.map((trade) => (
                <tr
                  key={trade.tx_hash}
                   className="border-b border-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-bg-surface)]"
                >
                  <td className="whitespace-nowrap px-4 py-3 text-[var(--color-text-muted)]">
                    {formatTimeAgo(trade.time)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold ${
                        trade.action === "buy"
                          ? "bg-primary/20 text-primary"
                          : "bg-[var(--color-bg-surface)] text-zinc-700"
                      }`}
                    >
                      {trade.action === "buy" ? "Buy" : "Sell"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono whitespace-nowrap">
                    {formatUxyzAsUsd(trade.hodl_amount, xyzPriceUsd)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono whitespace-nowrap">
                    {formatMicroTokens(trade.token_amount)}
                  </td>
                  <td className="px-4 py-3 font-mono text-[var(--color-text-muted)]">
                    <a
                      href={explorerUrl("address", trade.trader)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-zinc-900"
                    >
                      {truncateAddress(trade.trader)}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <a
                      href={explorerUrl("tx", trade.tx_hash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-[var(--color-text-muted)] hover:text-zinc-900"
                      title={trade.tx_hash}
                    >
                      {trade.tx_hash.slice(0, 6)}...
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function formatTimeAgo(isoTime: string): string {
  const now = Date.now();
  const then = new Date(isoTime).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function formatUxyzAsUsd(uxyz: string, xyzPriceUsd: number): string {
  const usd = (Number(uxyz) / 1_000_000) * xyzPriceUsd;
  return formatUsd(usd);
}

function formatMicroTokens(micro: string): string {
  const num = Number(micro) / 1_000_000;
  if (num === 0) return "0";
  if (num < 0.01) return num.toExponential(2);
  if (num < 1000) return num.toFixed(2);
  return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function truncateAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
}
