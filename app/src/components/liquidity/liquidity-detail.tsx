"use client";

import Link from "next/link";
import { useState } from "react";
import styles from "./liquidity.module.css";
import { TokenPair } from "./token-pair";

const RANGES = [
  { name: "Deep ±50%", apr: "APR: 15%" },
  { name: "Passive ±25%", apr: "APR: 30%" },
  { name: "Wide ±10%", apr: "APR: 74%" },
  { name: "Narrow ±2.5%", apr: "APR: 295%" },
  { name: "Degen · 1 tick", apr: "APR: 29,450%" },
] as const;

export function LiquidityDetail() {
  const [range, setRange] = useState("Narrow ±2.5%");

  return (
    <div className={styles.detailPage}>
      <nav className={styles.breadcrumbs} aria-label="Breadcrumb"><Link href="/">Home</Link><span>›</span><Link href="/liquidity">Liquidity</Link><span>›</span><span>HYPE/USDC</span></nav>
      <div className={styles.detailGrid}>
        <section className={styles.builder} aria-labelledby="pool-title">
          <header className={styles.poolHeading}>
            <TokenPair tokenA="HYPE" tokenB="USDC" />
            <div><h1 id="pool-title">HYPE/USDC</h1><div className={styles.poolBadges}><span className={styles.poolBadge}>0.12%</span><span className={styles.poolBadge}>CL5</span></div></div>
          </header>

          <div className={styles.priceRange}>
            <RangeField label="Min USDC per HYPE" value="82.9" delta="−2.48%" />
            <RangeField label="Max USDC per HYPE" value="87.15" delta="+2.53%" />
          </div>

          <section className={styles.formSection}>
            <div className={styles.sectionTitleRow}><h2 className={styles.sectionTitle}>Range type</h2><span className={styles.fieldLabel}>Projected position</span></div>
            <div className={styles.rangeOptions}>
              {RANGES.map((option) => (
                <button key={option.name} type="button" className={`${styles.rangeButton} ${range === option.name ? styles.rangeButtonActive : ""}`} onClick={() => setRange(option.name)} aria-pressed={range === option.name}>
                  <span className={styles.rangeName}>{option.name}</span><span className={styles.rangeApr}>{option.apr}</span>
                </button>
              ))}
            </div>
          </section>

          <section className={styles.formSection}>
            <div className={styles.sectionTitleRow}><h2 className={styles.sectionTitle}>Input amounts</h2><button type="button" className={styles.slippageButton}>Slippage&nbsp; 0.5%</button></div>
            <AmountCard token="HYPE" ticker="H" />
            <AmountCard token="USDC" ticker="$" />
          </section>

          <button type="button" className={styles.connectButton}>Connect wallet</button>
        </section>

        <aside className={styles.marketPanel} aria-label="Pool market information">
          <div className={styles.chartCard}>
            <div className={styles.chartHeader}><span>HYPE price in USDC ↔</span><span>APR&nbsp; <strong>295%</strong></span></div>
            <DepthChart />
          </div>
          <PoolMetrics />
        </aside>
      </div>
    </div>
  );
}

function RangeField({ label, value, delta }: { label: string; value: string; delta: string }) {
  return (
    <div className={styles.rangeField}>
      <div className={styles.rangeFieldCopy}><span className={styles.fieldLabel}>{label}</span><strong className={styles.rangeValue}>{value}</strong><span className={styles.rangeDelta}>{delta}</span></div>
      <div className={styles.stepper}><button className={styles.stepButton} type="button" aria-label={`Increase ${label}`}>+</button><button className={styles.stepButton} type="button" aria-label={`Decrease ${label}`}>−</button></div>
    </div>
  );
}

function AmountCard({ token, ticker }: { token: string; ticker: string }) {
  return (
    <div className={styles.amountCard}>
      <div className={styles.amountInputWrap}><label className="sr-only" htmlFor={`amount-${token}`}>{token} amount</label><input id={`amount-${token}`} className={styles.amountInput} inputMode="decimal" placeholder="0.0" /><div className={styles.amountUsd}>≈ $0.00</div></div>
      <div className={styles.tokenSide}><button className={styles.tokenSelect} type="button"><span className={styles.miniToken}>{ticker}</span>{token}</button><span className={styles.balance}>Balance: 0</span></div>
    </div>
  );
}

function DepthChart() {
  return (
    <svg className={styles.depthChart} viewBox="0 0 600 330" preserveAspectRatio="none" role="img" aria-label="Hard-coded HYPE and USDC liquidity distribution">
      <line className={styles.chartGridLine} x1="0" y1="80" x2="600" y2="80" />
      <line className={styles.chartGridLine} x1="0" y1="165" x2="600" y2="165" />
      <line className={styles.chartGridLine} x1="0" y1="250" x2="600" y2="250" />
      <path className={styles.chartBid} d="M22 294h22v-12H22zm28 0h22v-18H50zm28 0h22v-25H78zm28 0h22v-32h-22zm28 0h22v-48h-22zm28 0h22v-66h-22zm28 0h22v-88h-22zm28 0h22V178h-22zm28 0h22V132h-22zm28 0h22V82h-22z" />
      <path className={styles.chartAsk} d="M320 294h22V68h-22zm28 0h22V108h-22zm28 0h22V151h-22zm28 0h22V190h-22zm28 0h22v-74h-22zm28 0h22v-57h-22zm28 0h22v-43h-22zm28 0h22v-31h-22zm28 0h22v-22h-22zm28 0h22v-15h-22z" />
      <line className={styles.chartMid} x1="300" y1="28" x2="300" y2="304" />
    </svg>
  );
}

function PoolMetrics() {
  const rows = [
    ["TVL", "$2,387,185"],
    ["Total rewards this epoch", "$93,389"],
    ["Average APR", "278%"],
    ["Current fee tier", "0.12%"],
  ] as const;
  return (
    <section className={styles.metrics}>
      <h2 className={styles.metricsTitle}>Pool metrics</h2>
      <div className={styles.shareBar} aria-hidden="true"><span /><span /></div>
      <div className={styles.shareLegend}><span><strong className={styles.accentValue}>41.1%</strong>&nbsp; $980,731</span><span>$1,406,455&nbsp; <strong className={styles.accentValue}>58.9%</strong></span></div>
      <div className={styles.metricRows}>
        {rows.map(([label, value]) => <div className={styles.metricRow} key={label}><span className={styles.metricLabel}>{label}</span><strong>{value}</strong></div>)}
        <div className={styles.metricRow}><span className={styles.metricLabel}>Pool address</span><a href="https://hyperevmscan.io/address/0x5a177cf0effb7e0e7115d792e587c1a5a9cbc9d4" target="_blank" rel="noreferrer">0x5a17…c9d4</a></div>
      </div>
    </section>
  );
}
