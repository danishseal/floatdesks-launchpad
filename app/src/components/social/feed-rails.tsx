"use client";

import Link from "next/link";
import { useMemo } from "react";
import { User } from "@phosphor-icons/react";
import { useTokens } from "@/hooks/use-tokens";
import { capUsd, usdCompact, short } from "@/components/social/shared";

/**
 * Shared feed chrome. `FeedShell` lays out the Twitter-style 3-column grid
 * (Trending left | center content | Leaderboard right) used by BOTH the /feed
 * timeline and the /post/[id] detail view, so navigating into a post keeps both
 * rails visible and the rails stay DRY / in sync. Below xl the rails hide and the
 * center column stands alone (unchanged responsive behaviour).
 */
export function FeedShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[280px_minmax(0,1fr)_300px]">
      {/* LEFT rail: Trending (top coins) */}
      <aside className="hidden xl:block">
        <div className="sticky top-4">
          <TrendingRail />
        </div>
      </aside>

      {/* CENTER: page content */}
      <main className="mx-auto w-full max-w-[620px]">{children}</main>

      {/* RIGHT rail: Leaderboard (top creators) */}
      <aside className="hidden xl:block">
        <div className="sticky top-4">
          <LeaderboardRail />
        </div>
      </aside>
    </div>
  );
}

/* ---------------- LEFT rail: Trending ---------------- */

export function TrendingRail() {
  const { data: tokens, isLoading } = useTokens();
  const trending = useMemo(
    () => [...(tokens ?? [])].sort((a, b) => capUsd(b) - capUsd(a)).slice(0, 10),
    [tokens],
  );

  return (
    <RailShell title="Trending" tabs={["Trending", "Movers", "Watchlist"]}>
      {isLoading ? (
        <RailLoading />
      ) : trending.length === 0 ? (
        <RailEmpty label="No coins yet." />
      ) : (
        <ul className="ansem-fade-in">
          {trending.map((t) => (
            <li key={t.address}>
              <Link
                href={`/token/${t.address}`}
                className="group flex items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-[var(--color-bg-raised)]"
              >
                <div className="h-8 w-8 shrink-0 overflow-hidden rounded-md border border-[var(--hairline)] bg-[var(--color-bg-raised)]">
                  {t.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={t.image} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full items-center justify-center font-mono text-[11px] text-[var(--color-text-subtle)]">
                      {t.symbol?.slice(0, 1)}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-display text-[13px] font-semibold text-[var(--color-accent-strong)]">
                      ${t.symbol}
                    </span>
                  </div>
                  <span className="block truncate font-sans text-[11px] text-[var(--color-text-muted)]">
                    {t.name}
                  </span>
                </div>
                <div className="shrink-0 text-right">
                  <span className="block font-mono text-[12px] font-semibold text-[var(--color-text-primary)]">
                    {usdCompact(capUsd(t))}
                  </span>
                  {t.price_change_24h != null && (
                    <span
                      className={`block font-mono text-[11px] ${t.price_change_24h >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}`}
                    >
                      {t.price_change_24h >= 0 ? "+" : ""}
                      {t.price_change_24h.toFixed(1)}%
                    </span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </RailShell>
  );
}

/* ---------------- RIGHT rail: Leaderboard ---------------- */

export function LeaderboardRail() {
  const { data: tokens, isLoading } = useTokens();
  const creators = useMemo(() => {
    const map = new Map<
      string,
      { creator: string; launches: number; launchedValue: number; image: string | null }
    >();
    for (const t of tokens ?? []) {
      const c = t.creator ?? t.address;
      const row = map.get(c) ?? { creator: c, launches: 0, launchedValue: 0, image: null };
      row.launches += 1;
      row.launchedValue += capUsd(t);
      if (!row.image && t.image) row.image = t.image;
      map.set(c, row);
    }
    return [...map.values()].sort((a, b) => b.launchedValue - a.launchedValue).slice(0, 10);
  }, [tokens]);

  return (
    <RailShell title="Leaderboard" tabs={["Creators"]}>
      {isLoading ? (
        <RailLoading />
      ) : creators.length === 0 ? (
        <RailEmpty label="No creators yet." />
      ) : (
        <ul className="ansem-fade-in">
          {creators.map((c, i) => (
            <li key={c.creator}>
              <Link
                href={`/creator/${c.creator}`}
                className="group flex items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-[var(--color-bg-raised)]"
              >
                <span className="w-5 shrink-0 text-center font-mono text-[12px] text-[var(--color-text-muted)]">
                  {medal(i)}
                </span>
                <div className="h-8 w-8 shrink-0 overflow-hidden rounded-full border border-[var(--hairline)] bg-[var(--color-bg-raised)]">
                  {c.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.image} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <User size={16} weight="fill" className="m-auto mt-1.5 text-[var(--color-text-subtle)]" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[13px] font-semibold text-[var(--color-text-primary)] group-hover:text-[var(--color-accent-strong)]">
                    {short(c.creator)}
                  </span>
                  <span className="block font-sans text-[11px] text-[var(--color-text-muted)]">
                    {c.launches} launch{c.launches === 1 ? "" : "es"}
                  </span>
                </div>
                <span className="shrink-0 font-mono text-[12px] font-semibold text-[var(--color-text-primary)]">
                  {usdCompact(c.launchedValue)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </RailShell>
  );
}

/* ---------------- Rail shell ---------------- */

function RailShell({
  title,
  tabs,
  children,
}: {
  title: string;
  tabs: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--hairline)] bg-[var(--color-bg-surface)]">
      <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-3 py-3">
        <h2 className="font-display text-[15px] font-semibold text-[var(--color-text-primary)]">{title}</h2>
      </div>
      {tabs.length > 1 && (
        <div className="flex gap-4 border-b border-[var(--hairline)] px-3 py-2">
          {tabs.map((t, i) => (
            <span
              key={t}
              className={`font-sans text-[12px] font-medium ${i === 0 ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-subtle)]"}`}
            >
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="divide-y divide-[var(--hairline)]">{children}</div>
    </div>
  );
}

function RailLoading() {
  return <p className="px-3 py-6 text-center font-sans text-[12px] text-[var(--color-text-subtle)]">Loading…</p>;
}
function RailEmpty({ label }: { label: string }) {
  return <p className="px-3 py-6 text-center font-sans text-[12px] text-[var(--color-text-subtle)]">{label}</p>;
}

function medal(i: number): string {
  return i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : String(i + 1);
}
