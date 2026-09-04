"use client";

import { ArrowRight, FunnelSimple, MagnifyingGlass } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  usePools, fromUnits, usd, pct, px8, duration, STATUS_LABEL,
  type PoolsMarket, type PoolsResponse,
} from "./use-pools";
import styles from "./liquidity.module.css";
import { TokenPair } from "./token-pair";
import { DeskHookSection, type HookPoolRow } from "./desk-hook-section";

/**
 * The liquidity board.
 *
 * Every figure comes from a chain read or an indexer row. The page this
 * replaced was a static table of Hyperliquid pools with a hardcoded TVL and an
 * epoch counter for a vault that has no epochs, so the rule here is that a
 * number we cannot source is shown as absent rather than filled in.
 *
 * The shape is not one-pool-per-pair. The Desk is a single pooled USDG vault
 * backing every market at once, so it is the headline row and the only place
 * USDG is deposited. Market rows below it show how each market draws on that
 * shared vault (net OI against its own cap) and what its own fee stream is.
 */

type Filter = "all" | "live" | "queue";

export function LiquidityMarket() {
  const { data, isLoading, error } = usePools();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  // DeskHook pools come from their own route (session 01LqS83j), so a hook read
  // that reverts cannot take down the vault board people actually deposit into.
  // Empty is the normal answer: the hook is not deployed on any real network yet.
  const [hook, setHook] = useState<{
    pools: HookPoolRow[];
    quote: { symbol: string; decimals: number } | null;
  }>({ pools: [], quote: null });

  useEffect(() => {
    let live = true;
    fetch("/api/float/hook-pools")
      .then((r) => r.json())
      .then((d) => { if (live) setHook({ pools: d.pools ?? [], quote: d.quote ?? null }); })
      .catch(() => { /* section stays absent */ });
    return () => { live = false; };
  }, []);

  if (error) return <BoardError message={(error as Error).message} />;
  if (isLoading || !data) return <BoardSkeleton />;

  return (
    <div className={styles.page}>
      <Summary data={data} />
      <DeskVaultCard data={data} />
      {hook.quote && hook.pools.length > 0 ? (
        <DeskHookSection
          pools={hook.pools}
          quoteSymbol={hook.quote.symbol}
          quoteDecimals={hook.quote.decimals}
        />
      ) : null}

      <div className={styles.toolbar}>
        <label className={styles.searchWrap}>
          <MagnifyingGlass className={styles.searchIcon} weight="bold" />
          <span className="sr-only">Search markets</span>
          <input
            className={styles.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by ticker, name or contract"
          />
        </label>
        <button
          type="button"
          className={styles.filterButton}
          onClick={() => setFilter(filter === "all" ? "live" : filter === "live" ? "queue" : "all")}
        >
          <FunnelSimple size={15} weight="bold" />
          {filter === "all" ? "All markets" : filter === "live" ? "Live only" : "In the queue"}
        </button>
        <Link className={styles.primaryButton} href={`/liquidity/${data.desk.address}`}>
          Add liquidity
        </Link>
      </div>

      <MarketTable data={data} query={query} filter={filter} />
      {data.tokens.length > 0 ? <LaunchedTokens data={data} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ summary */

function Summary({ data }: { data: PoolsResponse }) {
  const dp = data.quote.decimals;
  const tvl = fromUnits(data.desk.available, dp);
  const equity = fromUnits(data.desk.equity, dp);
  const shares = fromUnits(data.desk.totalShares, dp);
  // Share price is equity per share. It is the only honest yield number here:
  // realized, not projected off a fee run-rate.
  const growth = shares > 0 ? (equity / shares - 1) * 100 : 0;

  const stats: Array<[string, string, string?]> = [
    ["Desk vault", usd(tvl), `${data.quote.symbol} available to quote`],
    ["Vault equity", usd(equity), `${shares.toLocaleString()} shares outstanding`],
    ["Share price", equity && shares ? (equity / shares).toFixed(5) : "-", `${pct(growth)} since inception`],
    ["7d volume", usd(fromUnits(String(Math.round(data.totals.volume7d)), dp)), `${data.totals.tradeCount} trades indexed`],
  ];

  return (
    <section className={styles.summary} aria-label="Liquidity summary">
      {stats.map(([label, value, sub]) => (
        <div className={styles.stat} key={label}>
          <span className={styles.statLabel}>{label}</span>
          <strong className={styles.statValue}>{value}</strong>
          {sub ? <span className={styles.cellSubtle}>{sub}</span> : null}
        </div>
      ))}
      <div className={styles.summarySignal}>
        <span className={styles.signalCopy}>
          {data.network.label.toUpperCase()} · {data.network.testnet ? "TESTNET" : "MAINNET"} ·{" "}
          {data.markets.filter((m) => m.status === 0).length}/{data.markets.length} LIVE
        </span>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- desk vault */

function DeskVaultCard({ data }: { data: PoolsResponse }) {
  const dp = data.quote.decimals;
  const equity = fromUnits(data.desk.equity, dp);
  const shares = fromUnits(data.desk.totalShares, dp);
  const fees7d = fromUnits(String(Math.round(data.totals.fees7d)), dp);

  return (
    <section className={styles.tableShell} aria-label="Desk vault">
      <div className={styles.poolRow}>
        <div className={styles.poolIdentity}>
          <TokenPair tokenA={data.quote.symbol} tokenB="DESK" />
          <div>
            <Link className={styles.poolName} href={`/liquidity/${data.desk.address}`}>
              {data.quote.symbol}
              <span className={styles.tokenMeta}> · </span>
              The Desk
            </Link>
            <div className={styles.poolBadges}>
              <span className={styles.poolBadge}>{(data.desk.txFeeBps / 100).toFixed(2)}% tx fee</span>
              <span className={styles.poolBadge}>{duration(data.desk.withdrawDelay)} exit</span>
              <span className={styles.poolBadge}>shared vault</span>
            </div>
          </div>
        </div>
        <div>
          <span className={styles.mobileLabel}>TVL</span>
          <span className={styles.cellValue}>{usd(fromUnits(data.desk.available, dp))}</span>
        </div>
        <div>
          <span className={styles.mobileLabel}>Share price</span>
          <span className={`${styles.cellValue} ${styles.accentValue}`}>
            {shares > 0 ? (equity / shares).toFixed(5) : "-"}
          </span>
          <span className={styles.cellSubtle}>realized, not projected</span>
        </div>
        <div>
          <span className={styles.mobileLabel}>7d fees</span>
          <span className={styles.cellValue}>{usd(fees7d, { max: 2 })}</span>
        </div>
        <div>
          <span className={styles.mobileLabel}>Backs</span>
          <span className={styles.cellValue}>{data.markets.length} markets</span>
        </div>
        <div>
          <Link className={styles.depositLink} href={`/liquidity/${data.desk.address}`}>
            Deposit <ArrowRight size={13} weight="bold" />
          </Link>
        </div>
      </div>

      <FunderRow data={data} />
    </section>
  );
}

function FunderRow({ data }: { data: PoolsResponse }) {
  const dp = data.quote.decimals;
  const target = fromUnits(data.funder.target, dp);
  const funded = fromUnits(data.funder.funded, dp);
  const head = data.markets.find((m) => m.assetId.toLowerCase() === data.funder.assetId.toLowerCase());
  const progress = target > 0 ? (funded / target) * 100 : 0;

  return (
    <div className={styles.poolRow}>
      <div className={styles.poolIdentity}>
        <TokenPair tokenA={data.quote.symbol} tokenB={head?.ticker ?? "?"} />
        <div>
          <Link className={styles.poolName} href={`/liquidity/${data.funder.address}`}>
            Funding queue
            <span className={styles.tokenMeta}> · </span>
            {head?.ticker ?? "next market"}
          </Link>
          <div className={styles.poolBadges}>
            <span className={styles.poolBadge}>{data.funder.queueLength} queued</span>
            <span className={styles.poolBadge}>Desk shares pro-rata</span>
          </div>
        </div>
      </div>
      <div>
        <span className={styles.mobileLabel}>Target</span>
        <span className={styles.cellValue}>{usd(target)}</span>
      </div>
      <div>
        <span className={styles.mobileLabel}>Funded</span>
        <span className={`${styles.cellValue} ${styles.accentValue}`}>{pct(progress, 1)}</span>
        <span className={styles.cellSubtle}>{usd(funded)} in</span>
      </div>
      <div>
        <span className={styles.mobileLabel}>From fees</span>
        <span className={styles.cellValue}>{usd(fromUnits(data.funder.feeBalance, dp))}</span>
      </div>
      <div>
        <span className={styles.mobileLabel}>Opens at</span>
        <span className={styles.cellValue}>{usd(target)}</span>
      </div>
      <div>
        {data.funder.acceptsContribution ? (
          <Link className={styles.depositLink} href={`/liquidity/${data.funder.address}`}>
            Contribute <ArrowRight size={13} weight="bold" />
          </Link>
        ) : (
          <span className={styles.cellSubtle}>fees only</span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- market table */

function MarketTable({ data, query, filter }: { data: PoolsResponse; query: string; filter: Filter }) {
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.markets
      .filter((m) => (filter === "live" ? m.status === 0 : filter === "queue" ? m.status !== 0 : true))
      .filter((m) => !q || `${m.ticker} ${m.displayName} ${m.token}`.toLowerCase().includes(q))
      .sort((a, b) => a.status - b.status || b.volume7d - a.volume7d);
  }, [data.markets, query, filter]);

  const dp = data.quote.decimals;

  return (
    <section className={styles.tableShell} aria-label="Markets">
      <div className={styles.tableHeader} aria-hidden="true">
        <span className={styles.columnLabel}>Market</span>
        <span className={styles.columnLabel}>Mark</span>
        <span className={styles.columnLabel}>Net OI / cap</span>
        <span className={styles.columnLabel}>7d fees</span>
        <span className={styles.columnLabel}>24h volume</span>
        <span />
      </div>

      <div>
        {rows.map((m) => (
          <MarketRow key={m.assetId} m={m} dp={dp} symbol={data.quote.symbol} />
        ))}
        {rows.length === 0 ? (
          <div className="px-5 py-14 text-center text-sm text-[var(--color-text-muted)]">
            No market matches “{query}”.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function MarketRow({ m, dp, symbol }: { m: PoolsMarket; dp: number; symbol: string }) {
  const mark = px8(m.markPx);
  const cap = fromUnits(m.oiCapQuote, dp);
  // netOI is in base (fSHARE) units at 18dp, valued at the mark for comparison
  // against a quote-denominated cap.
  const oiShares = Number(BigInt(m.netOI)) / 1e18;
  const oiValue = oiShares * mark;
  const used = cap > 0 ? (Math.abs(oiValue) / cap) * 100 : 0;
  const staked = m.totalStaked ? Number(BigInt(m.totalStaked)) / 1e18 : 0;

  return (
    <article className={styles.poolRow}>
      <div className={styles.poolIdentity}>
        <TokenPair tokenA={`f${m.ticker}`} tokenB={symbol} />
        <div>
          <Link className={styles.poolName} href={`/liquidity/${m.token}`}>
            f{m.ticker}
            <span className={styles.tokenMeta}> / </span>
            {symbol}
          </Link>
          <div className={styles.poolBadges}>
            <span className={styles.poolBadge}>{STATUS_LABEL[m.status]}</span>
            <span className={styles.poolBadge}>
              {m.marketOpen ? `${m.baseSpreadBps / 100}% spread` : `${m.ahSpreadBps / 100}% night`}
            </span>
            {staked > 0 ? <span className={styles.poolBadge}>{staked.toFixed(2)} staked</span> : null}
          </div>
        </div>
      </div>
      <div>
        <span className={styles.mobileLabel}>Mark</span>
        <span className={styles.cellValue}>{usd(mark, { max: 2 })}</span>
        <span className={styles.cellSubtle}>{m.marketOpen ? "home open" : "home closed"}</span>
      </div>
      <div>
        <span className={styles.mobileLabel}>Net OI</span>
        <span className={styles.cellValue}>{usd(oiValue, { max: 0 })}</span>
        <span className={styles.cellSubtle}>{pct(used, 1)} of {usd(cap)}</span>
      </div>
      <div>
        <span className={styles.mobileLabel}>7d fees</span>
        <span className={styles.cellValue}>
          {m.trades > 0 ? usd(fromUnits(String(Math.round(m.fees7d)), dp), { max: 2 }) : "no trades yet"}
        </span>
      </div>
      <div>
        <span className={styles.mobileLabel}>24h volume</span>
        <span className={styles.cellValue}>
          {m.volume24h > 0 ? usd(fromUnits(String(Math.round(m.volume24h)), dp)) : "-"}
        </span>
      </div>
      <div>
        {m.status === 0 ? (
          <Link className={styles.depositLink} href={`/liquidity/${m.token}`}>
            Stake <ArrowRight size={13} weight="bold" />
          </Link>
        ) : (
          <span className={styles.cellSubtle}>not open</span>
        )}
      </div>
    </article>
  );
}

/* ---------------------------------------------------------- launched tokens */

function LaunchedTokens({ data }: { data: PoolsResponse }) {
  return (
    <section className={styles.tableShell} aria-label="Launched tokens">
      <div className={styles.sectionTitleRow} style={{ padding: "14px 20px 0" }}>
        <h2 className={styles.sectionTitle}>Launched tokens</h2>
        <span className={styles.cellSubtle}>
          curves settled in an fSHARE, so their volume is demand for the equity underneath
        </span>
      </div>
      <div>
        {data.tokens.map((t) => {
          const raised = Number(BigInt(t.raised)) / 1e18;
          const target = Number(BigInt(t.gradTarget)) / 1e18;
          const progress = target > 0 ? (raised / target) * 100 : 0;
          return (
            <article className={styles.poolRow} key={t.token}>
              <div className={styles.poolIdentity}>
                <TokenPair tokenA={t.symbol} tokenB={`f${t.underlyingTicker}`} />
                <div>
                  <Link className={styles.poolName} href={`/token/${t.token}`}>
                    {t.symbol}
                    <span className={styles.tokenMeta}> / </span>
                    f{t.underlyingTicker}
                  </Link>
                  <div className={styles.poolBadges}>
                    <span className={styles.poolBadge}>{t.graduated ? "graduated" : "on curve"}</span>
                    <span className={styles.poolBadge}>{t.name}</span>
                  </div>
                </div>
              </div>
              <div>
                <span className={styles.mobileLabel}>Raised</span>
                <span className={styles.cellValue}>{raised.toFixed(3)} f{t.underlyingTicker}</span>
              </div>
              <div>
                <span className={styles.mobileLabel}>To graduation</span>
                <span className={`${styles.cellValue} ${styles.accentValue}`}>{pct(progress, 1)}</span>
                <span className={styles.cellSubtle}>target {target.toFixed(2)}</span>
              </div>
              <div>
                <span className={styles.mobileLabel}>Sold</span>
                <span className={styles.cellValue}>
                  {(Number(BigInt(t.sold)) / 1e18 / 1e6).toFixed(1)}M
                </span>
              </div>
              <div>
                <span className={styles.mobileLabel}>Venue</span>
                <span className={styles.cellValue}>{t.graduated ? "v4 pool" : "curve"}</span>
              </div>
              <div>
                <Link className={styles.depositLink} href={`/token/${t.token}`}>
                  Trade <ArrowRight size={13} weight="bold" />
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- placeholders */

function BoardSkeleton() {
  return (
    <div className={styles.page}>
      <div className="px-1 py-16 text-center text-sm text-[var(--color-text-muted)]">
        Reading the vault from chain…
      </div>
    </div>
  );
}

function BoardError({ message }: { message: string }) {
  return (
    <div className={styles.page}>
      <div className="mx-1 my-10 rounded border border-[var(--color-border-soft)] px-5 py-8 text-sm">
        <p className="mb-2 font-medium">The liquidity board could not read the chain.</p>
        <p className="text-[var(--color-text-muted)]">{message}</p>
        <p className="mt-3 text-[var(--color-text-muted)]">
          The Float indexer serves this on :8462. Start it with{" "}
          <code>scripts/soak-up.sh</code> in ~/float. Nothing is shown here rather than
          showing numbers we cannot source.
        </p>
      </div>
    </div>
  );
}
