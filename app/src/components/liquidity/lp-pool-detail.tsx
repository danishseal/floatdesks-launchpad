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

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import styles from "./liquidity.module.css";
import own from "./lp-pools.module.css";
import type { LpPoolRow } from "./lp-pools-section";
import { useFloatWallet } from "@/components/wallet/float-wallet-provider";
import { waitFor } from "@/lib/float/chain";
import { addLiquidity, removeLiquidity, positionsIn, type OwnedPosition } from "@/lib/float/lp";
import type { LpPool } from "@/lib/float/pools";

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

/** The useful part of a wallet or revert error is rarely the first line. */
function readable(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; message?: string };
  return (err?.shortMessage ?? err?.details ?? err?.message ?? String(e)).split("\n")[0].slice(0, 200);
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
  const wallet = useFloatWallet();
  const [busy, setBusy] = useState(false);
  const [positions, setPositions] = useState<OwnedPosition[] | null>(null);
  const [posErr, setPosErr] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  /** Set by clicking the chart; overrides the width presets until cleared. */
  const [custom, setCustom] = useState<{ lo: number; hi: number } | null>(null);

  const loadPositions = useCallback(async () => {
    if (!data || !wallet.address) {
      setPositions(null);
      return;
    }
    try {
      setPosErr(null);
      setPositions(await positionsIn(data.pool as unknown as LpPool, wallet.address));
    } catch (e) {
      // Finding positions needs a full Transfer log scan and plenty of RPCs
      // refuse one. That failure must NOT render as "you have none": those are
      // different facts and only one of them means there is nothing to
      // withdraw.
      setPositions(null);
      setPosErr(readable(e));
    }
  }, [data, wallet.address]);

  useEffect(() => {
    void loadPositions();
  }, [loadPositions]);

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

    // Inset the plot. Drawing from 0 to W puts grid lines and the outermost
    // bars flush against the card border, which reads as an overflow rather
    // than a chart. The floor sits near the bottom for the same reason: a band
    // of empty space under the bars detaches them from the frame.
    const W = 600;
    const H = 300;
    const PAD = 14;
    const floor = 282;
    const top = 24;
    const plot = floor - top;
    const inner = W - PAD * 2;
    const bw = inner / bars.length;
    return {
      W,
      H,
      floor,
      top,
      PAD,
      inner,
      logScale: max / minNonZero > 20,
      mid: PAD + (bars.filter((b) => b.side === "bid").length / bars.length) * inner,
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
        return { ...b, i, x: PAD + i * bw + gap / 2, w: Math.max(1.2, bw - gap), y: floor - h, h, value: v };
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
    const tickLower = custom ? custom.lo : base - widthSteps * spacing;
    const tickUpper = custom ? custom.hi : base + (widthSteps + 1) * spacing;
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
  }, [data, amount, widthSteps, custom]);

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

  async function add() {
    if (!data || !quote) return;
    setBusy(true);
    try {
      const account = wallet.getAccount();
      if (wallet.wrongChain) await wallet.switchChain();
      const p0 = data.pool;
      // A 1% headroom on the caps: the exact split moves with the price between
      // signing and mining, and the pool computes the real amounts from the
      // liquidity anyway. The caps exist so a move cannot take more than this.
      const cap = (v: number, dec: number) => BigInt(Math.ceil(v * 1.01 * 10 ** dec));
      toast.info("Approving and adding liquidity…");
      const hash = await addLiquidity({
        account,
        pool: p0 as unknown as LpPool,
        tickLower: quote.tickLower,
        tickUpper: quote.tickUpper,
        liquidity: BigInt(Math.floor(quote.liquidity)),
        amount0Max: cap(quote.need0, p0.decimals0),
        amount1Max: cap(quote.need1, p0.decimals1),
      });
      await waitFor(hash);
      toast.success("Liquidity added.");
      setAmount("");
      await wallet.refreshBalance();
      await loadPositions();
    } catch (e) {
      toast.error(readable(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(pos: OwnedPosition) {
    if (!data) return;
    setBusy(true);
    try {
      const account = wallet.getAccount();
      if (wallet.wrongChain) await wallet.switchChain();
      toast.info("Withdrawing…");
      // amountMin 0: this takes whatever the position is worth at the price it
      // lands at. A minimum here would just make an exit fail on a move, and
      // the point of the position is that you can always leave.
      const hash = await removeLiquidity({
        account,
        pool: data.pool as unknown as LpPool,
        tokenId: BigInt(pos.tokenId),
        liquidity: BigInt(pos.liquidity),
        amount0Min: 0n,
        amount1Min: 0n,
      });
      await waitFor(hash);
      toast.success("Withdrawn.");
      await wallet.refreshBalance();
      await loadPositions();
    } catch (e) {
      toast.error(readable(e));
    } finally {
      setBusy(false);
    }
  }

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
                {hover !== null && chart.bars[hover]
                  ? `ticks ${chart.bars[hover].tick.toLocaleString("en-US")} to ${(
                      chart.bars[hover].tick + p.key.tickSpacing
                    ).toLocaleString("en-US")} · ${fmt(
                      priceAt(sqrtAtTick(chart.bars[hover].tick), p.decimals0, p.decimals1),
                    )} ${p.symbol1} · L ${BigInt(chart.bars[hover].liquidity).toLocaleString("en-US")}`
                  : `${chart.bars.length} ticks either side of the price${chart.logScale ? " · log scale" : ""} · click a bar to place your range`}
              </span>
            </div>
            <svg
              className={styles.depthChart}
              viewBox={`0 0 ${chart.W} ${chart.H}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`Liquidity distribution for the ${p.symbol0} ${p.symbol1} pool, read from the pool's own ticks`}
            >
              {[0.25, 0.5, 0.75].map((f) => {
                const y = chart.top + (chart.floor - chart.top) * f;
                return (
                  <line
                    key={f}
                    className={styles.chartGridLine}
                    x1={chart.PAD}
                    y1={y}
                    x2={chart.W - chart.PAD}
                    y2={y}
                  />
                );
              })}
              <line
                className={styles.chartGridLine}
                x1={chart.PAD}
                y1={chart.floor}
                x2={chart.W - chart.PAD}
                y2={chart.floor}
              />
              {chart.bars.map((b) => (
                <g key={b.tick}>
                  {/* full-height hit area, so a 2px tail bar is still clickable */}
                  <rect
                    x={(b.x - 0.6).toFixed(2)}
                    y={chart.top}
                    width={(b.w + 1.2).toFixed(2)}
                    height={(chart.floor - chart.top).toFixed(2)}
                    fill="transparent"
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() => setHover(b.i)}
                    onMouseLeave={() => setHover((h) => (h === b.i ? null : h))}
                    onClick={() => setCustom({ lo: b.tick, hi: b.tick + p.key.tickSpacing })}
                  >
                    <title>
                      {`ticks ${b.tick} to ${b.tick + p.key.tickSpacing} · liquidity ${b.liquidity}`}
                    </title>
                  </rect>
                  <rect
                    className={b.side === "bid" ? styles.chartBid : styles.chartAsk}
                    x={b.x.toFixed(2)}
                    y={b.y.toFixed(2)}
                    width={b.w.toFixed(2)}
                    height={Math.max(0, b.h).toFixed(2)}
                    opacity={hover === null || hover === b.i ? 1 : 0.45}
                    pointerEvents="none"
                  />
                </g>
              ))}
              {custom
                ? (() => {
                    const sel = chart.bars.find((b) => b.tick === custom.lo);
                    return sel ? (
                      <rect
                        x={(sel.x - 0.6).toFixed(2)}
                        y={chart.top}
                        width={(sel.w + 1.2).toFixed(2)}
                        height={(chart.floor - chart.top).toFixed(2)}
                        fill="none"
                        stroke="var(--color-accent-solid)"
                        strokeWidth="1.5"
                        pointerEvents="none"
                      />
                    ) : null;
                  })()
                : null}
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
                className={`${own.rangePick} ${!custom && widthSteps === w ? own.rangePickOn : ""}`}
                onClick={() => {
                  setCustom(null);
                  setWidthSteps(w);
                }}
              >
                {w === 1 ? "Tight" : w === 3 ? "Medium" : "Wide"}
              </button>
            ))}
            {custom ? (
              <button type="button" className={`${own.rangePick} ${own.rangePickOn}`} onClick={() => setCustom(null)}>
                From chart ✕
              </button>
            ) : null}
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

          <button
            type="button"
            className={`${styles.primaryButton} ${own.cta}`}
            disabled={busy || (wallet.connected && !(quote.liquidity > 0))}
            onClick={() => (wallet.connected ? void add() : void wallet.connect())}
          >
            {!wallet.connected
              ? "Connect a wallet"
              : busy
                ? "Confirm in your wallet…"
                : quote.liquidity > 0
                  ? `Add ${fmt(quote.side === 0 ? quote.need0 : quote.need1)} ${quote.side === 0 ? p.symbol0 : p.symbol1}`
                  : "Enter an amount"}
          </button>
          {wallet.connected ? (
            <div className={own.positions}>
              <span className={own.rangeFactLabel}>Your positions</span>
              {posErr ? (
                <p className={own.posEmpty}>
                  Could not read your positions ({posErr}). That is not the same as having none, so
                  nothing is listed rather than shown as empty.
                </p>
              ) : positions === null ? (
                <p className={own.posEmpty}>Looking for your positions…</p>
              ) : positions.length === 0 ? (
                <p className={own.posEmpty}>None in this pool yet.</p>
              ) : (
                positions.map((pos) => (
                  <div className={own.posRow} key={pos.tokenId}>
                    <span>
                      #{pos.tokenId} · ticks {pos.tickLower.toLocaleString("en-US")} to{" "}
                      {pos.tickUpper.toLocaleString("en-US")}
                    </span>
                    <button
                      type="button"
                      className={own.action}
                      disabled={busy}
                      onClick={() => void remove(pos)}
                    >
                      Withdraw
                    </button>
                  </div>
                ))
              )}
            </div>
          ) : null}

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
