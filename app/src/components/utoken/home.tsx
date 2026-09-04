"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "@phosphor-icons/react";
import { useTokens } from "@/hooks/use-tokens";
import { Sparkline } from "@/components/utoken/sparkline";
import { DEFAULT_TOKEN_SUPPLY } from "@/lib/chain-config";
import { fetchGraduationThreshold, type TokenListItem } from "@/lib/api";

export function UtokenHome() {
  const { data: tokens, isLoading } = useTokens();
  const { data: threshold = 0 } = useQuery({
    queryKey: ["graduation-threshold"],
    queryFn: fetchGraduationThreshold,
  });

  const ranked = useMemo(
    () =>
      [...(tokens ?? [])].sort(
        (a, b) => capUsd(b) - capUsd(a),
      ),
    [tokens],
  );
  const featured = ranked.slice(0, 18);

  return (
    <div className="space-y-12 font-sans">
      <Hero />

      {/* Continuous alternating live-token lanes */}
      <section className="w-full max-w-none">
        <div className="mb-4">
          <div>
            <h2 className="font-display text-[24px] font-semibold tracking-tight text-[var(--color-text-primary)]">
              Live coins
            </h2>
            <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">
              Launches moving across the curve and into the ANSEM AMM.
            </p>
          </div>
        </div>
        {isLoading ? (
          <div className="live-token-lanes">
            {Array.from({ length: 18 }).map((_, i) => (
              <div key={i} className="h-[220px] animate-pulse rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)]" />
            ))}
          </div>
        ) : (
          <FeaturedCarousel items={featured} thresholdMicro={threshold} />
        )}
      </section>

      {/* Registry */}
      <Registry tokens={ranked} loading={isLoading} />
    </div>
  );
}

/* ---------------- Hero ---------------- */

type HeroSlide = {
  badge: string;
  l1: string;
  l2: string;
  accent: "l1" | "l2" | "none";
  body: React.ReactNode;
  ctas: Array<{ href: string; label: string; primary?: boolean }>;
};

const HERO_SLIDES: HeroSlide[] = [
  {
    badge: "Horns · live on every pool",
    l1: "COINS THAT PAY",
    l2: "THEIR HOLDERS.",
    accent: "l2",
    body: (
      <>
        Every coin launches on a bonding curve and graduates to the ANSEM AMM. A{" "}
        <span className="text-[var(--color-on-accent)]">Horn</span> skims a slice of every swap fee to CHANSE and ANSEM
        stakers, so real trading becomes real yield.
      </>
    ),
    ctas: [
      { href: "/create", label: "Launch a coin", primary: true },
      { href: "/explore", label: "Explore coins" },
    ],
  },
  {
    badge: "The launch",
    l1: "LAUNCH ON A CURVE.",
    l2: "GRADUATE TO THE AMM.",
    accent: "none",
    body: (
      <>
        No presale, no team allocation. Your coin opens on a fair bonding curve, and once it fills it
        graduates straight into a live ANSEM AMM pool with <span className="text-[var(--color-on-accent)]">Horns</span>{" "}
        attached from block one.
      </>
    ),
    ctas: [
      { href: "/create", label: "Launch a coin", primary: true },
      { href: "/horns", label: "How it works" },
    ],
  },
  {
    badge: "Stake · earn the skim",
    l1: "STAKE ANSEM OR CHANSE.",
    l2: "EARN EVERY POOL'S FEES.",
    accent: "l2",
    body: (
      <>
        Stake into the <span className="text-[var(--color-on-accent)]">Horn Vault</span> and collect a per-block cut of
        the fees skimmed from every graduated pool, in both CHANSE and ANSEM. One vault, two sinks.
      </>
    ),
    ctas: [
      { href: "/vault", label: "Open the Vault", primary: true },
      { href: "/horns", label: "Explore Horns" },
    ],
  },
];

const HERO_DURATION = 7000;

