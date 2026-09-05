"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, CopySimple, DiscordLogo, GlobeSimple, TelegramLogo, User, XLogo } from "@phosphor-icons/react";
import { Skeleton } from "@/components/ui/skeleton";
import { useTokenDetail } from "@/hooks/use-token-detail";
import { useTokenTrades } from "@/hooks/use-token-trades";
import { useTokenHolders } from "@/hooks/use-token-holders";
import { useTokenContracts } from "@/hooks/use-token-contracts";
import { ContractsGrid } from "@/components/token/contracts-grid";
import { useCandles } from "@/hooks/use-candles";
import { TradingChartSkeleton } from "@/components/trading/trading-chart-skeleton";
import { FloorlaunchTradePanel } from "@/components/trading/floorlaunch-trade-panel";
import { fetchTokenChange24h } from "@/lib/api";
import type { Timeframe, TokenListItem, TokenTrade } from "@/lib/api";
import { DEFAULT_TOKEN_SUPPLY } from "@/lib/chain-config";
import { explorerUrl } from "@/lib/floorlaunch/config";
import { activeNetwork } from "@/lib/float/networks";

const NETWORK_LABEL = activeNetwork().label;

const TradingChart = dynamic(
  () =>
    import("@/components/trading/trading-chart").then(
      (module) => module.TradingChart,
    ),
  { ssr: false, loading: () => <TradingChartSkeleton terminal /> },
);

const TIMEFRAMES: Array<{ value: Timeframe; label: string }> = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "12h", label: "12H" },
  { value: "1d", label: "1D" },
];

