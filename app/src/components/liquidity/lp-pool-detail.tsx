"use client";

/**
 * One LP pool: what it holds, where its depth actually sits, and the form for
 * putting USDG in and taking it back out.
 *
 * The depth chart here is the one this page used to have, wired to the pool
 * instead of drawn. It was removed for a good reason (it was hardcoded HYPE and
 * USDC on a page about the Desk, which is not a concentrated liquidity pool and
 * has no distribution to draw), and it belongs back now that the page is about
 * a real v4 pool that does. Every bar is the liquidity active across one tick
 * spacing, walked out from the pool's own active tick.
 *
 * Everything on the right is about THIS pool and THIS launch. None of it is the
 * global Desk balance sheet, which is a different venue and was what made the
 * old panel read as generic.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import styles from "./liquidity.module.css";
import own from "./lp-pools.module.css";
import type { LpPoolRow } from "./lp-pools-section";

interface DepthBar {
  tick: number;
  liquidity: string;
  side: "bid" | "ask";
}

interface Payload {
  pool: LpPoolRow;
  depth: DepthBar[];
  network: { explorer: string };
  error?: string;
}

const Q96 = 2 ** 96;

function sqrtAtTick(tick: number) {
  return Math.pow(1.0001, tick / 2);
}

/** token1 per token0 at this sqrt price, decimal-corrected. */
function priceAt(sqrt: number, d0: number, d1: number) {
  return sqrt * sqrt * 10 ** (d0 - d1);
}

