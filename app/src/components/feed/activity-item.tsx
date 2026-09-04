"use client";

import { useEffect, useState } from "react";
import {
  ArrowBendUpRight,
  ArrowBendDownRight,
  ArrowsLeftRight,
} from "@phosphor-icons/react";
import { formatDistanceToNow } from "date-fns";
import type { RecentTrade } from "@/lib/api";

interface ActivityItemProps {
  trade: RecentTrade;
}

export function ActivityItem({ trade }: ActivityItemProps) {
  // Relative timestamp that auto-refreshes every 30 seconds
  const [relativeTime, setRelativeTime] = useState(() =>
    formatDistanceToNow(new Date(trade.time), { addSuffix: true })
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setRelativeTime(
        formatDistanceToNow(new Date(trade.time), { addSuffix: true })
      );
    }, 30_000); // Refresh every 30 seconds

    return () => clearInterval(interval);
  }, [trade.time]);

  // Icon + label from the normalized buy/sell action (api.ts tradeSide already
  // resolved AMM swaps via their direction, so we key off action directly).
  const getDirectionDisplay = () => {
    switch (trade.action) {
      case "buy":
        return {
          icon: <ArrowBendUpRight size={16} weight="fill" />,
          color: "text-primary",
          action: "Bought",
        };
      case "sell":
        return {
          icon: <ArrowBendDownRight size={16} weight="fill" />,
          color: "text-[var(--color-text-subtle)]",
          action: "Sold",
        };
      default:
        return {
          icon: <ArrowsLeftRight size={16} weight="fill" />,
          color: "text-muted-foreground",
          action: trade.action,
        };
    }
  };

  const { icon, color, action } = getDirectionDisplay();

  // Format trader address (truncated)
  const traderDisplay = `${trade.trader.slice(0, 8)}...${trade.trader.slice(-4)}`;

  const volumeSol = (Number(trade.volume_uxyz) / 1_000_000).toFixed(2);

  // Display token symbol or truncated address as fallback
  const tokenDisplay = trade.token_symbol ?? trade.token_address.slice(0, 8);

  return (
    <div className="flex min-h-[44px] items-center gap-3 rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] p-3 text-sm shadow-sm">
      <div className={`flex-shrink-0 ${color}`}>{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-[var(--color-text-muted)]">
            {traderDisplay}
          </span>
          <span className="text-[var(--color-text-muted)]">{action}</span>
          <span className="truncate font-medium text-zinc-800">{tokenDisplay}</span>
        </div>
        <div className="text-xs text-[var(--color-text-muted)]">
          {volumeSol} SOL · {relativeTime}
        </div>
      </div>
    </div>
  );
}
