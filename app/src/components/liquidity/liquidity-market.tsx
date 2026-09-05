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
import { DeskHookSection, type HookPoolRow, type HookUnreadable } from "./desk-hook-section";

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
  const { data, error } = usePools();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  // DeskHook pools come from their own route (session 01LqS83j), so a hook read
  // that reverts cannot take down the vault board people actually deposit into.
  // Empty is the normal answer: the hook is not deployed on any real network yet.
  const [hook, setHook] = useState<{
    address: string | null;
    pools: HookPoolRow[];
    unreadable: HookUnreadable[];
    quote: { symbol: string; decimals: number } | null;
  }>({ address: null, pools: [], unreadable: [], quote: null });

  useEffect(() => {
    let live = true;
    fetch("/api/float/hook-pools")
      .then((r) => r.json())
      .then((d) => {
        if (live) setHook({
          address: d.hook ?? null,
          pools: d.pools ?? [],
          unreadable: d.unreadable ?? [],
          quote: d.quote ?? null,
        });
      })
      .catch(() => { /* section stays absent */ });
    return () => { live = false; };
  }, []);

  // Order matters. Showing the error state whenever `error` is set threw away a
  // perfectly good board on one transient RPC blip, since react-query keeps the
  // last successful data through a failed refetch. Only surrender the page when
  // there is nothing to show.
  if (!data) return error ? <BoardError message={(error as Error).message} /> : <BoardSkeleton />;

  return (
    <div className={styles.page}>
      {error ? (
        <div className="mx-1 mb-3 rounded border border-[var(--color-border-soft)] px-4 py-2.5 text-[12px] text-[var(--color-text-muted)]">
          Showing the last good read; the latest refresh failed and these figures
          may be stale.
        </div>
      ) : null}
      <Summary data={data} />
      <DeskVaultCard data={data} />
      {/* Gate on the hook EXISTING, not on pools being non-empty. Gating on
          pools meant a hook whose pools were all unreadable rendered exactly
          like a deployment with no hook at all. */}
      {hook.address && hook.quote && (hook.pools.length > 0 || hook.unreadable.length > 0) ? (
        <DeskHookSection
          pools={hook.pools}
          unreadable={hook.unreadable}
          quoteSymbol={hook.quote.symbol}
          quoteDecimals={hook.quote.decimals}
        />
      ) : null}

      {data.indexer?.measured === false ? (
        <div className="mx-1 mb-3 rounded border border-[var(--color-border-soft)] px-4 py-3 text-[13px] text-[var(--color-text-muted)]">
          {data.indexer.status === "wrong-chain" ? (
            <>
              The indexer is running, but it is watching a different deployment
              (its Desk is {data.indexer.desk?.slice(0, 10)}…, ours is{" "}
              {data.desk.address.slice(0, 10)}…), so every volume and fee figure
              below is unmeasured rather than zero.
            </>
          ) : (
            <>
              Trade history is unavailable, so every volume and fee figure below is
              unmeasured rather than zero.
            </>
          )}{" "}
          Vault and market state are read from chain and are unaffected.{" "}
          {data.indexer.error ? <span>({data.indexer.error})</span> : null}
        </div>
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
    data.indexer?.measured === false
      ? ["7d volume", "unmeasured",
          data.indexer.status === "wrong-chain"
            ? "the indexer is on another deployment"
            : "the indexer is unreachable"]
      : ["7d volume", usd(fromUnits(String(Math.round(data.totals.volume7d)), dp)), `${data.totals.tradeCount} trades indexed`],
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
          <span className={styles.cellValue}>
            {data.indexer?.measured === false ? "unmeasured" : usd(fees7d, { max: 2 })}
          </span>
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

      {data.funder ? <FunderRow data={data} funder={data.funder} /> : null}
    </section>
  );
}

function FunderRow({ data, funder }: { data: PoolsResponse; funder: NonNullable<PoolsResponse["funder"]> }) {
  const dp = data.quote.decimals;
  const target = fromUnits(funder.target, dp);
  const funded = fromUnits(funder.funded, dp);
  const head = data.markets.find((m) => m.assetId.toLowerCase() === funder.assetId.toLowerCase());
  const progress = target > 0 ? (funded / target) * 100 : 0;

  return (
    <div className={styles.poolRow}>
      <div className={styles.poolIdentity}>
        <TokenPair tokenA={data.quote.symbol} tokenB={head?.ticker ?? "?"} />
        <div>
          <Link className={styles.poolName} href={`/liquidity/${funder.address}`}>
            Funding queue
            <span className={styles.tokenMeta}> · </span>
            {head?.ticker ?? "next market"}
          </Link>
          <div className={styles.poolBadges}>
            <span className={styles.poolBadge}>{funder.queueLength} queued</span>
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
        <span className={styles.cellValue}>{usd(fromUnits(funder.feeBalance, dp))}</span>
      </div>
      <div>
        <span className={styles.mobileLabel}>Opens at</span>
        <span className={styles.cellValue}>{usd(target)}</span>
      </div>
      <div>
        {funder.acceptsContribution ? (
          <Link className={styles.depositLink} href={`/liquidity/${funder.address}`}>
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
    <section className={styles.tableShell} aria-label="Desk markets">
      <div className={styles.sectionTitleRow} style={{ padding: "14px 20px 0" }}>
        <h2 className={styles.sectionTitle}>Desk markets</h2>
        <span className={styles.cellSubtle}>
          quoted by the shared vault above. The same fSHARE can also sit in a public
          v4 pool, which is separate capital and counted separately.
        </span>
      </div>
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
          <MarketRow key={m.assetId} m={m} dp={dp} symbol={data.quote.symbol} feedOk={data.indexer?.measured !== false} />
        ))}
        {rows.length === 0 ? (
          <div className="px-5 py-14 text-center text-sm text-[var(--color-text-muted)]">
            No market matches “{query}”.
          </div>
        ) : null}
        {data.unreadable?.length ? (
          <div className="border-t border-[var(--color-border-soft)] px-5 py-3 text-[12px] text-[var(--color-text-muted)]">
            {data.unreadable.length} market
            {data.unreadable.length === 1 ? "" : "s"} could not be read and{" "}
            {data.unreadable.length === 1 ? "is" : "are"} not listed above:{" "}
            {data.unreadable.map((u) => `${u.assetId.slice(0, 10)}… (${u.reason})`).join("; ")}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function MarketRow({ m, dp, symbol, feedOk }: { m: PoolsMarket; dp: number; symbol: string; feedOk: boolean }) {
  const mark = px8(m.markPx);
  // Desk.buy measures OI at the ORACLE price against the listed cap PLUS the
  // StakeVaults boost, so the cap sentence below uses both. Valuing at the mark
  // against the listed cap read correct only while the premium was zero and
  // nothing was staked, and would have overstated utilisation the moment anyone
  // staked into the market whose staked amount this row already displays.
  const px = m.oraclePx ? px8(m.oraclePx) : mark;
  const listedCap = fromUnits(m.oiCapQuote, dp);
  const cap = m.oiCapEffective === null ? listedCap : fromUnits(m.oiCapEffective, dp);
  const boosted = cap > listedCap;
  const oiShares = Number(BigInt(m.netOI)) / 1e18;
  const oiValue = oiShares * px;
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
            <span className={styles.poolBadge}>Desk</span>
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
        <span className={styles.cellSubtle}>
          {m.oiCapEffective === null
            ? `${pct(used, 1)} of ${usd(cap)} listed`
            : boosted
              ? `${pct(used, 1)} of ${usd(cap)}, staked up from ${usd(listedCap)}`
              : `${pct(used, 1)} of ${usd(cap)}`}
        </span>
      </div>
      <div>
        <span className={styles.mobileLabel}>7d fees</span>
        <span className={styles.cellValue}>
          {!feedOk ? "unmeasured" : m.trades > 0 ? usd(fromUnits(String(Math.round(m.fees7d)), dp), { max: 2 }) : "no trades yet"}
        </span>
      </div>
      <div>
        <span className={styles.mobileLabel}>24h volume</span>
        <span className={styles.cellValue}>
          {!feedOk ? "unmeasured" : m.volume24h > 0 ? usd(fromUnits(String(Math.round(m.volume24h)), dp)) : "-"}
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
          // Scale follows the venue: CurveFunder quotes in USDG at 6dp,
          // TokenLaunchpad in the underlying fSHARE at 18dp. Reading one with
          // the other's divisor is off by twelve orders of magnitude.
          const dp = t.quoteIsUsdg ? 1e6 : 1e18;
          const raised = Number(BigInt(t.raised)) / dp;
          const target = Number(BigInt(t.gradTarget)) / dp;
          const progress = target > 0 ? (raised / target) * 100 : 0;
          const quoteLabel = t.quoteIsUsdg ? data.quote.symbol : `f${t.underlyingTicker}`;
          return (
            <article className={styles.poolRow} key={t.token}>
              <div className={styles.poolIdentity}>
                <TokenPair tokenA={t.symbol} tokenB={quoteLabel} />
                <div>
                  <Link className={styles.poolName} href={`/token/${t.token}`}>
                    {t.symbol}
                    <span className={styles.tokenMeta}> / </span>
                    {quoteLabel}
                  </Link>
                  <div className={styles.poolBadges}>
                    <span className={styles.poolBadge}>{t.graduated ? "graduated" : "on curve"}</span>
                    <span className={styles.poolBadge}>{t.name}</span>
                    {t.superseded ? <span className={styles.poolBadge}>earlier launcher</span> : null}
                  </div>
                </div>
              </div>
              <div>
                <span className={styles.mobileLabel}>Raised</span>
                <span className={styles.cellValue}>
                  {t.quoteIsUsdg ? usd(raised, { max: 2 }) : `${raised.toFixed(3)} ${quoteLabel}`}
                </span>
              </div>
              <div>
                <span className={styles.mobileLabel}>To graduation</span>
                <span className={`${styles.cellValue} ${styles.accentValue}`}>{pct(progress, 1)}</span>
                <span className={styles.cellSubtle}>
                  target {t.quoteIsUsdg ? usd(target) : target.toFixed(2)}
                </span>
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
