"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useTokens } from "@/hooks/use-tokens";

// fomo-style token search: magnifier + "/" hotkey, live dropdown of matches.
export function TokenSearch() {
  const { data: tokens } = useTokens();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return [];
    return (tokens ?? [])
      .filter((t) =>
        [t.name, t.symbol, t.address, t.mint].some((v) => v?.toLowerCase().includes(n)),
      )
      .slice(0, 8);
  }, [q, tokens]);

  return (
    <div className="relative w-full max-w-md">
      <MagnifyingGlass
        size={15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-subtle)]"
      />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        placeholder="search coins..."
        className="h-9 w-full rounded-[4px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] pl-9 pr-9 text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-subtle)] focus:border-[var(--color-border-soft)] focus:outline-none"
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-[3px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-subtle)]">
        /
      </span>
      {open && results.length > 0 && (
        <div className="absolute left-0 right-0 top-12 z-30 overflow-hidden rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-bg-page)]/80 shadow-xl">
          {results.map((t) => (
            <Link
              key={t.address}
              href={`/token/${t.address}`}
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-[var(--color-bg-page)]"
            >
              {t.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={t.image} alt="" className="h-8 w-8 shrink-0 rounded-lg object-cover" />
              ) : (
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-xs font-bold text-[var(--color-text-secondary)]">
                  {t.symbol?.[0]}
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-[var(--color-text-primary)]">{t.name}</p>
                <p className="truncate text-[11px] font-semibold text-[var(--color-text-muted)]">${t.symbol}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
