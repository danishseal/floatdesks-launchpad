"use client";

/**
 * The Desk pools section of the liquidity board.
 *
 * These are NOT AMM pools and are deliberately not rendered in the same table.
 * The hook is the only liquidity provider: it quotes an ask ladder of stock
 * above the oracle and a bid ladder of USDG below it, so there is no outside
 * LP position, no epoch reward and no APR to show. What a reader actually
 * needs is what the desk is quoting, how much stock is left behind that quote,
 * and how hard it is currently working to stay balanced.
 *
 * Every number here is a chain read from /api/float/hook-pools. Where a field
 * does not exist for these pools it is absent, not filled with a placeholder.
 */

import { ArrowRight } from "@phosphor-icons/react";
import Link from "next/link";
import styles from "./desk-hook.module.css";
import { TokenPair } from "./token-pair";

export interface HookPoolRow {
  poolId: string;
  ticker: string;
  displayName: string;
  tvlQuote: string;
  inventoryAsset: string;
  inventoryQuote: string;
  volumeQuoteLifetime: string;
  feeQuoteLifetime: string;
  askSpreadBps: number;
  bidSpreadBps: number;
  scarcityAskTicks: number;
  scarcityBidTicks: number;
  replacementTicks: number;
  assetShort: boolean;
  shortfallBps: number;
  gapQuote: string;
  acquireArmed: boolean;
  acquireNeeded: boolean;
  night: boolean;
  built: boolean;
  paused: boolean;
  rungs: number;
}

export interface HookUnreadable {
  poolId: string;
  assetId?: string;
  reason: string;
}

interface Props {
  pools: HookPoolRow[];
  quoteSymbol: string;
  quoteDecimals: number;
  /** Pools the hook holds but we could not read, with why. Normally empty. */
  unreadable?: HookUnreadable[];
}

function usd(raw: string, decimals: number, digits = 2) {
  const n = Number(BigInt(raw || "0")) / 10 ** decimals;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits });
}