export default function TokenDetailPage() {
  const params = useParams();
  const address = params.address as string;
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [chartHeight, setChartHeight] = useState(700);
  const resizeStart = useRef({ y: 0, height: 700 });
  const { data: token, isLoading, error } = useTokenDetail(address);
  const contracts = useTokenContracts(address);
  const { data: trades } = useTokenTrades(address, 2_000);
  // Hold the last non-empty result so a transient empty refetch does not blank
  // the table, reset when the token changes. This was a ref mutated during
  // render, which is not render-pure and breaks under concurrent rendering;
  // adjusting state during render is the sanctioned form of the same thing.
  const [tradesFor, setTradesFor] = useState(address);
  const [lastTrades, setLastTrades] = useState<TokenTrade[]>([]);
  if (tradesFor !== address) {
    setTradesFor(address);
    setLastTrades([]);
  } else if (trades?.length && trades !== lastTrades) {
    setLastTrades(trades);
  }
  const visibleTrades = trades?.length ? trades : lastTrades;
  const candles = useCandles(address, timeframe);
  const holdersQuery = useTokenHolders(address);
  // The single-token detail fetch does not carry a 24h change, so derive it from
  // candle history (same source the list uses) to fill the header consistently.
  const change24hQuery = useQuery({
    queryKey: ["token-change", address],
    queryFn: () => fetchTokenChange24h(address),
    staleTime: 5 * 60 * 1000,
    enabled: Boolean(address),
  });

  function startInformationResize(event: React.PointerEvent<HTMLDivElement>) {
    resizeStart.current = { y: event.clientY, height: chartHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }

  function resizeInformation(event: React.PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const delta = event.clientY - resizeStart.current.y;
    setChartHeight(
      Math.min(1_000, Math.max(320, resizeStart.current.height + delta)),
    );
  }

  function stopInformationResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  if (isLoading) return <TerminalSkeleton />;
  if (error || !token) {
    return (
      <div className="flex min-h-[calc(100vh-64px)] items-center justify-center bg-[var(--color-bg-page)] text-red-300">
        Token not found
      </div>
    );
  }

  const solUsd = token.market.solUsd;
  // current_price is raw quote micro-units per token, scaled 1e6. /1e6 -> quote
  // asset per token, then x the oracle USD rate -> USD/token. On the
  // CurveFunder venue the quote asset is USDG and solUsd is 1, so the second
  // step is the identity.
  const price = (Number(token.current_price || 0) / 1e6) * solUsd;
  const collectibleName = (token.name ?? "collectible").replace(/\s*Floor$/i, "");
  const floorSol = token.market.cardIndexSol;
  const liquidityCollectibles = floorSol > 0 ? token.market.ammSolReserve / floorSol : 0;
  const change24h = token.price_change_24h ?? change24hQuery.data ?? null;
  const stats = {
    marketCap: currencyCompact(price * DEFAULT_TOKEN_SUPPLY),
    // Per-token price is tiny; show significant digits instead of rounding to $0.
    price: price >= 0.01 ? currencyCompact(price) : `$${Number(price.toPrecision(3))}`,
    change: change24h,
    vol: currencyCompact((Number(token.volume_24h) / 1_000_000) * solUsd),
    // Liquidity in collectible value - the whole point of a collectible market.
    liquidity: `${formatCollectible(liquidityCollectibles)} ${collectibleName}`,
    liquidityUsd: currencyCompact(token.market.ammSolReserve * solUsd),
    holders: String(holdersQuery.data?.length ?? 0),
  };

  return (
    <div className="terminal-page mx-auto flex min-h-[calc(100vh-64px)] w-full max-w-[1440px] min-w-0 flex-col gap-4 bg-[var(--color-bg-page)] p-4 text-[var(--color-text-primary)] xl:grid xl:grid-cols-[minmax(0,1fr)_360px] xl:grid-rows-[auto_auto] 2xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* TOP-LEFT: chart card */}
        <div className="flex min-w-0 flex-col overflow-hidden rounded-2xl bg-[var(--color-bg-page)]">
        <div className="flex h-[70px] shrink-0 items-center justify-between gap-6 overflow-x-auto border-b border-[var(--color-border-soft)] px-4 py-2">
          <div className="flex shrink-0 items-center gap-2.5">
            {token.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={token.image}
                alt={token.name ?? token.symbol ?? "Token"}
                className="h-11 w-11 rounded-full border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] object-cover"
              />
            ) : (
              <span className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] text-sm text-[var(--color-text-secondary)]">
                {token.symbol?.[0]}
              </span>
            )}
            <div className="min-w-0">
              <div className="flex h-8 items-center gap-1.5">
                <p className="max-w-52 truncate text-[15px] font-bold leading-none text-[var(--color-text-primary)]">{token.name}</p>
                {/* The pair, not the venue. "AMM" was the same word on every
                    graduated token and said nothing about what this one is
                    priced in; the pair names the fSHARE underneath it. Not
                    uppercased, because the leading lowercase f in fNTDO2 is the
                    part that says it is an fSHARE. Absent while it loads and
                    absent if it cannot be read, rather than falling back to a
                    category that would read as an answer. */}
                {contracts.data?.pair && (
                  <span className="shrink-0 rounded border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-1.5 py-1 text-[10px] font-semibold tracking-tight text-[var(--color-text-secondary)]">
                    {contracts.data.pair}
                  </span>
                )}
                {(token.listing.links?.website ||
                  token.listing.links?.twitter ||
                  token.listing.links?.telegram ||
                  token.listing.links?.discord) && (
                  <>
                    <span className="mx-0.5 h-5 w-px bg-[var(--color-bg-hover)]" />
                    <div className="flex shrink-0 items-center gap-1">
                      <SocialLink href={token.listing.links?.website} label="Website">
                        <GlobeSimple size={15} />
                      </SocialLink>
                      <SocialLink href={token.listing.links?.twitter} label="X / Twitter">
                        <XLogo size={15} />
                      </SocialLink>
                      <SocialLink href={token.listing.links?.telegram} label="Telegram">
                        <TelegramLogo size={15} weight="fill" />
                      </SocialLink>
                      <SocialLink href={token.listing.links?.discord} label="Discord">
                        <DiscordLogo size={15} weight="fill" />
                      </SocialLink>
                    </div>
                  </>
                )}
              </div>
              <div className="flex h-5 items-center gap-2 text-[11px] font-medium text-[var(--color-text-muted)]">
                <span className="max-w-40 truncate">{collectibleName}</span>
                <span className="h-4 w-px bg-[var(--color-bg-hover)]" />
                <CopyValue value={token.mint} />
              </div>
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center justify-end gap-2">
            <StatTile label="Market cap" value={stats.marketCap} />
            <StatTile label="Price" value={stats.price} />
            <StatTile label="24h change" value={formatChange(stats.change)} tone={stats.change} />
            <StatTile label="24h vol." value={stats.vol} />
            <StatTile label="Liquidity" value={stats.liquidityUsd} />
            <StatTile label="Holders" value={stats.holders} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border-soft)] px-4 py-1.5 text-[var(--color-text-secondary)]">
          {TIMEFRAMES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTimeframe(value)}
              className={
                timeframe === value
                  ? "rounded-md bg-[var(--color-bg-hover)] px-2.5 py-1 text-xs font-semibold text-[var(--color-text-primary)]"
                  : "rounded-md px-2.5 py-1 text-xs font-semibold hover:bg-[var(--color-bg-page)] hover:text-[var(--color-text-primary)]"
              }
            >
              {label}
            </button>
          ))}
        </div>
        <div
          className="terminal-chart shrink-0 overflow-hidden px-2 pt-1"
          style={{ height: chartHeight }}
        >
          <TradingChart
            tokenAddress={address}
            terminal
            timeframe={timeframe}
            fallbackPrice={Number(token.current_price)}
            solUsd={solUsd}
            candleData={candles.data}
            candleLoading={candles.isLoading}
            candleError={candles.error}
            onRetry={() => candles.refetch()}
          />
        </div>
        </div>
        {/* TOP-RIGHT: trade + about rail. */}
        <aside className="flex min-w-0 flex-col gap-4">
          <FloorlaunchTradePanel token={token} />
          <Overview token={token} trades={visibleTrades} />
          <ContractsGrid address={token.address} />
        </aside>
        {/* BOTTOM-LEFT: expanded info panel (Holders / Transactions) */}
        <TokenInformationPanel
          token={token}
          trades={visibleTrades}
          onResizeStart={startInformationResize}
          onResize={resizeInformation}
          onResizeEnd={stopInformationResize}
        />
        {/* BOTTOM-RIGHT: proposals, isolated under the right rail. The spacer
            matches the info panel's resize handle so both cards align top/bottom. */}
        <div className="flex h-[700px] min-w-0 flex-col">
          <div className="hidden h-2.5 shrink-0 xl:block" />
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[var(--color-bg-page)]">
          </section>
        </div>
    </div>
  );
}

