"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react";
import { HORNS, HORN_CATEGORIES, type Horn } from "@/lib/horns-catalog";
import { HornCodeViewer } from "@/components/utoken/horn-code-viewer";
import { HornLivePools } from "@/components/trading/horn-live-pools";

/**
 * Horns explorer. Pick any Horn to read what it does, see a concrete example of
 * it in action, and preview its real CosmWasm source (served verbatim from
 * /public/horns). Honest content, no fabricated numbers; live staking figures
 * activate as the program wires in. Switching Horns animates the detail swap.
 */
export default function HornsPage() {
  const [slug, setSlug] = useState<string>(HORNS[0].slug);
  const selected = HORNS.find((h) => h.slug === slug) ?? HORNS[0];

  return (
    <div className="font-sans text-[var(--color-text-primary)]">
      {/* Hero */}
      <div className="max-w-3xl">
        <div className="flex items-center gap-2">
          <span className="font-display text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-accent-strong)]">
            Horns
          </span>
        </div>
        <h1 className="mt-3 font-display text-[32px] font-bold leading-[1.05] tracking-tight text-[var(--color-text-primary)]">
          Hooks that pay ANSEM and CHANSE holders.
        </h1>
        <p className="mt-3 text-[14px] leading-6 text-[var(--color-text-secondary)]">
          Horns are v4-style hooks on the graduation AMM. When a coin graduates, its creator can attach
          one or more Horns that skim a slice of every swap fee to the{" "}
          <span className="text-[var(--color-text-primary)]">Horn Vault</span>, where ANSEM and CHANSE stakers earn it, or
          reshape how the pool prices, gates, and fills trades. Pick any Horn to read what it does and
          preview its real source.
        </p>
      </div>

      {/* Live pools: every graduated LP running a Horn, with real fee + timer. */}
      <div className="mt-8">
        <HornLivePools />
      </div>

      {/* Explorer */}
      <div className="mt-8 grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* List */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="space-y-4">
            {HORN_CATEGORIES.map((cat) => {
              const items = HORNS.filter((h) => h.category === cat);
              if (!items.length) return null;
              return (
                <div key={cat}>
                  <p className="px-1 pb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-subtle)]">
                    {cat}
                  </p>
                  <div className="space-y-0.5">
                    {items.map((h) => {
                      const active = h.slug === slug;
                      return (
                        <button
                          key={h.slug}
                          type="button"
                          onClick={() => setSlug(h.slug)}
                          className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                            active ? "bg-[var(--color-bg-surface)] ring-1 ring-[#2a2a30]" : "hover:bg-[var(--color-bg-page)]"
                          }`}
                        >
                          <HornLogo horn={h} size={30} />
                          <span className="min-w-0 flex-1">
                            <span className={`block truncate text-[13px] font-semibold ${active ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-secondary)]"}`}>
                              {h.name}
                            </span>
                            <span className="block truncate text-[11px] text-[var(--color-text-subtle)]">{h.tagline}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* Detail + code (swaps with an animation on horn change) */}
        <div className="min-w-0">
          <div key={selected.slug} className="horn-swap space-y-5">
            <HornDetail horn={selected} />
            <HornCodeViewer slug={selected.slug} />
          </div>
        </div>
      </div>

      {/* Build on it */}
      <section className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-bg-page)]/80 p-5">
        <div>
          <h2 className="font-display text-[13px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-primary)]">
            Build on Horns
          </h2>
          <p className="mt-2 max-w-2xl text-[13px] leading-6 text-[var(--color-text-secondary)]">
            A Horn is any contract that answers the AMM&apos;s hook interface:{" "}
            <span className="font-mono text-[var(--color-text-secondary)]">before_swap</span> to price or gate a trade,{" "}
            <span className="font-mono text-[var(--color-text-secondary)]">after_swap</span> to act on it. The Vault takes
            deposits permissionlessly, so a new Horn can route value to stakers without changing anything
            else. Attach it at graduation; the pool does the rest.
          </p>
        </div>
        <Link
          href="/create"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[4px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3.5 py-2 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-border)] hover:text-[var(--color-text-primary)]"
        >
          Launch a coin <ArrowRight size={13} weight="bold" />
        </Link>
      </section>

      <p className="mt-6 text-center text-[11px] text-[var(--color-text-subtle)]">
        Sources are the real CosmWasm contracts under contracts/horn-*. Live staking and per-pool figures
        activate as the program is wired to the indexer.
      </p>
    </div>
  );
}

/**
 * Per-Horn logo. Renders the assigned icon image when `horn.icon` is set;
 * otherwise a neutral monogram so the layout is final and icons drop in later.
 */
/** Renders the Horn's assigned logo when one is set; nothing otherwise (no
 *  placeholder monogram). Real icons drop straight in via `horn.icon`. */
function HornLogo({ horn, size }: { horn: Horn; size: number }) {
  if (!horn.icon) return null;
  return (
    <span className="shrink-0" style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={horn.icon}
        alt=""
        className="h-full w-full object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,0.5)]"
      />
    </span>
  );
}

function HornDetail({ horn }: { horn: Horn }) {
  return (
    <section className="rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-bg-page)]/80 p-5">
      <div className="flex items-start gap-3">
        <HornLogo horn={horn} size={64} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)]">{horn.name}</h2>
            <span className="rounded-[4px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              {horn.category}
            </span>
          </div>
          <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">{horn.tagline}</p>
        </div>
      </div>

      <p className="mt-3 text-[14px] leading-6 text-[var(--color-text-secondary)]">{horn.blurb}</p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {horn.hooks.map((h) => (
          <span key={h} className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-secondary)]">
            {h}
          </span>
        ))}
      </div>

      <ul className="mt-4 space-y-2">
        {horn.points.map((p) => (
          <li key={p} className="flex gap-2 text-[13px] leading-5 text-[var(--color-text-secondary)]">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--color-accent-solid)]" />
            {p}
          </li>
        ))}
      </ul>

      {/* Concrete example, kept understated. */}
      <div className="mt-5 rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] p-4">
        <span className="font-display text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
          Example
        </span>
        <p className="mt-2 text-[13px] leading-6 text-[var(--color-text-secondary)]">{horn.example}</p>
      </div>
    </section>
  );
}
