"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { usePools, fromUnits, usd, pct, duration, POOLS_QUERY_KEY, type PoolsResponse } from "./use-pools";
import styles from "./liquidity.module.css";
import { TokenPair } from "./token-pair";
import { useFloatWallet } from "@/components/wallet/float-wallet-provider";
import { tx, waitFor, deskShares } from "@/lib/float/chain";
import { readableError } from "@/lib/float/errors";

/**
 * Deposit panel.
 *
 * This replaced a Uniswap-style concentrated-liquidity range builder with five
 * invented APR tiers and a drawn depth chart. The Desk is not a CL pool: it is a
 * shared vault you buy shares of, so there is no range to pick, no tick, and no
 * per-range APR to quote. What there is: a share price, a queue you can fund,
 * and a withdrawal delay.
 */

type Mode = "desk" | "funder" | "market";

export function LiquidityDetail() {
  const params = useParams<{ pool: string }>();
  const pool = (params?.pool ?? "").toLowerCase();
  const { data, isLoading } = usePools();

  if (isLoading || !data) {
    return <div className={styles.detailPage}><p className="py-16 text-center text-sm">Reading the vault…</p></div>;
  }

  const mode: Mode =
    pool === data.desk.address.toLowerCase() ? "desk"
    : pool === data.funder?.address.toLowerCase() ? "funder"
    : "market";

  const market = data.markets.find((m) => m.token.toLowerCase() === pool);

  return (
    <div className={styles.detailPage}>
      <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
        <Link href="/">Home</Link><span>›</span>
        <Link href="/liquidity">Liquidity</Link><span>›</span>
        <span>{mode === "desk" ? "The Desk" : mode === "funder" ? "Funding queue" : market ? `f${market.ticker}` : "Pool"}</span>
      </nav>

      <div className={styles.detailGrid}>
        <section className={styles.builder}>
          {mode === "desk" ? <DeskDeposit data={data} />
            : mode === "funder" && data.funder ? <FunderContribute data={data} funder={data.funder} />
            : market ? <MarketStake data={data} ticker={market.ticker} assetId={market.assetId} token={market.token} status={market.status} />
            : <p className="text-sm">Unknown pool {pool}.</p>}
        </section>

        <aside className={styles.marketPanel} aria-label="Pool information">
          <VaultMetrics data={data} />
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ desk deposit */

function DeskDeposit({ data }: { data: PoolsResponse }) {
  const wallet = useFloatWallet();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [myShares, setMyShares] = useState<number | null>(null);

  const dp = data.quote.decimals;
  const equity = fromUnits(data.desk.equity, dp);
  const shares = fromUnits(data.desk.totalShares, dp);
  const sharePrice = shares > 0 ? equity / shares : 1;
  const n = Number(amount) || 0;

  useMemo(() => {
    if (!wallet.address) { setMyShares(null); return; }
    void deskShares(wallet.address).then((s) => setMyShares(Number(s) / 10 ** dp)).catch(() => setMyShares(null));
  }, [wallet.address, dp]);

  async function deposit() {
    setBusy(true);
    try {
      const account = wallet.getAccount();
      if (wallet.wrongChain) await wallet.switchChain();
      const raw = BigInt(Math.round(n * 10 ** dp));
      toast.info("Approving and depositing…");
      const hash = await tx.deskDeposit(account, raw);
      await waitFor(hash);
      toast.success(`Deposited ${usd(n)} into the Desk.`);
      setAmount("");
      await wallet.refreshBalance();
      await qc.invalidateQueries({ queryKey: POOLS_QUERY_KEY });
    } catch (e) {
      toast.error(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className={styles.poolHeading}>
        <TokenPair tokenA={data.quote.symbol} tokenB="DESK" />
        <div>
          <h1>{data.quote.symbol} · The Desk</h1>
          <div className={styles.poolBadges}>
            <span className={styles.poolBadge}>{(data.desk.txFeeBps / 100).toFixed(2)}% tx fee</span>
            <span className={styles.poolBadge}>{duration(data.desk.withdrawDelay)} exit</span>
          </div>
        </div>
      </header>

      <p className={styles.pageDescription}>
        One pooled vault quotes every market. Depositing {data.quote.symbol} mints shares of
        it, and the share price moves with the spread and size impact the Desk earns
        across all {data.markets.length} markets, including the fSHARE demand created by
        every token launched on the launchpad. Shares are marked against live open
        interest, so the price falls as well as rises.
      </p>

      <section className={styles.formSection}>
        <div className={styles.sectionTitleRow}>
          <h2 className={styles.sectionTitle}>Deposit</h2>
          <span className={styles.balance}>
            Balance: {wallet.balance === null ? "-" : `${wallet.balance.toFixed(2)} ${data.quote.symbol}`}
          </span>
        </div>
        <div className={styles.amountCard}>
          <div className={styles.amountInputWrap}>
            <input
              className={styles.amountInput}
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            />
            <span className={styles.tokenSelect}>{data.quote.symbol}</span>
          </div>
          <div className={styles.amountUsd}>
            {n > 0 ? `≈ ${(n / sharePrice).toFixed(4)} shares at ${sharePrice.toFixed(5)}` : " "}
          </div>
        </div>

        {wallet.connected ? (
          <button
            type="button"
            className={styles.connectButton}
            disabled={busy || n <= 0 || (wallet.balance !== null && n > wallet.balance)}
            onClick={deposit}
          >
            {busy ? "Confirming…"
              : wallet.wrongChain ? `Switch to ${data.network.label}`
              : n <= 0 ? "Enter an amount"
              : wallet.balance !== null && n > wallet.balance ? `Not enough ${data.quote.symbol}`
              : `Deposit ${usd(n)}`}
          </button>
        ) : (
          <button type="button" className={styles.connectButton} onClick={() => void wallet.connect()}>
            Connect wallet
          </button>
        )}

        {data.network.testnet && wallet.connected ? <FaucetButton symbol={data.quote.symbol} dp={dp} /> : null}
      </section>

      {myShares !== null && myShares > 0 ? (
        <Withdraw data={data} myShares={myShares} sharePrice={sharePrice} />
      ) : null}
    </>
  );
}

function Withdraw({ data, myShares, sharePrice }: { data: PoolsResponse; myShares: number; sharePrice: number }) {
  const wallet = useFloatWallet();
  const [busy, setBusy] = useState(false);
  const dp = data.quote.decimals;

  async function requestExit() {
    setBusy(true);
    try {
      const account = wallet.getAccount();
      const hash = await tx.deskRequestWithdraw(account, BigInt(Math.round(myShares * 10 ** dp)));
      await waitFor(hash);
      toast.success(`Exit requested. Claimable in ${duration(data.desk.withdrawDelay)}.`);
    } catch (e) {
      toast.error(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.formSection}>
      <div className={styles.sectionTitleRow}>
        <h2 className={styles.sectionTitle}>Your position</h2>
        <span className={styles.balance}>{myShares.toFixed(4)} shares</span>
      </div>
      <div className={styles.metricRows}>
        <div className={styles.metricRow}>
          <span className={styles.metricLabel}>Value at current share price</span>
          <span className={styles.cellValue}>{usd(myShares * sharePrice)}</span>
        </div>
        <div className={styles.metricRow}>
          <span className={styles.metricLabel}>Exit delay</span>
          <span className={styles.cellValue}>{duration(data.desk.withdrawDelay)}</span>
        </div>
      </div>
      <button type="button" className={styles.secondaryButton} disabled={busy} onClick={requestExit}>
        {busy ? "Confirming…" : "Request withdrawal"}
      </button>
    </section>
  );
}

/* -------------------------------------------------------- funder contribute */

function FunderContribute({ data, funder }: { data: PoolsResponse; funder: NonNullable<PoolsResponse["funder"]> }) {
  const wallet = useFloatWallet();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const dp = data.quote.decimals;
  const target = fromUnits(funder.target, dp);
  const funded = fromUnits(funder.funded, dp);
  const head = data.markets.find((m) => m.assetId.toLowerCase() === funder.assetId.toLowerCase());
  const n = Number(amount) || 0;

  async function contribute() {
    setBusy(true);
    try {
      const account = wallet.getAccount();
      if (wallet.wrongChain) await wallet.switchChain();
      const hash = await tx.contribute(account, funder.assetId, BigInt(Math.round(n * 10 ** dp)));
      await waitFor(hash);
      toast.success(`Contributed ${usd(n)} toward ${head?.ticker ?? "the next market"}.`);
      setAmount("");
      await qc.invalidateQueries({ queryKey: POOLS_QUERY_KEY });
    } catch (e) {
      toast.error(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className={styles.poolHeading}>
        <TokenPair tokenA={data.quote.symbol} tokenB={head?.ticker ?? "?"} />
        <div>
          <h1>Funding queue · {head?.ticker ?? "next market"}</h1>
          <div className={styles.poolBadges}>
            <span className={styles.poolBadge}>{funder.queueLength} queued</span>
            <span className={styles.poolBadge}>{pct(target > 0 ? (funded / target) * 100 : 0, 1)} funded</span>
          </div>
        </div>
      </header>

      <p className={styles.pageDescription}>
        Markets open one at a time. Protocol fees fill the head of the queue on their
        own, and anyone can bring it forward by contributing {data.quote.symbol} directly.
        Contributors receive Desk shares pro-rata once the market opens, so this is the
        same vault position as a direct deposit, bought earlier.
      </p>

      <section className={styles.formSection}>
        <div className={styles.sectionTitleRow}>
          <h2 className={styles.sectionTitle}>Contribute</h2>
          <span className={styles.balance}>
            {usd(funded)} of {usd(target)} raised
          </span>
        </div>
        <div className={styles.amountCard}>
          <div className={styles.amountInputWrap}>
            <input
              className={styles.amountInput}
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            />
            <span className={styles.tokenSelect}>{data.quote.symbol}</span>
          </div>
          <div className={styles.amountUsd}>
            {n > 0 ? `${pct(((funded + n) / target) * 100, 1)} funded after this` : " "}
          </div>
        </div>
        {!funder.acceptsContribution ? (
          <p className={styles.cellSubtle}>
            Nothing is queued for contribution right now, so this market fills from
            protocol fees only. Direct contributions revert until a market is enqueued.
          </p>
        ) : wallet.connected ? (
          <button type="button" className={styles.connectButton} disabled={busy || n <= 0} onClick={contribute}>
            {busy ? "Confirming…" : n <= 0 ? "Enter an amount" : `Contribute ${usd(n)}`}
          </button>
        ) : (
          <button type="button" className={styles.connectButton} onClick={() => void wallet.connect()}>
            Connect wallet
          </button>
        )}
      </section>
    </>
  );
}

/* ------------------------------------------------------------- market stake */

function MarketStake({
  data, ticker, assetId, token, status,
}: {
  data: PoolsResponse; ticker: string; assetId: `0x${string}`; token: `0x${string}`; status: number;
}) {
  const wallet = useFloatWallet();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const n = Number(amount) || 0;

  async function stake() {
    setBusy(true);
    try {
      const account = wallet.getAccount();
      if (wallet.wrongChain) await wallet.switchChain();
      const hash = await tx.stake(account, assetId, BigInt(Math.round(n * 1e18)), token);
      await waitFor(hash);
      toast.success(`Staked ${n} f${ticker}.`);
      setAmount("");
    } catch (e) {
      toast.error(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className={styles.poolHeading}>
        <TokenPair tokenA={`f${ticker}`} tokenB={data.quote.symbol} />
        <div>
          <h1>f{ticker} stake vault</h1>
          <div className={styles.poolBadges}>
            <span className={styles.poolBadge}>{(data.desk.stakerFeeBps / 100).toFixed(2)}% staker fee</span>
          </div>
        </div>
      </header>

      <p className={styles.pageDescription}>
        Staking f{ticker} back into its own market deepens the size the Desk can quote
        there and earns that market&apos;s staker fee stream, paid in {data.quote.symbol}.
        This is a different position from the Desk vault: it takes the equity&apos;s price
        risk, because you are holding the fSHARE.
      </p>

      {status !== 0 ? (
        <p className={styles.pageDescription}>
          This market is not open yet, so there is nothing to stake. Fund it from the
          queue to bring it forward.
        </p>
      ) : (
        <section className={styles.formSection}>
          <div className={styles.sectionTitleRow}>
            <h2 className={styles.sectionTitle}>Stake</h2>
          </div>
          <div className={styles.amountCard}>
            <div className={styles.amountInputWrap}>
              <input
                className={styles.amountInput}
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              />
              <span className={styles.tokenSelect}>f{ticker}</span>
            </div>
          </div>
          {wallet.connected ? (
            <button type="button" className={styles.connectButton} disabled={busy || n <= 0} onClick={stake}>
              {busy ? "Confirming…" : n <= 0 ? "Enter an amount" : `Stake ${n} f${ticker}`}
            </button>
          ) : (
            <button type="button" className={styles.connectButton} onClick={() => void wallet.connect()}>
              Connect wallet
            </button>
          )}
        </section>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ shared */

function FaucetButton({ symbol, dp }: { symbol: string; dp: number }) {
  const wallet = useFloatWallet();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={styles.secondaryButton}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const hash = await tx.faucetUsdg(wallet.getAccount(), BigInt(1000 * 10 ** dp));
          await waitFor(hash);
          toast.success(`Minted 1,000 test ${symbol}.`);
          await wallet.refreshBalance();
        } catch (e) {
          toast.error(readableError(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Minting…" : `Get 1,000 test ${symbol}`}
    </button>
  );
}

function VaultMetrics({ data }: { data: PoolsResponse }) {
  const dp = data.quote.decimals;
  const equity = fromUnits(data.desk.equity, dp);
  const shares = fromUnits(data.desk.totalShares, dp);

  const rows: Array<[string, string]> = [
    ["Available to quote", usd(fromUnits(data.desk.available, dp))],
    ["Vault equity", usd(equity)],
    ["Shares outstanding", shares.toLocaleString()],
    ["Share price", shares > 0 ? (equity / shares).toFixed(5) : "-"],
    ["Trade fee", `${(data.desk.txFeeBps / 100).toFixed(2)}%`],
    ["Staker share", `${(data.desk.stakerFeeBps / 100).toFixed(2)}%`],
    ["Withdrawal delay", duration(data.desk.withdrawDelay)],
    ["Markets backed", String(data.markets.length)],
    ["Live now", String(data.markets.filter((m) => m.status === 0).length)],
  ];

  return (
    <div className={styles.metrics}>
      <h2 className={styles.metricsTitle}>Desk vault</h2>
      <div className={styles.metricRows}>
        {rows.map(([label, value]) => (
          <div className={styles.metricRow} key={label}>
            <span className={styles.metricLabel}>{label}</span>
            <span className={styles.cellValue}>{value}</span>
          </div>
        ))}
      </div>
      {/* Every figure above is the Desk's, protocol wide. It sits beside a
          single market's stake form, and "Vault" over "markets backed 40" read
          as though 40 markets stood behind THIS one. Name whose numbers these
          are, or the page invites exactly that misreading. */}
      <p className={styles.cellSubtle} style={{ marginTop: 12 }}>
        These are the Desk&rsquo;s own figures, across every market it quotes, not this
        market alone. Share price is equity per share and moves with the Desk&rsquo;s
        inventory as well as its fees.
      </p>
      <p className={styles.cellSubtle} style={{ marginTop: 8 }}>
        Registry {data.network.registry.slice(0, 10)}… on {data.network.label}. Every
        address on this page resolves from it at runtime.
      </p>
    </div>
  );
}

