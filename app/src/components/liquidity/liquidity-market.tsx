"use client";

import { ArrowRight, CaretLeft, CaretRight, FunnelSimple, MagnifyingGlass, Plus } from "@phosphor-icons/react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { FEATURED_POOL_ID, LIQUIDITY_POOLS } from "./data";
import styles from "./liquidity.module.css";
import { TokenPair } from "./token-pair";

const SUMMARY = [
  ["Total value locked", "$18,854,306"],
  ["7D volume", "$792,354,837"],
  ["7D fees", "$1,866,933.14"],
  ["Rewards this epoch", "$246,182"],
] as const;

export function LiquidityMarket() {
  const [query, setQuery] = useState("");
  const filteredPools = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return LIQUIDITY_POOLS;
    return LIQUIDITY_POOLS.filter((pool) => `${pool.tokenA}/${pool.tokenB} ${pool.id}`.toLowerCase().includes(normalized));
  }, [query]);

  return (
    <div className={styles.page}>
      <section className={styles.summary} aria-label="Liquidity market summary">
        {SUMMARY.map(([label, value]) => (
          <div className={styles.stat} key={label}>
            <span className={styles.statLabel}>{label}</span>
            <strong className={styles.statValue}>{value}</strong>
          </div>
        ))}
        <div className={styles.summarySignal}>
          <span className={styles.signalCopy}>LIQUIDITY · EPOCH 42 · 05:06:03:44</span>
        </div>
      </section>

      <div className={styles.toolbar}>
        <label className={styles.searchWrap}>
          <MagnifyingGlass className={styles.searchIcon} weight="bold" />
          <span className="sr-only">Search pools</span>
          <input className={styles.search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by token name or contract" />
        </label>
        <button type="button" className={styles.filterButton}><FunnelSimple size={15} weight="bold" /> Filter</button>
        <Link className={styles.primaryButton} href={`/liquidity/${FEATURED_POOL_ID}?chainId=999`}><Plus size={15} weight="bold" /> Add liquidity</Link>
      </div>

      <section className={styles.tableShell} aria-label="Liquidity pools">
        <div className={styles.tableHeader} aria-hidden="true">
          <span className={styles.columnLabel}>Pool</span>
          <span className={styles.columnLabel}>TVL ↓</span>
          <span className={styles.columnLabel}>Max APR</span>
          <span className={styles.columnLabel}>Epoch rewards</span>
          <span className={styles.columnLabel}>24h volume</span>
          <span />
        </div>

        <div>
          {filteredPools.map((pool) => {
            const href = `/liquidity/${pool.id}?chainId=999`;
            return (
              <article className={styles.poolRow} key={pool.id}>
                <div className={styles.poolIdentity}>
                  <TokenPair tokenA={pool.tokenA} tokenB={pool.tokenB} />
                  <div>
                    <Link className={styles.poolName} href={href}>{pool.tokenA}<span className={styles.tokenMeta}> / </span>{pool.tokenB}</Link>
                    <div className={styles.poolBadges}><span className={styles.poolBadge}>{pool.fee}</span><span className={styles.poolBadge}>{pool.type}</span></div>
                  </div>
                </div>
                <div><span className={styles.mobileLabel}>TVL</span><span className={styles.cellValue}>{pool.tvl}</span></div>
                <div><span className={styles.mobileLabel}>Max APR</span><span className={`${styles.cellValue} ${styles.accentValue}`}>{pool.apr}</span>{pool.averageApr ? <span className={styles.cellSubtle}>Avg: {pool.averageApr}</span> : null}</div>
                <div><span className={styles.mobileLabel}>Rewards</span><span className={styles.cellValue}>{pool.rewards}</span></div>
                <div><span className={styles.mobileLabel}>24h volume</span><span className={styles.cellValue}>{pool.volume}</span></div>
                <div><Link className={styles.depositLink} href={href}>Deposit <ArrowRight size={13} weight="bold" /></Link></div>
              </article>
            );
          })}
          {filteredPools.length === 0 ? <div className="px-5 py-14 text-center font-mono text-sm text-[var(--color-text-muted)]">No pools match “{query}”.</div> : null}
        </div>

        <footer className={styles.pagination}>
          <div className={styles.pagerGroup}><button className={styles.pagerButton} type="button" aria-label="Previous page"><CaretLeft size={14} /></button><span>1 of 68</span><button className={styles.pagerButton} type="button" aria-label="Next page"><CaretRight size={14} /></button></div>
          <span>Cards per page · 12</span>
        </footer>
      </section>
    </div>
  );
}