// Banner art behind the hero. Drop the files at these paths in /public/hero/;
// a missing file simply shows the base background (no broken-image icon).
const HERO_IMAGES = ["/hero/bull-ride.png", "/hero/bull-eyes.png", "/hero/bull-rest.png"];

function Hero() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const id = window.setTimeout(() => setActive((a) => (a + 1) % HERO_SLIDES.length), HERO_DURATION);
    return () => window.clearTimeout(id);
  }, [active, paused]);

  const slide = HERO_SLIDES[active];

  return (
    <section
      className="relative h-[clamp(300px,32vw,460px)] overflow-hidden rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-bg-page)]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Banner art: the bull images, cross-fading with the slides. Both layers
          stay mounted so the opacity swap is a smooth cross-fade. */}
      <div className="pointer-events-none absolute inset-0">
        {HERO_IMAGES.map((src, i) => (
          <div
            key={src}
            className="absolute inset-0 bg-cover bg-center transition-opacity duration-[900ms] ease-out"
            style={{
              backgroundImage: `url(${src})`,
              opacity: i === active % HERO_IMAGES.length ? 1 : 0,
            }}
          />
        ))}
      </div>
      {/* Legibility masks: solid only under the left copy, then clearing early so
          the art stays visible on the right. Kept light on purpose. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#0c0c0e] from-[0%] via-[#0c0c0e]/50 via-[40%] to-transparent to-[70%]" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#0c0c0e]/60 via-transparent to-transparent" />

      {/* Content overlay, vertically centered so the section height is driven by
          the banner aspect (full image visible), not the copy. Text carries its
          own shadow so it stays legible over the bright frames of the art. */}
      <div className="absolute inset-0 flex flex-col justify-center px-6 sm:px-8">
        <div key={active} className="ansem-hero-slide max-w-2xl">
          <h1
            className="font-display text-[32px] font-bold leading-[0.98] tracking-[-0.02em] text-[var(--color-on-accent)] sm:text-[50px]"
            style={{ textShadow: "0 2px 22px rgba(4,4,6,0.92), 0 1px 4px rgba(4,4,6,0.95)" }}
          >
            <span className={slide.accent === "l1" ? "text-[#a9c7ff]" : undefined}>{slide.l1}</span>
            <br />
            <span className={slide.accent === "l2" ? "text-[#a9c7ff]" : undefined}>{slide.l2}</span>
          </h1>

          <p
            className="mt-4 max-w-xl font-sans text-[14px] leading-6 text-[var(--color-on-accent)] sm:text-[15px]"
            style={{ textShadow: "0 1px 12px rgba(4,4,6,0.95), 0 1px 3px rgba(4,4,6,0.98)" }}
          >
            {slide.body}
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            {slide.ctas.map((c) =>
              c.primary ? (
                <Link
                  key={c.href}
                  href={c.href}
                  className="inline-flex h-11 items-center gap-1.5 rounded-[4px] bg-[var(--color-accent-solid)] px-5 font-display text-[14px] font-semibold text-[var(--color-on-accent)] transition-colors hover:bg-[var(--color-accent-strong)]"
                >
                  {c.label} <ArrowRight size={15} weight="bold" />
                </Link>
              ) : (
                <Link
                  key={c.href}
                  href={c.href}
                  className="inline-flex h-11 items-center rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-5 font-display text-[14px] font-semibold text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-border)]"
                >
                  {c.label}
                </Link>
              ),
            )}
          </div>
        </div>

        {/* Time-decay pager, anchored to the bottom of the banner */}
        <div className="absolute bottom-4 left-6 flex items-center gap-2 sm:left-8">
          {HERO_SLIDES.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Slide ${i + 1}`}
              onClick={() => setActive(i)}
              className="group flex h-4 items-center"
            >
              {i === active ? (
                <span className="relative h-1.5 w-8 overflow-hidden rounded-full bg-[#2f2f36]">
                  <span
                    key={active}
                    className="ansem-hero-fill absolute inset-y-0 left-0 rounded-full bg-[var(--color-bg-surface)]"
                    style={{ animationDuration: `${HERO_DURATION}ms`, animationPlayState: paused ? "paused" : "running" }}
                  />
                </span>
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-[#3f3f46] transition-colors group-hover:bg-white" />
              )}
            </button>
          ))}
        </div>
      </div>

    </section>
  );
}

/* ---------------- Featured card ---------------- */

/* ---------------- Continuous vertical carousel ---------------- */

function subscribeToCarouselColumns(onChange: () => void) {
  const queries = [640, 900].map((width) => window.matchMedia(`(min-width: ${width}px)`));
  queries.forEach((query) => query.addEventListener("change", onChange));
  return () => queries.forEach((query) => query.removeEventListener("change", onChange));
}

function carouselColumnSnapshot() {
  if (window.matchMedia("(min-width: 900px)").matches) return 4;
  if (window.matchMedia("(min-width: 640px)").matches) return 2;
  return 1;
}

function FeaturedCarousel({ items, thresholdMicro }: { items: TokenListItem[]; thresholdMicro: number }) {
  const columnCount = useSyncExternalStore(
    subscribeToCarouselColumns,
    carouselColumnSnapshot,
    () => 1,
  );

  if (items.length === 0) {
    return (
      <div className="flex h-[320px] items-center justify-center border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] text-sm text-[var(--color-text-muted)]">
        No coins launched yet.
      </div>
    );
  }

  const lanes = Array.from({ length: columnCount }, (_, column) => {
    const assigned = items.filter((_, index) => index % columnCount === column);
    const seed = assigned.length > 0 ? assigned : items;
    return Array.from({ length: Math.max(1, Math.ceil(4 / seed.length)) }, () => seed).flat();
  });

  return (
    <div className="live-token-lanes" aria-label="Live token carousel">
      {lanes.map((lane, column) => (
        <div className="live-token-lane" key={column}>
          <div
            className={`live-token-lane-track ${column % 2 === 0 ? "live-token-lane-track--up" : "live-token-lane-track--down"}`}
            style={{ animationDuration: `${Math.max(28, (lane.length * 300) / 29)}s` }}
          >
            <div className="live-token-lane-set">
              {lane.map((token, index) => (
                <FeaturedCard
                  key={`${token.address}-primary-${index}`}
                  token={token}
                  thresholdMicro={thresholdMicro}
                />
              ))}
            </div>
            <div className="live-token-lane-set" aria-hidden="true">
              {lane.map((token, index) => (
                <FeaturedCard
                  key={`${token.address}-duplicate-${index}`}
                  token={token}
                  thresholdMicro={thresholdMicro}
                  duplicate
                />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function FeaturedCard({
  token,
  thresholdMicro,
  duplicate = false,
}: {
  token: TokenListItem;
  thresholdMicro: number;
  duplicate?: boolean;
}) {
  const change = token.price_change_24h;
  const graduated = token.graduated;
  const raised = Number(token.hodl_reserves) || 0;
  const pct = graduated ? 100 : thresholdMicro > 0 ? Math.min(100, Math.max(2, (raised / thresholdMicro) * 100)) : 4;
  return (
    <Link
      href={`/token/${token.address}`}
      tabIndex={duplicate ? -1 : undefined}
      className="group block shrink-0 bg-[var(--color-bg-page)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-solid)]"
    >
      <div className="w-full overflow-hidden bg-[var(--color-bg-raised)]">
        {token.image ? (
          // Keep the source aspect ratio so the entire token image is visible.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={token.image} alt={`${token.name} token artwork`} className="block h-auto w-full" />
        ) : (
          <div className="flex aspect-square w-full items-center justify-center font-display text-[clamp(2rem,5vw,4rem)] font-semibold text-[var(--color-text-subtle)]">
            {token.symbol?.slice(0, 1) || "?"}
          </div>
        )}
      </div>

      <div className="px-0.5 pb-2 pt-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-display text-[13px] font-semibold uppercase leading-[1.15] tracking-[0.03em] text-[var(--color-text-primary)]">
              {token.name}
            </p>
            <p className="mt-1 font-mono text-[10px] font-semibold text-[var(--color-accent-strong)]">
              ${token.symbol}
            </p>
          </div>
          {graduated && <VenueBadge token={token} />}
        </div>

        <p className="mt-2 text-[11px] leading-[1.28] text-[var(--color-text-secondary)]">
          {token.description?.trim() || `${token.name} is trading live on the ANSEM market.`}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px]">
          <span className="text-[var(--color-text-muted)]">Mkt cap</span>
          <span className="font-semibold text-[var(--color-text-primary)]">{usd(capUsd(token))}</span>
          {change != null && (
            <span className={change >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}>
              {change >= 0 ? "+" : ""}{change.toFixed(1)}%
            </span>
          )}
          {!graduated && <span className="ml-auto text-[var(--color-text-secondary)]">{pct.toFixed(0)}%</span>}
        </div>
      </div>

      {!graduated && (
        <div className="h-0.5 w-full bg-[var(--color-border-soft)]">
          <div className="h-full bg-[var(--color-accent-solid)] transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}
    </Link>
  );
}

/* ---------------- Registry ---------------- */

type Filter = "all" | "curve" | "amm";

function Registry({ tokens, loading }: { tokens: TokenListItem[]; loading: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const { data: threshold = 0 } = useQuery({
    queryKey: ["graduation-threshold"],
    queryFn: fetchGraduationThreshold,
    staleTime: 5 * 60_000,
  });
  const rows = useMemo(
    () =>
      tokens.filter((t) =>
        filter === "all" ? true : filter === "amm" ? t.graduated : !t.graduated,
      ),
    [tokens, filter],
  );
  const filters: Filter[] = ["all", "curve", "amm"];

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-[24px] font-semibold tracking-tight text-[var(--color-text-primary)]">
          The Bullpen <span className="font-sans text-[13px] font-normal text-[var(--color-text-muted)]">{tokens.length} tokens</span>
        </h2>
        {/* Segmented control with a sliding thumb (spec §7) */}
        <div className="relative grid grid-cols-3 rounded-lg bg-[var(--color-bg-raised)] p-0.5 ring-1 ring-[var(--hairline)]">
          <span
            className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-md bg-[var(--color-accent-solid)] transition-transform duration-200"
            style={{ width: "calc((100% - 4px) / 3)", transform: `translateX(${filters.indexOf(filter) * 100}%)` }}
          />
          {filters.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`relative z-10 h-7 rounded-md px-3 font-sans text-[12px] font-medium transition-colors ${
                filter === f ? "text-[var(--color-on-accent)]" : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              }`}
            >
              {f === "amm" ? "Graduated" : f === "curve" ? "On curve" : "All"}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl bg-[var(--color-bg-surface)] ring-1 ring-[var(--hairline)]">
        <table className="w-full min-w-[860px] text-left">
          <thead>
            <tr className="border-b border-[var(--hairline)] text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-subtle)]">
              <th className="px-4 py-3 font-medium">#</th>
              <th className="px-4 py-3 font-medium">Token</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Price</th>
              <th className="px-4 py-3 text-right font-medium">24h</th>
              <th className="px-4 py-3 font-medium">Trend</th>
              <th className="px-4 py-3 text-right font-medium">Mcap</th>
              <th className="px-4 py-3 text-right font-medium">Holders</th>
              <th className="px-4 py-3 font-medium">Contract</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="px-4 py-10 text-center font-sans text-[13px] text-[var(--color-text-muted)]">Loading registry…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-10 text-center font-sans text-[13px] text-[var(--color-text-muted)]">No tokens.</td></tr>
            ) : (
              rows.map((t, i) => <RegistryRow key={t.address} token={t} rank={i + 1} thresholdMicro={threshold} />)
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RegistryRow({ token, rank, thresholdMicro }: { token: TokenListItem; rank: number; thresholdMicro: number }) {
  const change = token.price_change_24h;
  const priceUsd = (Number(token.current_price) / 1e6) * token.market.solUsd;
  return (
    <tr className="group border-b border-[var(--hairline)] transition-colors last:border-0 hover:bg-[var(--color-bg-raised)]">
      <td className="px-4 py-3 tabular-nums text-[13px] text-[var(--color-text-subtle)]">{rank}</td>
      <td className="px-4 py-3">
        <Link href={`/token/${token.address}`} className="flex items-center gap-2.5">
          <div className="h-8 w-8 shrink-0 overflow-hidden rounded-lg bg-[var(--color-bg-raised)] ring-1 ring-[var(--hairline)]">
            {token.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={token.image} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full items-center justify-center text-[11px] text-[var(--color-text-subtle)]">{token.symbol?.slice(0, 1)}</span>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-[var(--color-accent-strong)] group-hover:underline">{token.symbol}</p>
            <p className="truncate text-[12px] font-medium text-[var(--color-text-muted)]">{token.name}</p>
          </div>
        </Link>
      </td>
      <td className="px-4 py-3"><StatusPill token={token} thresholdMicro={thresholdMicro} /></td>
      <td className="px-4 py-3 text-right tabular-nums text-[13px] text-[var(--color-text-primary)]">
        {priceUsd > 0 ? (priceUsd >= 0.01 ? usd(priceUsd) : `$${Number(priceUsd.toPrecision(2))}`) : "-"}
      </td>
      <td className={`px-4 py-3 text-right text-[13px] font-medium tabular-nums ${change == null ? "text-[var(--color-text-subtle)]" : change >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}`}>
        {change == null ? "-" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`}
      </td>
      <td className="px-4 py-3"><Sparkline address={token.address} up={change == null ? true : change >= 0} /></td>
      <td className="px-4 py-3 text-right tabular-nums text-[13px] text-[var(--color-text-primary)]">{usd(capUsd(token))}</td>
      <td className="px-4 py-3 text-right tabular-nums text-[13px] text-[var(--color-text-secondary)]">{token.trade_count_24h ?? 0}</td>
      <td className="px-4 py-3 tabular-nums text-[12px] text-[var(--color-text-muted)]">{short(token.address)}</td>
    </tr>
  );
}

