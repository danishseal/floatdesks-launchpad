"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Eye } from "@phosphor-icons/react";
import { useRecentTrades } from "@/hooks/use-recent-trades";
import { useTokens } from "@/hooks/use-tokens";
import { useFollowEvents, type FollowEvent } from "@/lib/social";
import { explorerUrl } from "@/lib/floorlaunch/config";
import { formatDistanceToNow } from "date-fns";
import type { RecentTrade } from "@/lib/api";

type Item =
  | { kind: "trade"; time: number; trade: RecentTrade }
  | { kind: "follow"; time: number; event: FollowEvent };

/**
 * Activity timeline: real trades (buys/sells/launches) merged with follow
 * events. Rows show the token image and read as a sentence with a color-coded
 * verb. `address` scopes it to one wallet (its trades + follows to/from it).
 */
export function ActivityFeed({ address, compact = false }: { address?: string; compact?: boolean }) {
  const trades = useRecentTrades(compact ? 80 : 150);
  const events = useFollowEvents(address);
  const { data: tokens } = useTokens();

  const imgOf = useMemo(() => {
    const m = new Map<string, { image: string | null; symbol: string | null }>();
    for (const t of tokens ?? []) m.set(t.address, { image: t.image ?? null, symbol: t.symbol ?? null });
    return m;
  }, [tokens]);

  const items = useMemo<Item[]>(() => {
    const tradeItems: Item[] = (trades.data ?? [])
      .filter((t) => !address || t.trader === address)
      .map((t) => ({ kind: "trade", time: new Date(t.time).getTime(), trade: t }));
    const followItems: Item[] = (events.data ?? []).map((e) => ({
      kind: "follow",
      time: e.createdAt,
      event: e,
    }));
    return [...tradeItems, ...followItems]
      .filter((i) => Number.isFinite(i.time))
      .sort((a, b) => b.time - a.time)
      .slice(0, compact ? 60 : 150);
  }, [trades.data, events.data, address, compact]);

  if (trades.isLoading && items.length === 0) {
    return <div className="py-10 text-center text-[13px] text-[var(--color-text-muted)]">Loading activity…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="py-14 text-center">
        <p className="font-display text-[14px] font-semibold text-[var(--color-text-secondary)]">No activity yet</p>
        <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
          {address ? "This wallet has no indexed activity yet." : "Trades, launches and follows will stream here."}
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-[var(--hairline)]">
      {items.map((it) =>
        it.kind === "trade" ? (
          <TradeRow key={`t-${it.trade.tx_hash}-${it.time}`} trade={it.trade} img={imgOf.get(it.trade.token_address)} showTrader={!address} />
        ) : (
          <FollowRow key={`f-${it.event.follower}-${it.event.target}-${it.time}`} event={it.event} viewer={address} />
        ),
      )}
    </div>
  );
}

/* ---------------- rows ---------------- */

function TradeRow({
  trade,
  img,
  showTrader,
}: {
  trade: RecentTrade;
  img?: { image: string | null; symbol: string | null };
  showTrader: boolean;
}) {
  const k = verbFor(trade.action);
  const sym = trade.token_symbol ?? img?.symbol ?? "TOKEN";
  return (
    <div className="flex items-center gap-3 py-3">
      <TokenAvatar image={img?.image ?? null} symbol={sym} />
      <p className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-secondary)]">
        {showTrader && (
          <Link href={`/creator/${trade.trader}`} className="font-mono text-[var(--color-text-secondary)] hover:text-[var(--color-accent-strong)]">
            {short(trade.trader)}
          </Link>
        )}{" "}
        <span className={`font-semibold ${k.color}`}>{k.verb}</span>{" "}
        <Link href={`/token/${trade.token_address}`} className="font-semibold text-[var(--color-accent-strong)] hover:underline">
          ${sym}
        </Link>
      </p>
      <span className="shrink-0 text-[12px] text-[var(--color-text-muted)]">{ago(new Date(trade.time).getTime())}</span>
      <a
        href={explorerUrl("tx", trade.tx_hash)}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 font-mono text-[11px] text-[var(--color-text-subtle)] hover:text-[var(--color-accent-strong)]"
      >
        {short(trade.tx_hash, 4)}
      </a>
    </div>
  );
}

function FollowRow({ event, viewer }: { event: FollowEvent; viewer?: string }) {
  const followerIsViewer = viewer && event.follower === viewer;
  return (
    <div className="flex items-center gap-3 py-3">
      <GradientAvatar seed={event.follower} />
      <p className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-secondary)]">
        <Link href={`/creator/${event.follower}`} className="font-mono text-[var(--color-text-primary)] hover:text-[var(--color-accent-strong)]">
          {followerIsViewer ? "You" : short(event.follower)}
        </Link>{" "}
        <span className="font-semibold text-[var(--color-accent-strong)]">followed</span>{" "}
        <Link href={`/creator/${event.target}`} className="font-mono text-[var(--color-text-primary)] hover:text-[var(--color-accent-strong)]">
          {viewer && event.target === viewer ? "you" : short(event.target)}
        </Link>
      </p>
      <span className="shrink-0 text-[12px] text-[var(--color-text-muted)]">{ago(event.createdAt)}</span>
      <Eye size={13} className="shrink-0 text-[var(--color-text-subtle)]" />
    </div>
  );
}

/* ---------------- bits ---------------- */

function TokenAvatar({ image, symbol }: { image: string | null; symbol: string }) {
  return (
    <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full bg-[var(--color-bg-raised)] ring-1 ring-inset ring-white/10">
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[12px] text-[var(--color-text-muted)]">{symbol.slice(0, 1)}</span>
      )}
    </div>
  );
}

function GradientAvatar({ seed }: { seed: string }) {
  const h = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
  return (
    <div
      className="h-9 w-9 shrink-0 rounded-full ring-1 ring-inset ring-white/10"
      style={{ background: `linear-gradient(135deg, hsl(${h} 60% 45%), hsl(${(h + 60) % 360} 60% 40%))` }}
    />
  );
}

function verbFor(action: string): { verb: string; color: string } {
  const a = action.toLowerCase();
  if (a === "buy") return { verb: "bought", color: "text-[var(--color-positive)]" };
  if (a === "sell") return { verb: "sold", color: "text-[var(--color-negative)]" };
  if (a === "create" || a === "launch") return { verb: "launched", color: "text-[var(--color-accent-strong)]" };
  return { verb: action, color: "text-[var(--color-text-secondary)]" };
}

function short(a: string, n = 6): string {
  return a.length > n * 2 ? `${a.slice(0, n)}…${a.slice(-4)}` : a;
}
function ago(ts: number): string {
  return Number.isFinite(ts) ? formatDistanceToNow(new Date(ts), { addSuffix: true }) : "";
}
