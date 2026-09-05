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
    const vals = bars.map((b) => Number(BigInt(b.liquidity)));
    const max = Math.max(...vals);
    if (max <= 0) return null;
    const minNonZero = Math.min(...vals.filter((v) => v > 0));

    // LOG scale, deliberately. This pool holds 149x more liquidity at the peg
    // than in its tail, and on a linear axis that is three spikes in an empty
    // box with the tail flattened into what looks like a dashed rule. A log
    // axis shows both the band and the shape of the tail, which is the whole
    // point of a distribution. The header says it is log so the reader is not
    // invited to compare bar heights as if they were linear.
    const logMax = Math.log(max);
    const logMin = Math.log(minNonZero);
    const span = logMax - logMin || 1;

    const W = 600;
    const H = 330;
    const floor = 288;
    const top = 26;
    const plot = floor - top;
    const bw = W / bars.length;
    return {
      W,
      H,
      floor,
      top,
      logScale: max / minNonZero > 20,
      mid: (bars.filter((b) => b.side === "bid").length / bars.length) * W,
      bars: bars.map((b, i) => {
        const v = Number(BigInt(b.liquidity));
        let frac = 0;
        if (v > 0) {
          const t = (Math.log(v) - logMin) / span;
          // a visible floor, so the tail reads as low depth and not as absence
          frac = max / minNonZero > 20 ? 0.1 + 0.9 * t : v / max;
        }
        const h = frac * plot;
        // separate mini bars: one per tick, so the reader can see the pool is
        // a series of discrete ranges rather than one poured shape
        const gap = Math.min(2.5, bw * 0.28);
        return { ...b, x: i * bw + gap / 2, w: Math.max(1.2, bw - gap), y: floor - h, h };
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
    const pLow = priceAt(sqrtAtTick(tickLower), p.decimals0, p.decimals1);
    const pHigh = priceAt(sqrtAtTick(tickUpper), p.decimals0, p.decimals1);
    const pNow = priceAt(sqrtP, p.decimals0, p.decimals1);
    const pctLow = pNow > 0 ? ((pNow - pLow) / pNow) * 100 : 0;
    const pctHigh = pNow > 0 ? ((pHigh - pNow) / pNow) * 100 : 0;
    if (!(amt > 0) || !(per > 0)) {
      return { side, tickLower, tickUpper, need0: 0, need1: 0, liquidity: 0, oneSided: per <= 0, pctLow, pctHigh };
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
      pctLow,
      pctHigh,
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
  ];
  // Addresses get their own rows: full, wrapping, never shortened. A truncated
  // identifier cannot be checked against anything or pasted anywhere, which is
  // the only reason to put one on a page.
  const addrRows: Array<[string, string]> = [
    ["Pool id", p.poolId],
    [`${p.symbol0} address`, p.key.currency0],
    [`${p.symbol1} address`, p.key.currency1],
    ["Hook", p.key.hooks === "0x0000000000000000000000000000000000000000" ? "none" : p.key.hooks],
    [`Launcher${p.launch.retired ? " (superseded)" : ""}`, p.launch.launcher],
    [`${p.launch.symbol} token`, p.launch.token],
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
          Provide across a price range and earn {p.lpFeeBps / 100}% of everything that trades
          through it. Withdraw whenever: no lockup, no epoch, and no share in anybody else&apos;s
          book.
        </p>

        {chart ? (
          <div className={styles.chartCard}>
            <div className={styles.chartHeader}>
              <span>Liquidity by price</span>
              <span className={own.sub}>
                {chart.bars.length} ticks either side of the price
                {chart.logScale ? " · log scale" : ""}
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
              <line className={styles.chartGridLine} x1="0" y1={chart.floor} x2={chart.W} y2={chart.floor} />
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

        <div className={own.form}>
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

          <div className={own.rangeRow}>
            {[1, 3, 10].map((w) => (
              <button
                key={w}
                type="button"
                className={`${own.rangePick} ${widthSteps === w ? own.rangePickOn : ""}`}
                onClick={() => setWidthSteps(w)}
              >
                {w === 1 ? "Tight" : w === 3 ? "Medium" : "Wide"}
              </button>
            ))}
          </div>
          <div className={own.rangeFacts}>
            <div className={own.rangeFact}>
              <span className={own.rangeFactLabel}>Earns between</span>
              <strong>
                {fmt(priceAt(sqrtAtTick(quote.tickLower), p.decimals0, p.decimals1))} and{" "}
                {fmt(priceAt(sqrtAtTick(quote.tickUpper), p.decimals0, p.decimals1))} {p.symbol1} per{" "}
                {p.symbol0}
              </strong>
            </div>
            <div className={own.rangeFact}>
              <span className={own.rangeFactLabel}>Around the price</span>
              <strong>
                {quote.pctLow.toFixed(2)}% below to {quote.pctHigh.toFixed(2)}% above
              </strong>
            </div>
            <div className={own.rangeFact}>
              <span className={own.rangeFactLabel}>Outside that range</span>
              <strong>earns nothing until the price comes back</strong>
            </div>
          </div>

          {quote.liquidity > 0 ? (
            <div className={own.pairNeed}>
              <span>
                paired with <strong>{fmt(quote.side === 0 ? quote.need1 : quote.need0)}</strong>{" "}
                {quote.side === 0 ? p.symbol1 : p.symbol0}
              </span>
              <span>
                <strong>{fmt(quote.side === 0 ? quote.need0 : quote.need1)}</strong>{" "}
                {quote.side === 0 ? p.symbol0 : p.symbol1} in
              </span>
            </div>
          ) : null}

          <button type="button" className={`${styles.primaryButton} ${own.cta}`} disabled>
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
          {addrRows.map(([label, value]) => (
            <div className={styles.metricRow} key={label}>
              <span className={styles.metricLabel}>{label}</span>
              <span className={own.addr}>{value}</span>
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