function VenueBadge({ token }: { token: TokenListItem }) {
  const graduated = token.graduated;
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        graduated ? "bg-[var(--color-accent-solid)]/15 text-[var(--color-accent-strong)]" : "bg-[var(--color-bg-raised)] text-[var(--color-text-secondary)]"
      }`}
    >
      {graduated ? "ANSEM AMM" : "Bonding"}
    </span>
  );
}

/** Status as a progress-bar pill: bonding fill, or full green when graduated. */
function StatusPill({ token, thresholdMicro }: { token: TokenListItem; thresholdMicro: number }) {
  const graduated = token.graduated;
  let pct = 100;
  let label = "Pool on AMM";
  if (!graduated) {
    const raised = Number(token.hodl_reserves) || 0;
    pct = thresholdMicro > 0 ? Math.min(100, Math.max(3, (raised / thresholdMicro) * 100)) : 6;
    label = thresholdMicro > 0 ? `Bonding ${pct.toFixed(0)}%` : "Bonding";
  }
  return (
    <div className="relative h-[19px] w-[148px] overflow-hidden rounded-md bg-[var(--color-bg-raised)]">
      <div
        className={`absolute inset-y-0 left-0 rounded-md ${graduated ? "bg-[var(--color-positive)]/25" : "bg-[var(--color-accent-solid)]/25"}`}
        style={{ width: `${pct}%` }}
      />
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold text-[var(--color-text-primary)]">{label}</span>
    </div>
  );
}

/* helpers */
function capUsd(t: TokenListItem): number {
  return (Number(t.current_price) / 1e6) * t.market.solUsd * DEFAULT_TOKEN_SUPPLY;
}
function usd(v: number): string {
  return Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(v || 0);
}
function short(a: string): string {
  return a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a;
}