type InformationTab = "holders" | "transactions";

function TokenInformationPanel({
  token,
  trades,
  onResizeStart,
  onResize,
  onResizeEnd,
}: {
  token: TokenListItem;
  trades: TokenTrade[];
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onResize: (event: React.PointerEvent<HTMLDivElement>) => void;
  onResizeEnd: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const [tab, setTab] = useState<InformationTab>("holders");
  const holders = useTokenHolders(token.address);
  // Same pattern as the trades above, and the same reason.
  const [holdersFor, setHoldersFor] = useState(token.address);
  const [lastHolders, setLastHolders] = useState<Array<{ address: string; balance: string }>>([]);
  if (holdersFor !== token.address) {
    setHoldersFor(token.address);
    setLastHolders([]);
  } else if (holders.data?.length && holders.data !== lastHolders) {
    setLastHolders(holders.data);
  }
  const visibleHolders = holders.data?.length ? holders.data : lastHolders;

  return (
    <div
      className="flex shrink-0 flex-col"
      style={{ height: 700 }}
    >
      <div
        role="separator"
        aria-label="Resize chart height"
        aria-orientation="horizontal"
        onPointerDown={onResizeStart}
        onPointerMove={onResize}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="group flex h-2.5 shrink-0 touch-none cursor-row-resize items-center justify-center"
      >
        <span className="h-1 w-10 rounded-full bg-[var(--color-bg-raised)] transition-colors group-hover:bg-[var(--color-text-muted)] group-active:bg-[var(--color-accent-solid)]" />
      </div>
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[var(--color-bg-page)]">
      <div className="flex h-10 shrink-0 items-center gap-5 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3">
        <InformationTabButton active={tab === "holders"} onClick={() => setTab("holders")}>
          Holders{visibleHolders.length ? ` (${visibleHolders.length})` : ""}
        </InformationTabButton>
        <InformationTabButton active={tab === "transactions"} onClick={() => setTab("transactions")}>
          Transactions{trades.length ? ` (${trades.length})` : ""}
        </InformationTabButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "holders" && (
          <HoldersTable
            holders={visibleHolders}
            loading={holders.isLoading}
            symbol={token.symbol ?? "TOKEN"}
          />
        )}

        {tab === "transactions" && (
          <TransactionsTable trades={trades} symbol={token.symbol ?? "TOKEN"} baseLabel={token.base_label ?? "QUOTE"} />
        )}

      </div>
      </section>
    </div>
  );
}

function InformationTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-10 border-b-2 text-sm font-semibold transition-colors ${
        active
          ? "border-[var(--color-border-soft)] text-[var(--color-text-primary)]"
          : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
      }`}
    >
      {children}
    </button>
  );
}

function HoldersTable({
  holders,
  loading,
  symbol,
}: {
  holders: Array<{ address: string; balance: string; label?: string | null }>;
  loading: boolean;
  symbol: string;
}) {
  if (loading) {
    return <PanelMessage>Loading holders…</PanelMessage>;
  }
  if (!holders.length) {
    return <PanelMessage>No holders found for this token.</PanelMessage>;
  }

  // Balances are 18dp wei and the supply constant is in whole tokens. The old
  // pair of 1e6 assumptions came from the 6dp ansem build and made both the
  // position and the supply share wrong by orders of magnitude.
  const supplyWhole = DEFAULT_TOKEN_SUPPLY;
  return (
    <table className="w-full min-w-[600px] text-[13px]">
      <thead className="sticky top-0 z-10 bg-[var(--color-bg-page)] text-[var(--color-text-subtle)]">
        <tr>
          <th className="border-b border-[var(--color-border-soft)] px-4 py-2 text-left text-xs font-medium">Trader</th>
          <th className="border-b border-[var(--color-border-soft)] px-4 py-2 text-right text-xs font-medium">Position</th>
          <th className="border-b border-[var(--color-border-soft)] px-4 py-2 text-right text-xs font-medium">Supply</th>
        </tr>
      </thead>
      <tbody>
        {holders.map((holder) => {
          const whole = Number(holder.balance) / 1e18;
          const percentage = supplyWhole > 0 ? (whole / supplyWhole) * 100 : 0;
          // The label comes from the Registry (the curve holding its unsold
          // supply, the Desk, a stake vault), not from a hardcoded address.
          const tag = holder.label ? LABEL_TEXT[holder.label] ?? holder.label : null;
          return (
            <tr key={holder.address} className="border-b border-[var(--color-border-soft)] transition-colors last:border-0 hover:bg-[var(--color-bg-page)]">
              <td className="px-4 py-2">
                <div className="flex items-center gap-2.5">
                  <WalletAvatar address={holder.address} />
                  <div className="flex items-center gap-1.5">
                    <a href={explorerUrl("address", holder.address)} target="_blank" rel="noreferrer" className="font-mono text-[13px] font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-accent-strong)]">
                      {short(holder.address)}
                    </a>
                    {tag && (
                      <span className="rounded-[4px] border border-[var(--color-accent-solid)]/30 bg-[var(--color-accent-solid)]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent-strong)]">
                        {tag}
                      </span>
                    )}
                  </div>
                </div>
              </td>
              <td className="px-4 py-2 text-right">
                <p className="text-[13px] font-semibold text-[var(--color-text-primary)]">{formatWholeAmount(whole)}</p>
                <p className="mt-0.5 text-[11px] text-[var(--color-text-subtle)]">{symbol}</p>
              </td>
              <td className="px-4 py-2 text-right text-[13px] font-semibold text-[var(--color-text-secondary)]">
                {percentage < 0.01 ? "<0.01" : percentage.toFixed(2)}%
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Flags the pool-owned holders so a big balance is not mistaken for a whale:
 *  the AMM contract holds a graduated pool's liquidity (LP), the launchpad holds
 *  a curve's unsold reserves. */
/** Registry keys to the words a reader wants. */
const LABEL_TEXT: Record<string, string> = {
  TOKEN_LAUNCHPAD: "Bonding curve",
  CURVE_FUNDER: "Bonding curve",
  DESK: "The Desk",
  STAKE_VAULTS: "Stake vault",
  FUNDER: "Funding queue",
  V4_POOL_MANAGER: "v4 pool",
  GRADUATOR: "Graduator",
  BURNED: "Burned",
};

function formatWholeAmount(amount: number): string {
  if (!Number.isFinite(amount)) return "0";
  return Intl.NumberFormat("en-US", {
    notation: amount >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(amount);
}

function WalletAvatar({ address }: { address: string }) {
  return (
    <span
      title={address}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-raised)] text-[var(--color-text-muted)] ring-1 ring-inset ring-white/10"
    >
      <User size={18} weight="fill" />
    </span>
  );
}

function TransactionsTable({ trades, symbol, baseLabel }: { trades: TokenTrade[]; symbol: string; baseLabel: string }) {
  if (!trades.length) {
    return <PanelMessage>No indexed transactions for this token yet.</PanelMessage>;
  }

  return (
    <table className="w-full min-w-[720px] text-[13px]">
      <thead className="sticky top-0 z-10 bg-[var(--color-bg-page)] text-[var(--color-text-subtle)]">
        <tr>
          <th className="border-b border-[var(--color-border-soft)] px-4 py-2 text-left text-xs font-medium">Time</th>
          <th className="border-b border-[var(--color-border-soft)] px-4 py-2 text-left text-xs font-medium">Type</th>
          <th className="border-b border-[var(--color-border-soft)] px-4 py-2 text-right text-xs font-medium">{baseLabel}</th>
          <th className="border-b border-[var(--color-border-soft)] px-4 py-2 text-right text-xs font-medium">{symbol}</th>
          <th className="border-b border-[var(--color-border-soft)] px-4 py-2 text-left text-xs font-medium">Trader</th>
          <th className="border-b border-[var(--color-border-soft)] px-4 py-2 text-right text-xs font-medium">Txn</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((trade, index) => {
          const buy = trade.action === "buy";
          return (
            <tr key={`${trade.tx_hash}-${index}`} className="border-b border-[var(--color-border-soft)] transition-colors last:border-0 hover:bg-[var(--color-bg-page)]">
              <td className="whitespace-nowrap px-4 py-2 text-[var(--color-text-muted)]">{relativeTime(trade.time)} ago</td>
              <td className="px-4 py-2">
                <span className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${buy ? "bg-[#0f2e1e] text-[var(--color-positive)]" : "bg-[#3a1418] text-[#f87171]"}`}>
                  {trade.action}
                </span>
              </td>
              <td className="px-4 py-2 text-right text-[13px] font-semibold text-[var(--color-text-primary)]">{compact(Number(trade.hodl_amount) / 1_000_000)}</td>
              <td className="px-4 py-2 text-right text-[13px] font-semibold text-[var(--color-text-secondary)]">{compact(Number(trade.token_amount) / 1_000_000)}</td>
              <td className="px-4 py-2 font-mono text-[13px]">
                <a href={explorerUrl("address", trade.trader)} target="_blank" rel="noreferrer" className="text-[var(--color-text-muted)] hover:text-[var(--color-accent-strong)]">{short(trade.trader)}</a>
              </td>
              <td className="px-4 py-2 text-right font-mono">
                <a href={explorerUrl("tx", trade.tx_hash)} target="_blank" rel="noreferrer" className="text-[var(--color-text-muted)] hover:text-[var(--color-accent-strong)]">{short(trade.tx_hash)}</a>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PanelMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-36 items-center justify-center px-6 text-center text-sm text-[var(--color-text-muted)]">{children}</div>;
}


