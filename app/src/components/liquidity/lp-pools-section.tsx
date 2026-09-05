"use client";

/**
 * The LP venues: the v4 pools a graduated launch leaves behind.
 *
 * These are the pools you can actually add to and remove from. They are
 * ordinary public Uniswap v4 pools with no hook, two per launch along the
 * price chain MEME -> fSHARE -> USDG, and the fee on every fill accrues to
 * whoever holds the position. That is a different thing from the Desk vault
 * above, which is one shared balance sheet with pro-rata shares and a one day
 * exit, and different again from the funding queue, which is a countdown.
 *
 * Every figure is a chain read. There is no TVL column and no volume column,
 * because neither is readable: `liquidity` is the ACTIVE liquidity at the
 * current tick, and turning that into a dollar value needs every position's
 * range, which a pool id does not expose. Nothing indexes swaps on these pools
 * yet either. The rule in this repo is that a column traces to a chain call or
 * says plainly that it does not exist, so those columns are absent rather than
 * estimated.
 */

import { ArrowRight } from "@phosphor-icons/react";
import { useMemo } from "react";
import styles from "./lp-pools.module.css";
import { TokenPair } from "./token-pair";

export interface LpPoolRow {
  poolId: string;
  kind: "meme" | "quote";
  launch: { token: string; symbol: string; launcher: string; retired: boolean };
  key: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  /**
   * What the active liquidity IS, in tokens, computed server side. L lives in
   * sqrt-price space and is not an amount of anything, so it is not shown.
   */
  inRange?: { amount0: number; amount1: number; usdg: number | null; bandPct: number };
  lpFeeBps: number;
  /** Which currency is USDG, or null if the pool holds none. Never infer from the index. */
  usdgSide: 0 | 1 | null;
}

interface Props {
  pools: LpPoolRow[];
  unreadable?: Array<{ poolId: string; reason: string }>;
  onAdd?: (pool: LpPoolRow) => void;
  onRemove?: (pool: LpPoolRow) => void;
}

/**
 * The one line the UI owes anybody who finds Add missing on a meme hop.
 *
 * Exported because the board and the pool page both have to say it, and two
 * copies of a sentence drift. It names the pool a deposit should go to instead,
 * which is the fSHARE side of this pair: whichever currency is not the launch
 * token. That comes off the pool key rather than an index, because v4 sorts
 * currencies by address and the meme is not reliably currency0.
 */
export function quoteHopOnlyReason(
  p: Pick<LpPoolRow, "key" | "launch" | "symbol0" | "symbol1">,
): string {
  const stock =
    p.key.currency0.toLowerCase() === p.launch.token.toLowerCase() ? p.symbol1 : p.symbol0;
  // The symbol reads "?" when the token would not answer symbol(). Do not print
  // that as if it were a ticker; fall back to the generic noun.
  return stock && stock !== "?"
    ? `No deposits on this hop: they go into the ${stock} / USDG pool, which carries every launch priced in ${stock}.`
    : "No deposits on this hop: they go into the stock's USDG pool, which carries every launch priced in that stock.";
}

/** token1 per token0, from sqrtPriceX96, corrected for decimals. */
function priceOf(p: LpPoolRow): number {
  const sqrt = Number(BigInt(p.sqrtPriceX96)) / 2 ** 96;
  if (!Number.isFinite(sqrt) || sqrt === 0) return 0;
  return sqrt * sqrt * 10 ** (p.decimals0 - p.decimals1);
}

function num(n: number, max = 6) {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n < 0.000001) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

/**
 * A dollar figure for the USDG side, and a token figure for the other.
 *
 * Deliberately not abbreviated with K/M/B suffixes. The number this replaced
 * was abbreviated, and "56,886,259.95Q" is exactly how a quantity that is not
 * a quantity passes for a large amount of money. At the sizes these pools
 * actually hold, the full figure is short anyway.
 */
