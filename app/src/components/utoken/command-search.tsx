"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { MagnifyingGlass, TrendUp, User } from "@phosphor-icons/react";
import { useTokens } from "@/hooks/use-tokens";
import { DEFAULT_TOKEN_SUPPLY } from "@/lib/chain-config";
import type { TokenListItem } from "@/lib/api";

type TopUser = { address: string; image: string | null; launchedValue: number };
type Item =
  | { kind: "token"; key: string; token: TokenListItem }
  | { kind: "creator"; key: string; creator: TopUser };

type Ctx = { open: () => void; close: () => void };
const CommandSearchContext = createContext<Ctx>({ open: () => {}, close: () => {} });

export function useCommandSearch() {
  return useContext(CommandSearchContext);
}

export function CommandSearchProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  // Global "/" and ⌘K / Ctrl+K to open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      if (!typing && e.key === "/") {
        e.preventDefault();
        setIsOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo(() => ({ open, close }), [open, close]);

  return (
    <CommandSearchContext.Provider value={value}>
      {children}
      {isOpen && <SearchModal onClose={close} />}
    </CommandSearchContext.Provider>
  );
}

function SearchModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { data: tokens } = useTokens();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  // The people search that lived here queried /api/social/search, which went
  // with the ansem-1 SocialFi strip. It was firing a 404 on every keystroke and
  // silently swallowing it, so it is gone rather than left looking functional.

  const tokenResults = useMemo(() => {
    const src = tokens ?? [];
    const byCap = [...src].sort(
      (a, b) =>
        Number(b.current_price) * b.market.solUsd -
        Number(a.current_price) * a.market.solUsd,
    );
    if (!query.trim()) return byCap.slice(0, 5);
    const q = query.toLowerCase();
    return byCap
      .filter(
        (t) =>
          t.symbol?.toLowerCase().includes(q) ||
          t.name?.toLowerCase().includes(q) ||
          t.address.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [tokens, query]);

  // Empty-state "Top users": aggregate launched value per creator, top 5.
  const topUsers = useMemo<TopUser[]>(() => {
    if (query.trim()) return [];
    const map = new Map<string, TopUser>();
    for (const t of tokens ?? []) {
      const c = t.creator ?? t.address;
      const row = map.get(c) ?? { address: c, image: null, launchedValue: 0 };
      row.launchedValue += (Number(t.current_price) / 1e6) * t.market.solUsd * DEFAULT_TOKEN_SUPPLY;
      if (!row.image && t.image) row.image = t.image;
      map.set(c, row);
    }
    return [...map.values()].sort((a, b) => b.launchedValue - a.launchedValue).slice(0, 5);
  }, [tokens, query]);

  // One flat, keyboard-navigable list. Empty state: tokens then top users.
  // Query state: matched people first, then tokens (unchanged).
  const items = useMemo<Item[]>(() => {
    if (!query.trim()) {
      return [
        ...tokenResults.map((t) => ({ kind: "token" as const, key: `t-${t.address}`, token: t })),
        ...topUsers.map((u) => ({ kind: "creator" as const, key: `c-${u.address}`, creator: u })),
      ];
    }
    return [
      ...tokenResults.map((t) => ({ kind: "token" as const, key: `t-${t.address}`, token: t })),
    ];
  }, [tokenResults, topUsers, query]);

  // Reset the highlighted row when the query changes. This was an effect, which
  // renders once with a stale index before correcting it; adjusting during
  // render is the sanctioned form.
  const [activeFor, setActiveFor] = useState(query);
  if (activeFor !== query) {
    setActiveFor(query);
    setActive(0);
  }

  const go = useCallback(
    (item?: Item) => {
      if (!item) return;
      onClose();
      if (item.kind === "creator") router.push(`/creator/${item.creator.address}`);
      else router.push(`/token/${item.token.address}`);
    },
    [onClose, router],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        go(items[active]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, active, go, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-[var(--hairline-strong)] bg-[var(--color-bg-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-3 border-b border-[var(--hairline)] px-4">
          <MagnifyingGlass size={18} className="text-[var(--color-text-muted)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tokens or @usernames..."
            className="h-14 flex-1 bg-transparent font-sans text-[15px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)]"
          />
          <kbd className="rounded border border-[var(--hairline)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text-muted)]">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[52vh] overflow-y-auto px-2 py-2">
          {items.length === 0 ? (
            <p className="px-2 py-6 text-center font-sans text-[13px] text-[var(--color-text-muted)]">
              {query.trim() ? `Nothing matches “${query}”.` : "Type to search tokens and people."}
            </p>
          ) : (
            <>
              {tokenResults.length > 0 && (
                <div className="flex items-center gap-1.5 px-2 py-2 font-mono text-[11px] uppercase tracking-wider text-[var(--color-text-subtle)]">
                  <TrendUp size={12} />
                  {query.trim() ? "Tokens" : "Top 5 by market cap"}
                </div>
              )}
              {tokenResults.map((t, i) => {
                const idx = i;
                const cap =
                  (Number(t.current_price) / 1e6) * t.market.solUsd * DEFAULT_TOKEN_SUPPLY;
                const change = t.price_change_24h;
                return (
                  <button
                    key={t.address}
                    type="button"
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => go(items[idx])}
                    className={`flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors ${
                      idx === active ? "bg-[var(--color-bg-raised)]" : "hover:bg-[var(--color-bg-raised)]"
                    }`}
                  >
                    <div className="h-9 w-9 shrink-0 overflow-hidden rounded-md border border-[var(--hairline)] bg-[var(--color-bg-raised)]">
                      {t.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={t.image} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <span className="flex h-full items-center justify-center font-mono text-xs text-[var(--color-text-subtle)]">
                          {t.symbol?.slice(0, 1)}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="font-display text-[14px] font-semibold text-[var(--color-accent-strong)]">
                        {t.symbol}
                      </span>
                      <span className="ml-2 truncate font-sans text-[13px] text-[var(--color-text-secondary)]">
                        {t.name}
                      </span>
                    </div>
                    <span className="font-mono text-[13px] font-semibold text-[var(--color-text-primary)]">
                      {usd(cap)}
                    </span>
                    <span
                      className={`w-14 text-right font-mono text-[12px] ${
                        change == null ? "text-[var(--color-text-subtle)]" : change >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"
                      }`}
                    >
                      {change == null ? "-" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`}
                    </span>
                  </button>
                );
              })}

              {topUsers.length > 0 && (
                <div className="flex items-center gap-1.5 px-2 py-2 font-mono text-[11px] uppercase tracking-wider text-[var(--color-text-subtle)]">
                  <User size={12} /> Top users
                </div>
              )}
              {topUsers.map((u, i) => {
                const idx = tokenResults.length + i;
                return (
                  <button
                    key={`c-${u.address}`}
                    type="button"
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => go(items[idx])}
                    className={`flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors ${
                      idx === active ? "bg-[var(--color-bg-raised)]" : "hover:bg-[var(--color-bg-raised)]"
                    }`}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--hairline)] bg-[var(--color-bg-raised)]">
                      {u.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={u.image} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <User size={16} weight="fill" className="text-[var(--color-text-subtle)]" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="font-mono text-[14px] font-semibold text-[var(--color-text-primary)]">
                        {shortAddr(u.address)}
                      </span>
                    </div>
                    <span className="font-mono text-[13px] font-semibold text-[var(--color-text-primary)]">
                      {usd(u.launchedValue)}
                    </span>
                    <span className="w-14 text-right font-mono text-[11px] uppercase tracking-wider text-[var(--color-text-subtle)]">
                      Creator
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 border-t border-[var(--hairline)] px-4 py-2.5 font-mono text-[11px] text-[var(--color-text-subtle)]">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
        </div>
      </div>
    </div>
  );
}

function usd(v: number): string {
  return Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(v || 0);
}

function shortAddr(a: string): string {
  return a.length <= 14 ? a : `${a.slice(0, 8)}…${a.slice(-4)}`;
}