function shares(raw: string) {
  return (Number(BigInt(raw || "0")) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function bps(n: number) {
  return `${(n / 100).toFixed(2)}%`;
}

export function DeskHookSection({ pools, quoteSymbol, quoteDecimals, unreadable = [] }: Props) {
  // A hook whose pools all failed to read must NOT disappear: vanishing is how
  // "there are no pools" and "there are pools I could not read" become the same
  // statement. Absent only when there is genuinely nothing to say.
  if (pools.length === 0 && unreadable.length === 0) return null;

  const book = pools.reduce((a, p) => a + Number(BigInt(p.tvlQuote)), 0) / 10 ** quoteDecimals;
  const working = pools.filter((p) => p.scarcityAskTicks > 0 || p.scarcityBidTicks > 0).length;

  return (
    <section className={styles.section} aria-label="Desk pools">
      <div className={styles.head}>
        <div>
          <span className={styles.eyebrow}>Desk pools</span>
          <h2 className={styles.title}>Quoted by the desk, not by depositors</h2>
          <p className={styles.blurb}>
            One pool per listing, with the desk as the only liquidity provider. It offers stock above
            the oracle and bids for it below, and widens the side it is running out of until flow
            brings the inventory back.
          </p>
        </div>
        <div className={styles.headStats}>
          <div className={styles.headStat}>
            <span className={styles.eyebrow}>Desk book</span>
            <strong className={styles.headStatValue}>
              {book.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}
            </strong>
          </div>
          <div className={styles.headStat}>
            <span className={styles.eyebrow}>Pools</span>
            <strong className={styles.headStatValue}>{pools.length}</strong>
          </div>
          <div className={styles.headStat}>
            <span className={styles.eyebrow}>Quoting wide</span>
            <strong className={styles.headStatValue}>
              {working} of {pools.length}
            </strong>
          </div>
        </div>
      </div>

      <div className={styles.shell}>
        <div className={styles.header} aria-hidden="true">
          <span className={styles.columnLabel}>Pool</span>
          <span className={styles.columnLabel}>Desk book</span>
          <span className={styles.columnLabel}>Quote vs oracle</span>
          <span className={styles.columnLabel}>Inventory</span>
          <span className={styles.columnLabel}>Volume</span>
          <span />
        </div>

        {pools.map((p) => {
          const assetQuote = Number(BigInt(p.tvlQuote)) - Number(BigInt(p.inventoryQuote));
          const total = Number(BigInt(p.tvlQuote)) || 1;
          const assetPct = Math.max(0, Math.min(100, (assetQuote / total) * 100));
          const href = `/liquidity/${p.poolId}`;
          const premium = p.assetShort ? p.scarcityAskTicks : p.scarcityBidTicks;

          return (
            <article className={styles.row} key={p.poolId}>
              <div className={styles.identity}>
                <TokenPair tokenA={p.ticker} tokenB={quoteSymbol} />
                <div>
                  <Link className={styles.pair} href={href}>
                    {p.ticker}
                    <span className={styles.pairMuted}> / {quoteSymbol}</span>
                  </Link>
                  <div className={styles.badges}>
                    <span className={styles.badge}>Desk</span>
                    <span className={`${styles.badge} ${p.night ? styles.badgeNight : ""}`}>
                      {p.night ? "Closed" : "Open"}
                    </span>
                    <span className={styles.badge}>{p.rungs} rungs</span>
                  </div>
                </div>
              </div>

              <div>
                <span className={styles.value}>{usd(p.tvlQuote, quoteDecimals, 0)}</span>
                <span className={styles.sub}>at the oracle</span>
              </div>

              <div>
                <div className={styles.quote}>
                  <span className={styles.ask}>+{bps(p.askSpreadBps)}</span>
                  <span className={styles.slash}>/</span>
                  <span className={styles.bid}>-{bps(p.bidSpreadBps)}</span>
                </div>
                <span className={`${styles.sub} ${premium > 0 ? styles.accent : ""}`}>
                  {premium > 0
                    ? `+${premium} ticks scarcity, replacing costs ${p.replacementTicks}`
                    : "flat band, fully stocked"}
                </span>
              </div>

              <div>
                <div className={styles.bar}>
                  <div className={styles.barAsset} style={{ width: `${assetPct}%` }} />
                  <div className={styles.barCash} style={{ width: `${100 - assetPct}%` }} />
                  <div className={styles.barTarget} style={{ left: "50%" }} />
                </div>
                <div className={styles.barLegend}>
                  <span>
                    {shares(p.inventoryAsset)} {p.ticker} · {usd(p.inventoryQuote, quoteDecimals, 0)} cash
                  </span>
                  <span>
                    {p.shortfallBps > 0
                      ? `${p.assetShort ? "short stock" : "short cash"} ${bps(p.shortfallBps)}`
                      : "at target"}
                  </span>
                </div>
              </div>

              <div>
                <span className={styles.value}>{usd(p.volumeQuoteLifetime, quoteDecimals, 0)}</span>
                <span className={styles.sub}>lifetime, {usd(p.feeQuoteLifetime, quoteDecimals)} fees</span>
              </div>

              <div>
                <Link className={styles.link} href={href}>
                  Trade <ArrowRight size={13} weight="bold" />
                </Link>
              </div>
            </article>
          );
        })}

        <p className={styles.note}>
          The desk supplies all of the liquidity in these pools, so there is nothing to deposit into
          and no reward epoch. Volume and fees are lifetime totals read from the pool itself.
        </p>
      </div>
      {unreadable.length > 0 ? (
        <div className={styles.note}>
          {unreadable.length} pool{unreadable.length === 1 ? "" : "s"} on this hook
          could not be read and {unreadable.length === 1 ? "is" : "are"} not shown:{" "}
          {unreadable.map((u) => `${u.poolId.slice(0, 10)}… (${u.reason})`).join("; ")}
        </div>
      ) : null}
    </section>
  );
}
