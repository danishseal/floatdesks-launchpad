import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "./components/Chart";
import TradePanel from "./components/TradePanel";
import HedgePanel from "./components/HedgePanel";
import UnderlyingStrip from "./components/UnderlyingStrip";
import Panels from "./components/Panels";
import LaunchFlow from "./components/LaunchFlow";
import Explorer from "./components/Explorer";
import Aggregator from "./components/Aggregator";
import {
  fetchMarkets,
  fetchTrades,
  fetchFunding,
  fetchListings,
  subscribe,
  type MarketInfo,
  type Trade,
  type IndexTick,
  type FundingTick,
  type ListingMeta,
} from "./api";
import { useFlWallet } from "./wallet";

export default function App() {
  const wallet = useFlWallet();
  const [view, setView] = useState<"markets" | "launch" | "explorer" | "index">("markets");
  const [aggFocus, setAggFocus] = useState<string | null>(null);
  const [listings, setListings] = useState<Record<string, ListingMeta>>({});
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [funding, setFunding] = useState<FundingTick[]>([]);
  const [lastTrade, setLastTrade] = useState<Trade | null>(null);
  const [lastIndexTick, setLastIndexTick] = useState<IndexTick | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  useEffect(() => {
    const load = () =>
      fetchMarkets()
        .then((ms) => {
          setMarkets(ms);
          if (!selectedRef.current && ms.length) setSelected(ms[0].market);
        })
        .catch(() => {});
    load();
    const loadListings = () => fetchListings().then(setListings).catch(() => {});
    loadListings();
    const iv = setInterval(load, 5000);
    const iv2 = setInterval(loadListings, 10000);
    return () => { clearInterval(iv); clearInterval(iv2); };
  }, []);

  useEffect(() => {
    if (!selected) return;
    fetchTrades(selected).then(setTrades).catch(() => {});
    fetchFunding(selected).then(setFunding).catch(() => {});
  }, [selected]);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.market !== selectedRef.current) return;
      if (msg.type === "trade") {
        setLastTrade(msg.trade);
        setTrades((t) => [msg.trade, ...t].slice(0, 60));
      } else if (msg.type === "index") {
        setLastIndexTick(msg.tick);
      } else if (msg.type === "funding") {
        setFunding((f) => [...f, msg.tick].slice(-200));
      }
    });
  }, []);

  const market = useMemo(
    () => markets.find((m) => m.market === selected) ?? null,
    [markets, selected]
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand" style={{ fontStyle: "italic", fontWeight: 700 }}>
          commas
        </div>
        <nav className="nav">
          <span
            className={`nav-item ${view === "markets" ? "active" : ""}`}
            onClick={() => setView("markets")}
          >
            Markets
          </span>
          <span
            className={`nav-item ${view === "launch" ? "active" : ""}`}
            onClick={() => setView("launch")}
          >
            Launch
          </span>
          <span
            className={`nav-item ${view === "explorer" ? "active" : ""}`}
            onClick={() => setView("explorer")}
          >
            Explorer
          </span>
          <span
            className={`nav-item ${view === "index" ? "active" : ""}`}
            onClick={() => {
              setAggFocus(null);
              setView("index");
            }}
          >
            Index
          </span>
          <a className="nav-item" href="https://commas.art" target="_blank" rel="noreferrer">
            Docs
          </a>
        </nav>
        <div className="top-right">
          <button
            className="wallet-btn"
            onClick={() => (wallet.connected ? wallet.disconnect() : wallet.connect())}
            title={wallet.connected ? "Click to disconnect" : "Connect a Solana wallet"}
          >
            {wallet.label}
          </button>
        </div>
      </header>

      {view === "index" ? (
        <Aggregator
          focus={aggFocus}
          onOpenMarket={(mkt) => {
            setSelected(mkt);
            setView("markets");
          }}
        />
      ) : view === "explorer" ? (
        <Explorer
          markets={markets}
          listings={listings}
          onTrade={(mkt) => {
            setSelected(mkt);
            setView("markets");
          }}
        />
      ) : view === "launch" ? (
        <LaunchFlow
          listings={listings}
          onLaunched={(mkt) => {
            fetchListings().then(setListings).catch(() => {});
            setSelected(mkt);
            setView("markets");
          }}
        />
      ) : market ? (
        <main className="layout">
          <div className="col-main">
            <UnderlyingStrip
              m={market}
              listing={listings[market.market]}
              lastTradePrice={trades[0]?.priceSol ?? null}
              onOpenIndex={() => {
                setAggFocus(listings[market.market]?.identifier ?? null);
                setView("index");
              }}
            />
            <Chart
              market={market.market}
              solUsd={market.solUsd}
              lastTrade={lastTrade}
              lastIndexTick={lastIndexTick}
            />
            <Panels m={market} trades={trades} funding={funding} />
          </div>
          <div className="col-side">
            <TradePanel m={market} listing={listings[market.market]} />
            <HedgePanel m={market} />
          </div>
        </main>
      ) : (
        <div className="empty-state page-empty">Waiting for markets…</div>
      )}
    </div>
  );
}