function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: number | null;
}) {
  return (
    <div className="min-w-[88px] shrink-0 px-3 py-1.5">
      <p className="text-center text-[11px] font-medium text-[var(--color-text-muted)]">{label}</p>
      <p
        className={`text-center text-[15px] font-bold leading-5 ${
          tone == null ? "text-[var(--color-text-primary)]" : tone >= 0 ? "text-[var(--color-positive)]" : "text-[#f87171]"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function TokenSummary({ token, price }: { token: TokenListItem; price: number }) {
  const volumeUsd =
    (Number(token.volume_24h) / 1_000_000) * token.market.solUsd;
  return (
    <section className="rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {token.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={token.image}
              alt={token.name ?? token.symbol ?? "Token"}
              className="h-9 w-9 shrink-0 rounded-lg object-cover"
            />
          ) : (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-hover)] text-sm">
              {token.symbol?.[0]}
            </span>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-sm font-bold leading-tight">{token.name}</h1>
            <p className="text-xs text-[var(--color-text-muted)]">${token.symbol}</p>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)]">
          {token.market.dbcPool ? "METEORA DBC" : token.graduated ? "AMM" : "CURVE"}
        </span>
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] text-[var(--color-text-muted)]">Market cap</p>
          <p className="truncate text-xl font-bold tracking-tight">
            {currencyCompact(price * DEFAULT_TOKEN_SUPPLY)}
            <span className={`ml-1.5 text-xs ${changeClass(token.price_change_24h)}`}>
              {formatChange(token.price_change_24h)}
            </span>
          </p>
        </div>
        <p className="shrink-0 text-xs font-semibold text-[var(--color-text-muted)]">
          Vol {currencyCompact(volumeUsd)}
        </p>
      </div>
    </section>
  );
}

type OverviewRange = "5m" | "1h" | "4h" | "1d";

const OVERVIEW_RANGES: Array<{ value: OverviewRange; label: string; ms: number }> = [
  { value: "5m", label: "5M", ms: 5 * 60_000 },
  { value: "1h", label: "1H", ms: 60 * 60_000 },
  { value: "4h", label: "4H", ms: 4 * 60 * 60_000 },
  { value: "1d", label: "1D", ms: 24 * 60 * 60_000 },
];

function Overview({ token, trades }: { token: TokenListItem; trades: TokenTrade[] }) {
  const [range, setRange] = useState<OverviewRange>("1d");
  const [expanded, setExpanded] = useState(false);
  // Keep `now` live so the rolling 5M/1H/4H/1D windows keep sliding as new trades
  // arrive (the trades themselves refetch every 30s). A frozen `now` made the
  // windows anchor to page-load time and go stale.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  function tradesFor(ms: number) {
    const cutoff = now - ms;
    return trades.filter((trade) => new Date(trade.time).getTime() >= cutoff);
  }

  function changeFor(ms: number) {
    const periodTrades = tradesFor(ms);
    if (periodTrades.length < 2) return null;
    const newest = periodTrades[0]?.price_sol ?? 0;
    const oldest = periodTrades[periodTrades.length - 1]?.price_sol ?? 0;
    return oldest > 0 ? ((newest / oldest) - 1) * 100 : null;
  }

  const selectedMs = OVERVIEW_RANGES.find((item) => item.value === range)?.ms ?? 86_400_000;
  const periodTrades = tradesFor(selectedMs);
  const buys = periodTrades.filter((trade) => trade.action === "buy");
  const sells = periodTrades.filter((trade) => trade.action === "sell");
  const buyVolume = buys.reduce((sum, trade) => sum + Number(trade.hodl_amount) / 1_000_000, 0) * token.market.solUsd;
  const sellVolume = sells.reduce((sum, trade) => sum + Number(trade.hodl_amount) / 1_000_000, 0) * token.market.solUsd;
  const buyers = new Set(buys.map((trade) => trade.trader)).size;
  const sellers = new Set(sells.map((trade) => trade.trader)).size;

  return (
    <section className="relative rounded-xl bg-[var(--color-bg-page)] px-3 pb-4 pt-3">
      <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">About {token.name}</h2>
      <p className="mt-1.5 line-clamp-3 text-[11px] leading-[15px] text-[var(--color-text-secondary)]">
        {token.description?.trim() || `${token.name} is quoted and settled in ${token.base_label}, so every buy of it buys the equity underneath.`}
      </p>

      {(token.social_links?.length ?? 0) > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {token.social_links!.map((url) => {
            let label = "Link";
            try {
              const host = new URL(url).hostname.replace(/^www\./, "");
              label = host === "x.com" || host === "twitter.com" ? "𝕏 Twitter" : host;
            } catch {
              /* keep generic label for an unparseable URL */
            }
            return (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="rounded-full border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2.5 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border)] hover:text-[var(--color-text-primary)]"
              >
                {label}
              </a>
            );
          })}
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-4 gap-1.5">
        {OVERVIEW_RANGES.map((item) => {
          const change = changeFor(item.ms);
          const active = range === item.value;
          return (
            <button
              key={item.value}
              type="button"
              onClick={() => setRange(item.value)}
              className={`h-[46px] rounded-lg border px-1 py-1.5 text-center transition-colors ${
                active
                  ? "border-[var(--color-border-soft)] bg-[var(--color-bg-raised)]"
                  : "border-[var(--color-border-soft)] bg-transparent hover:bg-[var(--color-bg-page)]"
              }`}
            >
              <span className="block text-[10px] font-semibold leading-3 text-[var(--color-text-secondary)]">{item.label}</span>
              <span className={`mt-0.5 block text-[11px] font-bold leading-4 ${change == null ? "text-[var(--color-text-muted)]" : change >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}`}>
                {change == null ? "-" : `${change >= 0 ? "▲" : "▼"} ${Math.abs(change).toFixed(2)}%`}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 space-y-4">
        <SplitMetric left={`${buys.length.toLocaleString()} buys`} right={`${sells.length.toLocaleString()} sells`} leftValue={buys.length} rightValue={sells.length} />
        <SplitMetric left={`${currencyCompact(buyVolume)} vol.`} right={`${currencyCompact(sellVolume)} vol.`} leftValue={buyVolume} rightValue={sellVolume} />
        <SplitMetric left={`${buyers.toLocaleString()} buyers`} right={`${sellers.toLocaleString()} sellers`} leftValue={buyers} rightValue={sellers} />
      </div>

      <div
        className={`grid transition-[grid-template-rows,opacity,margin] duration-300 ease-out ${
          expanded
            ? "mt-4 grid-rows-[1fr] opacity-100"
            : "mt-0 grid-rows-[0fr] opacity-0"
        }`}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-[var(--color-border-soft)] pt-3">
            <div className="flex flex-wrap gap-1.5">
              <OverviewLink href={token.listing.links?.website} label="Website">
                <GlobeSimple size={12} />
              </OverviewLink>
              <OverviewLink href={token.listing.links?.twitter} label="Twitter">
                <XLogo size={12} />
              </OverviewLink>
              <OverviewLink href={token.listing.links?.telegram} label="Telegram">
                <TelegramLogo size={12} weight="fill" />
              </OverviewLink>
            </div>
            <div className="mt-2 text-[10px]">
              <OverviewDetailRow label="Created" value={overviewCreatedLabel(token, now)} />
              <OverviewDetailRow label="Chain" value={NETWORK_LABEL} />
              <OverviewDetailRow
                label="Venue"
                value={token.graduated ? "Uniswap v4 pool" : "Launch curve"}
              />
              <OverviewDetailRow label="Contract address">
                <CopyValue value={token.mint} />
              </OverviewDetailRow>
            </div>
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="absolute -bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-[var(--color-bg-raised)] px-3 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-text-primary)]"
      >
        {expanded ? "View less" : "View more"}
      </button>
    </section>
  );
}

function OverviewLink({
  href,
  label,
  children,
}: {
  href?: string;
  label: string;
  children: React.ReactNode;
}) {
  const className = "inline-flex h-7 items-center gap-1.5 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-2.5 text-[11px] font-semibold text-[var(--color-text-primary)]";
  if (!href) {
    return <span className={`${className} cursor-not-allowed opacity-40`}>{children}{label}</span>;
  }
  return (
    <a href={externalUrl(href)} target="_blank" rel="noopener noreferrer" className={`${className} hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-text-primary)]`}>
      {children}{label}
    </a>
  );
}

function OverviewDetailRow({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-2.5">
      <span className="shrink-0 text-[11px] font-medium text-[var(--color-text-muted)]">{label}</span>
      <span className="h-px min-w-3 flex-1 border-t border-dashed border-[var(--color-border-muted)]" />
      <span className="min-w-0 shrink-0 text-right text-[11px] font-semibold text-[var(--color-text-primary)]">{children ?? value}</span>
    </div>
  );
}

function overviewCreatedLabel(token: TokenListItem, now: number): string {
  const createdAt = token.listing.launchedAt
    ? token.listing.launchedAt * 1_000
    : new Date(token.created_at ?? token.first_seen_at).getTime();
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1_000));
  if (!Number.isFinite(seconds)) return "Unknown";
  if (seconds < 60) return "Just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function SplitMetric({
  left,
  right,
  leftValue,
  rightValue,
}: {
  left: string;
  right: string;
  leftValue: number;
  rightValue: number;
}) {
  const total = leftValue + rightValue;
  const leftWidth = total > 0 ? (leftValue / total) * 100 : 50;
  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-xs font-semibold text-[var(--color-text-primary)]">
        <span>{left}</span>
        <span>{right}</span>
      </div>
      <div className="mt-1.5 flex h-1.5 gap-1 overflow-hidden rounded-full">
        <span className="rounded-full bg-[var(--color-positive)]" style={{ width: `${leftWidth}%` }} />
        <span className="flex-1 rounded-full bg-[#ff5b35]" />
      </div>
    </div>
  );
}

function SocialLink({
  href,
  label,
  children,
}: {
  href?: string;
  label: string;
  children: React.ReactNode;
}) {
  // Only render when the link is actually set; no dead placeholders.
  if (!href) return null;

  return (
    <a
      href={externalUrl(href)}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center rounded bg-[var(--color-bg-page)] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-text-primary)]"
    >
      {children}
    </a>
  );
}

function externalUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="group inline-flex max-w-full items-center gap-1.5 font-medium text-[var(--color-text-primary)] transition-colors hover:text-[#8ff573]"
      aria-label={`Copy ${value}`}
      title={value}
    >
      <span className="truncate">{short(value)}</span>
      {copied ? (
        <Check size={15} weight="bold" className="shrink-0 text-emerald-400" />
      ) : (
        <CopySimple
          size={15}
          className="shrink-0 text-[var(--color-text-muted)] transition-colors group-hover:text-[#8ff573]"
        />
      )}
    </button>
  );
}

function short(value: string): string {
  return value.length > 18
    ? `${value.slice(0, 8)}...${value.slice(-6)}`
    : value;
}

function tiny(value: number): string {
  return value ? `$${value.toFixed(8)}` : "$0.00000000";
}

function compact(value: number): string {
  return Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value || 0);
}

// Collectible-equivalent count: more decimals for fractional amounts.
function formatCollectible(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value.toLocaleString("en-US", {
    maximumFractionDigits: value < 1 ? 4 : 2,
  });
}

function currencyCompact(value: number): string {
  return Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value || 0);
}

function formatChange(value: number | null): string {
  if (value == null) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function changeClass(value: number | null): string {
  if (value == null) return "ml-3 text-sm font-medium text-[var(--color-text-muted)]";
  return value >= 0
    ? "ml-3 text-sm font-medium text-emerald-400"
    : "ml-3 text-sm font-medium text-red-400";
}

function relativeTime(value: string): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1_000),
  );
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function TerminalSkeleton() {
  return (
    <div className="grid min-h-[calc(100vh-64px)] bg-[var(--color-bg-page)] xl:grid-cols-[minmax(0,1fr)_360px]">
      <Skeleton className="h-full rounded-none bg-[var(--color-bg-page)]" />
      <Skeleton className="h-full rounded-none bg-[var(--color-bg-page)]" />
    </div>
  );
}