function money(n: number) {
  if (!Number.isFinite(n)) return "unmeasured";
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function tok(n: number) {
  if (!Number.isFinite(n)) return "unmeasured";
  if (n === 0) return "0";
  if (n < 0.0001) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function LpPoolsSection({ pools, unreadable = [], onAdd, onRemove }: Props) {
  // group each launch's two hops together, meme first, so the price chain reads
  // top to bottom instead of the pools arriving in whatever order the chain
  // enumerated them
  const ordered = useMemo(() => {
    const byLaunch = new Map<string, LpPoolRow[]>();
    for (const p of pools) {
      const k = p.launch.token.toLowerCase();
      byLaunch.set(k, [...(byLaunch.get(k) ?? []), p]);
    }
    return [...byLaunch.values()].flatMap((rows) =>
      [...rows].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "meme" ? -1 : 1)),
    );
  }, [pools]);

  if (pools.length === 0 && unreadable.length === 0) return null;

  const launches = new Set(pools.map((p) => p.launch.token.toLowerCase())).size;
  const fees = [...new Set(pools.map((p) => p.lpFeeBps))];

  return (
    <section className={styles.section} aria-label="Liquidity pools">
      <div className={styles.head}>
        <div>
          <span className={styles.eyebrow}>Liquidity pools</span>
          <h2 className={styles.title}>Deposit on the USDG hop, exit from either</h2>
          <p className={styles.blurb}>
            Every graduated launch leaves two public Uniswap v4 pools behind, one hop each along
            the route from the meme to its stock to USDG. Deposits go in on the USDG hop and earn
            the fee on everything that trades through it. Withdraw whenever, from either hop. No
            lockup and no epoch.
          </p>
        </div>
        <div className={styles.headStats}>
          <div className={styles.headStat}>
            <span className={styles.eyebrow}>Pools</span>
            <strong className={styles.headStatValue}>{pools.length}</strong>
          </div>
          <div className={styles.headStat}>
            <span className={styles.eyebrow}>Launches</span>
            <strong className={styles.headStatValue}>{launches}</strong>
          </div>
          <div className={styles.headStat}>
            <span className={styles.eyebrow}>Fee</span>
            <strong className={styles.headStatValue}>
              {fees.length === 1 ? `${fees[0] / 100}%` : "mixed"}
            </strong>
          </div>
        </div>
      </div>

      <div className={styles.shell}>
        <div className={styles.header} aria-hidden="true">
          <span className={styles.columnLabel}>Pool</span>
          <span className={styles.columnLabel}>Route</span>
          <span className={styles.columnLabel}>Fee</span>
          <span className={styles.columnLabel}>Price</span>
          <span className={styles.columnLabel}>Quoting now</span>
          <span />
        </div>

        {ordered.map((p) => (
          <article
            className={`${styles.row} ${p.kind === "quote" ? styles.rowQuote : ""}`}
            key={p.poolId}
          >
            <div className={styles.identity}>
              <TokenPair tokenA={p.symbol0} tokenB={p.symbol1} />
              <div>
                <span className={styles.pair}>
                  {p.symbol0}
                  <span className={styles.pairMuted}> / </span>
                  {p.symbol1}
                </span>
                <div className={styles.badges}>
                  <span className={styles.badge}>{p.launch.symbol}</span>
                  {p.launch.retired ? (
                    <span className={`${styles.badge} ${styles.badgeRetired}`}>earlier launcher</span>
                  ) : null}
                </div>
              </div>
            </div>

            <div>
              <span className={styles.value}>{p.kind === "meme" ? "meme hop" : "quote hop"}</span>
              <span className={styles.sub}>
                {p.kind === "meme" ? "meme priced in its stock" : "stock priced in USDG"}
              </span>
            </div>

            <div>
              <span className={styles.value}>{p.lpFeeBps / 100}%</span>
            </div>

            <div>
              <span className={styles.value}>{num(priceOf(p))}</span>
              <span className={styles.sub}>
                {p.symbol1} per {p.symbol0}
              </span>
            </div>

            <div>
              {p.inRange ? (
                <>
                  <span className={styles.value}>
                    {p.inRange.usdg === null ? tok(p.inRange.amount0) : money(p.inRange.usdg)}
                  </span>
                  <span className={styles.sub}>
                    {p.inRange.usdg === null
                      ? `${p.symbol0} + ${tok(p.inRange.amount1)} ${p.symbol1}`
                      : `+ ${tok(p.usdgSide === 0 ? p.inRange.amount1 : p.inRange.amount0)} ${
                          p.usdgSide === 0 ? p.symbol1 : p.symbol0
                        }`}
                  </span>
                </>
              ) : (
                <>
                  <span className={styles.value}>unmeasured</span>
                  <span className={styles.sub}>the amounts did not come back</span>
                </>
              )}
            </div>

            <div className={styles.actions}>
              {/* Add is offered on the quote hop only. Remove stays on both:
                  somebody already in a meme pool has to be able to leave, and a
                  withheld exit is a trapped position, not a policy. */}
              {p.kind === "quote" ? (
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => onAdd?.(p)}
                  disabled={!onAdd}
                  title={onAdd ? undefined : "Connect a wallet to provide liquidity"}
                >
                  Add <ArrowRight size={12} weight="bold" />
                </button>
              ) : null}
              <button
                type="button"
                className={styles.action}
                onClick={() => onRemove?.(p)}
                disabled={!onRemove}
                title={onRemove ? undefined : "Connect a wallet to withdraw a position"}
              >
                Remove
              </button>
            </div>

            {/* Standing text on the row, not a tooltip on a greyed button: a
                title attribute is reachable by neither the keyboard nor a
                screen reader, and the absence of a control explains nothing on
                its own. */}
            {p.kind === "meme" ? (
              <p className={styles.rowNote}>{quoteHopOnlyReason(p)}</p>
            ) : null}
          </article>
        ))}

        <p className={styles.note}>
          Quoting now is the liquidity sitting in the price range that currently contains spot,
          converted to tokens. It is what a trade would meet before the price leaves that range,
          roughly {ordered[0]?.inRange ? `${ordered[0].inRange.bandPct.toFixed(1)}%` : "one tick step"}{" "}
          wide here. It is NOT the pool&apos;s total value: positions outside the live range are
          real and are not counted, and a pool id does not expose them. This column used to print
          the raw liquidity number, which is not an amount of anything and read as a fortune where
          the honest figure is a few dollars. Nothing indexes swaps on these pools yet, so there is
          no volume figure to show.
        </p>

        {unreadable.length > 0 ? (
          <p className={styles.warn}>
            {unreadable.length} pool{unreadable.length === 1 ? "" : "s"} the chain named could not be
            described and {unreadable.length === 1 ? "is" : "are"} not shown:{" "}
            {unreadable.map((u) => `${u.poolId.slice(0, 10)} (${u.reason})`).join("; ")}.
          </p>
        ) : null}
      </div>
    </section>
  );
}