function fmt(n: number, max = 6) {
  if (!Number.isFinite(n)) return "0";
  if (n !== 0 && Math.abs(n) < 0.000001) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

/**
 * The amounts a range needs, per unit of liquidity, at the current price.
 * Used to turn "I want to add this much USDG" into both sides and a liquidity
 * figure. Float precision is fine here because the transaction is capped by
 * amount0Max / amount1Max and the pool computes the exact amounts itself.
 */
function amountsPerLiquidity(sqrtP: number, sqrtA: number, sqrtB: number) {
  const lo = Math.min(sqrtA, sqrtB);
  const hi = Math.max(sqrtA, sqrtB);
  if (sqrtP <= lo) return { per0: (hi - lo) / (lo * hi), per1: 0 };
  if (sqrtP >= hi) return { per0: 0, per1: hi - lo };
  return { per0: (hi - sqrtP) / (sqrtP * hi), per1: sqrtP - lo };
}

export function LpPoolDetail() {
  const params = useParams<{ pool: string }>();
  const poolId = (params?.pool ?? "").toLowerCase();
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [widthSteps, setWidthSteps] = useState(1);

  useEffect(() => {
    let live = true;
    setData(null);
    setErr(null);
    fetch(`/api/float/lp-pools/${poolId}`)
      .then(async (r) => {
        const j = await r.json();
        if (!live) return;
        if (!r.ok || j.error) setErr(j.error ?? `pool not readable (${r.status})`);
        else setData(j as Payload);
      })
      .catch((e) => live && setErr(String(e)));
    return () => {
      live = false;
    };
  }, [poolId]);

  const chart = useMemo(() => {
    if (!data?.depth?.length) return null;
    const bars = data.depth;
    const max = bars.reduce((m, b) => Math.max(m, Number(BigInt(b.liquidity))), 0);
    if (max <= 0) return null;
    const W = 600;
    const H = 330;
    const floor = 294;
    const top = 28;
    const bw = W / bars.length;
    return {
      W,
      H,
      floor,
      top,
      // the current tick sits between the last bid bar and the first ask bar
      mid: (bars.filter((b) => b.side === "bid").length / bars.length) * W,
      bars: bars.map((b, i) => {
        const h = (Number(BigInt(b.liquidity)) / max) * (floor - top);
        return { ...b, x: i * bw + 1, w: Math.max(1, bw - 2), y: floor - h, h };
      }),
    };
  }, [data]);

  const quote = useMemo(() => {
    if (!data) return null;
    const p = data.pool;
    // Deposit the USDG side where there is one. Which index that is depends on
    // address ordering, not on convention, so it comes from the pool rather
    // than being assumed: on this very pool USDG is currency0.
    const side: 0 | 1 = p.usdgSide ?? 1;
    const sqrtP = Number(BigInt(p.sqrtPriceX96)) / Q96;
    const spacing = p.key.tickSpacing;
    const base = Math.floor(p.tick / spacing) * spacing;
    const tickLower = base - widthSteps * spacing;
    const tickUpper = base + (widthSteps + 1) * spacing;
    const { per0, per1 } = amountsPerLiquidity(sqrtP, sqrtAtTick(tickLower), sqrtAtTick(tickUpper));
    const amt = Number(amount || "0");
    const dec = side === 0 ? p.decimals0 : p.decimals1;
    const per = side === 0 ? per0 : per1;
    if (!(amt > 0) || !(per > 0)) {
      return { side, tickLower, tickUpper, need0: 0, need1: 0, liquidity: 0, oneSided: per <= 0 };
    }
    const liquidity = (amt * 10 ** dec) / per;
    return {
      side,
      tickLower,
      tickUpper,
      liquidity,
      need0: (liquidity * per0) / 10 ** p.decimals0,
      need1: (liquidity * per1) / 10 ** p.decimals1,
      oneSided: false,
    };
  }, [data, amount, widthSteps]);

  // Where the depth actually is. The seeder concentrates at the peg and thins
  // outward, so the useful summary is the band carrying the peak and how much
  // denser it is than the tail, which is the number that decides whether a
  // trade of any size can route through this hop.
  const band = useMemo(() => {
    if (!data?.depth?.length) return null;
    const bars = data.depth;
    const peak = bars.reduce((m, b) => (BigInt(b.liquidity) > BigInt(m.liquidity) ? b : m), bars[0]);
    const peakL = BigInt(peak.liquidity);
    if (peakL === 0n) return null;
    const inBand = bars.filter((b) => BigInt(b.liquidity) === peakL).map((b) => b.tick);
    const outside = bars.map((b) => BigInt(b.liquidity)).filter((l) => l > 0n && l < peakL);
    const tail = outside.length ? outside.reduce((a, b) => (a < b ? a : b)) : 0n;
    return {
      lo: Math.min(...inBand),
      hi: Math.max(...inBand) + (data.pool.key.tickSpacing ?? 0),
      peak: peakL,
      tail,
      ratio: tail > 0n ? Number(peakL / tail) : null,
    };
  }, [data]);

  if (err) {
    return (
      <div className={styles.detailPage}>
        <p className={own.warn}>This pool could not be read: {err}</p>
      </div>
    );
  }
  if (!data || !quote) {
    return (
      <div className={styles.detailPage}>
        <p className={own.note}>Reading the pool from chain…</p>
      </div>
    );
  }

  const p = data.pool;
  const price = priceAt(Number(BigInt(p.sqrtPriceX96)) / Q96, p.decimals0, p.decimals1);
  const rows: Array<[string, string]> = [
    ["Pair", `${p.symbol0} / ${p.symbol1}`],
    ["Hop", p.kind === "meme" ? `${p.launch.symbol} priced in its stock` : "the stock priced in USDG"],
    ["Fee to providers", `${p.lpFeeBps / 100}%`],
    ["Price", `${fmt(price)} ${p.symbol1} per ${p.symbol0}`],
    ["Current tick", p.tick.toLocaleString("en-US")],
    ["Tick spacing", String(p.key.tickSpacing)],
    ["Active liquidity", BigInt(p.liquidity).toLocaleString("en-US")],
    ["Launch", p.launch.symbol],
    ["Launcher", `${p.launch.launcher.slice(0, 10)}…${p.launch.retired ? " (superseded)" : ""}`],
    ["Hook", p.key.hooks === "0x0000000000000000000000000000000000000000" ? "none" : p.key.hooks],
    ["Pool id", `${p.poolId.slice(0, 12)}…`],
  ];

  return (
    <div className={styles.detailPage}>
      <nav className={styles.breadcrumbs}>
        <Link href="/liquidity">Liquidity</Link> <span>›</span> <span>{p.symbol0} / {p.symbol1}</span>
      </nav>

      <div className={styles.detailGrid}>
      <section className={styles.marketPanel}>
        <div className={styles.poolHeading}>
          <div>
            <span className={own.eyebrow}>{p.launch.symbol} · {p.kind === "meme" ? "meme hop" : "quote hop"}</span>
            <h1 className={styles.pageTitle}>{p.symbol0} / {p.symbol1} pool</h1>
            <div className={own.badges}>
              <span className={own.badge}>{p.lpFeeBps / 100}% fee</span>
              <span className={own.badge}>spacing {p.key.tickSpacing}</span>
              {p.launch.retired ? <span className={`${own.badge} ${own.badgeRetired}`}>earlier launcher</span> : null}
            </div>
          </div>
        </div>

        <p className={styles.pageDescription}>
          A public Uniswap v4 pool. Add {p.symbol1} or {p.symbol0} across a price range, earn{" "}
          {p.lpFeeBps / 100}% of everything that trades through that range, and withdraw whenever you
          like. Your position is yours: no lockup, no epoch, and no share in anybody else&apos;s book.
        </p>

        {chart ? (
          <div className={styles.chartCard}>
            <div className={styles.chartHeader}>
              <span>Liquidity by price</span>
              <span className={own.sub}>
                depth across {chart.bars.length} ticks either side of the current price
              </span>
            </div>
            <svg
              className={styles.depthChart}
              viewBox={`0 0 ${chart.W} ${chart.H}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`Liquidity distribution for the ${p.symbol0} ${p.symbol1} pool, read from the pool's own ticks`}
            >
              <line className={styles.chartGridLine} x1="0" y1="80" x2={chart.W} y2="80" />
              <line className={styles.chartGridLine} x1="0" y1="165" x2={chart.W} y2="165" />
              <line className={styles.chartGridLine} x1="0" y1="250" x2={chart.W} y2="250" />
              {chart.bars.map((b) => (
                <rect
                  key={b.tick}
                  className={b.side === "bid" ? styles.chartBid : styles.chartAsk}
                  x={b.x.toFixed(2)}
                  y={b.y.toFixed(2)}
                  width={b.w.toFixed(2)}
                  height={Math.max(0, b.h).toFixed(2)}
                />
              ))}
              <line
                className={styles.chartMid}
                x1={chart.mid.toFixed(2)}
                y1={chart.top}
                x2={chart.mid.toFixed(2)}
                y2={chart.floor + 10}
              />
            </svg>
          </div>
        ) : (
          <p className={own.warn}>
            The pool&apos;s tick liquidity could not be read, so the distribution is not shown rather
            than drawn flat.
          </p>
        )}

        <div className={styles.formSection}>
          <h2 className={styles.sectionTitle}>Provide liquidity</h2>
          <label className={styles.fieldLabel} htmlFor="lp-amount">
            {quote.side === 0 ? p.symbol0 : p.symbol1} to add
          </label>
          <div className={styles.amountInputWrap}>
            <input
              id="lp-amount"
              className={styles.amountInput}
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            />
            <span className={styles.tokenSelect}>{quote.side === 0 ? p.symbol0 : p.symbol1}</span>
          </div>

          <div className={styles.rangeOptions}>
            {[1, 3, 10].map((w) => (
              <button
                key={w}
                type="button"
                className={`${styles.rangeButton} ${widthSteps === w ? styles.rangeButtonActive : ""}`}
                onClick={() => setWidthSteps(w)}
              >
                {w === 1 ? "Tight" : w === 3 ? "Medium" : "Wide"}
              </button>
            ))}
          </div>

          <div className={styles.metricRows}>
            <div className={styles.metricRow}>
              <span className={styles.metricLabel}>Range</span>
              <strong>
                ticks {quote.tickLower.toLocaleString("en-US")} to {quote.tickUpper.toLocaleString("en-US")}
              </strong>
            </div>
            <div className={styles.metricRow}>
              <span className={styles.metricLabel}>{quote.side === 0 ? p.symbol0 : p.symbol1} used</span>
              <strong>{fmt(quote.side === 0 ? quote.need0 : quote.need1)}</strong>
            </div>
            <div className={styles.metricRow}>
              <span className={styles.metricLabel}>{quote.side === 0 ? p.symbol1 : p.symbol0} also required</span>
              <strong>{fmt(quote.side === 0 ? quote.need1 : quote.need0)}</strong>
            </div>
          </div>

          <button type="button" className={styles.primaryButton} disabled>
            Connect a wallet to add liquidity
          </button>
          <p className={own.note}>
            A deposit goes through Permit2 and the v4 PositionManager, both live on this chain. The
            amounts above are what the range needs at the current price; the transaction caps what
            can be pulled, so a price move while it is in flight cannot take more than you agreed.
          </p>
        </div>
      </section>

      <aside className={styles.marketPanel} aria-label="Pool information">
      <section className={styles.metrics}>
        <h2 className={styles.metricsTitle}>This pool</h2>
        <div className={styles.metricRows}>
          {rows.map(([label, value]) => (
            <div className={styles.metricRow} key={label}>
              <span className={styles.metricLabel}>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </section>

      {band ? (
        <section className={styles.metrics}>
          <h2 className={styles.metricsTitle}>Where the depth sits</h2>
          <div className={styles.metricRows}>
            <div className={styles.metricRow}>
              <span className={styles.metricLabel}>Concentrated band</span>
              <strong>
                ticks {band.lo.toLocaleString("en-US")} to {band.hi.toLocaleString("en-US")}
              </strong>
            </div>
            <div className={styles.metricRow}>
              <span className={styles.metricLabel}>Liquidity in the band</span>
              <strong>{band.peak.toLocaleString("en-US")}</strong>
            </div>
            <div className={styles.metricRow}>
              <span className={styles.metricLabel}>Liquidity in the tail</span>
              <strong>{band.tail > 0n ? band.tail.toLocaleString("en-US") : "none"}</strong>
            </div>
            {band.ratio ? (
              <div className={styles.metricRow}>
                <span className={styles.metricLabel}>Denser at the peg by</span>
                <strong className={own.accent}>{band.ratio.toLocaleString("en-US")}x</strong>
              </div>
            ) : null}
          </div>
          <p className={own.note}>
            A pegged pair has nowhere for the price to go, so depth belongs at the peg rather than
            spread across prices that cannot print. Adding inside the band earns the most fees and
            takes the most price risk if the peg moves.
          </p>
        </section>
      ) : null}
      </aside>
      </div>
    </div>
  );
}
