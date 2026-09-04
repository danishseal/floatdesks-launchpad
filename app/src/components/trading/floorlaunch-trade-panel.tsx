"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { TokenListItem } from "@/lib/api";
import {
  buy,
  sell,
  simulateBuy,
  simulateSell,
  ammBuy,
  ammSell,
  ammSimulateBuy,
  ammSimulateSell,
} from "@/lib/ansem/launchpad-tx";
import { denomLabel, explorerUrl } from "@/lib/floorlaunch/config";
import { useFloorWallet } from "@/components/wallet/solana-wallet-provider";
import { ConnectButton } from "@/components/wallet/connect-button";
import { Button } from "@/components/ui/button";
import { Gear } from "@phosphor-icons/react";
import { TOKEN_DETAIL_QUERY_KEY } from "@/hooks/use-token-detail";
import { TOKEN_TRADES_QUERY_KEY, TOKEN_HOLDERS_QUERY_KEY, fetchTokenBalance } from "@/lib/api";

const DEFAULT_SLIPPAGE = 0.02;
const SLIPPAGE_PRESETS = [0.005, 0.01, 0.02, 0.05];
const MIN_SLIPPAGE = 0.001;
const MAX_SLIPPAGE = 0.5;
const UTOKEN = 1_000_000;

// Format a slippage fraction as a percent string without trailing-zero noise.
function pctLabel(frac: number): string {
  return `${Number((frac * 100).toFixed(3))}%`;
}

export function FloorlaunchTradePanel({ token }: { token: TokenListItem }) {
  const wallet = useFloorWallet();
  const queryClient = useQueryClient();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [quoteOut, setQuoteOut] = useState<number | null>(null);
  // Adjustable slippage tolerance (fraction). Defaults to 2%, clamped 0.1%-50%.
  const [slippage, setSlippage] = useState(DEFAULT_SLIPPAGE);
  const [customSlippage, setCustomSlippage] = useState("");
  const [showSlippage, setShowSlippage] = useState(false);
  // The connected wallet's balance of THIS token, so the Sell tab can show how
  // much the user holds (and a Max shortcut). Refetched after each trade (busy).
  const [holdings, setHoldings] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!wallet.address) {
      setHoldings(null);
      return;
    }
    fetchTokenBalance(token.address, wallet.address).then((b) => {
      if (!cancelled) setHoldings(b);
    });
    return () => {
      cancelled = true;
    };
  }, [wallet.address, token.address, busy]);

  const baseDenom = token.base_denom || "uchanse";
  const baseLabel = denomLabel(baseDenom);
  const numeric = Number(amount) || 0;
  // Graduated tokens trade on the AMM, not the curve; route quotes + trades there.
  const graduated = Boolean(token.graduated);

  // Live quote via the on-chain simulate queries (curve or AMM).
  useEffect(() => {
    let cancelled = false;
    if (numeric <= 0) {
      setQuoteOut(null);
      return;
    }
    const inUtoken = String(Math.round(numeric * UTOKEN));
    const p =
      side === "buy"
        ? (graduated ? ammSimulateBuy : simulateBuy)(token.address, inUtoken)
        : (graduated ? ammSimulateSell : simulateSell)(token.address, inUtoken);
    p.then((out) => {
      if (!cancelled) setQuoteOut(Number(out) / UTOKEN);
    }).catch(() => {
      if (!cancelled) setQuoteOut(null);
    });
    return () => {
      cancelled = true;
    };
  }, [side, numeric, token.address, graduated]);

  const outLabel = side === "buy" ? token.symbol ?? "tokens" : baseLabel;
  const payLabel = side === "buy" ? baseLabel : token.symbol ?? "tokens";
  const symbol = token.symbol ?? "tokens";

  // The balance shown on the "available" line and used by the balance shortcut:
  // CHANSE on Buy (what you spend), this token's holdings on Sell.
  const availBalance = side === "buy" ? wallet.balance : holdings;
  const availLabel = side === "buy" ? baseLabel : symbol;

  // Quick-amount chips. Buy uses fixed CHANSE presets; Sell uses fractions of the
  // connected wallet's holdings so the chips always map to something spendable.
  const quickChips: Array<{ label: string; value: string; disabled: boolean }> =
    side === "buy"
      ? [10, 100, 500, 1000].map((p) => ({ label: p.toLocaleString(), value: String(p), disabled: false }))
      : [0.25, 0.5, 0.75, 1].map((f) => ({
          label: f === 1 ? "Max" : `${f * 100}%`,
          value: holdings != null ? String(Number((holdings * f).toFixed(6))) : "",
          disabled: holdings == null || holdings <= 0,
        }));

  const minOut = useMemo(
    () => (quoteOut != null ? Math.floor(quoteOut * (1 - slippage) * UTOKEN) : 0),
    [quoteOut, slippage],
  );

  function applyCustomSlippage(raw: string) {
    setCustomSlippage(raw);
    const pct = Number(raw);
    if (!Number.isFinite(pct) || pct <= 0) return;
    const clamped = Math.min(Math.max(pct / 100, MIN_SLIPPAGE), MAX_SLIPPAGE);
    setSlippage(clamped);
  }

  function selectPreset(frac: number) {
    setSlippage(frac);
    setCustomSlippage("");
  }

  async function submit() {
    if (!wallet.address) return;
    setBusy(true);
    toast.loading(`Confirm the ${side} in your wallet…`, { id: "trade" });
    try {
      const client = await wallet.getSigningClient();
      const inUtoken = String(Math.round(numeric * UTOKEN));
      const hash =
        side === "buy"
          ? await (graduated ? ammBuy : buy)(client, wallet.address, token.address, baseDenom, inUtoken, String(minOut))
          : await (graduated ? ammSell : sell)(client, wallet.address, token.address, inUtoken, String(minOut));
      toast.success(`${side === "buy" ? "Bought" : "Sold"} ${token.symbol ?? "token"}`, {
        id: "trade",
        // Clickable tx hash -> the Floatdesk explorer.
        description: (
          <a
            href={explorerUrl("tx", hash)}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-strong)]"
          >
            {hash.slice(0, 10)}… ↗
          </a>
        ),
      });
      setAmount("");
      const refresh = () => {
        // Chain-backed reads (holders, wallet balance) update immediately;
        // indexer-derived reads (detail, trades, candles) lag a few seconds, so
        // we refetch now AND again after the indexer catches up.
        void queryClient.invalidateQueries({ queryKey: TOKEN_HOLDERS_QUERY_KEY(token.address) });
        void queryClient.invalidateQueries({ queryKey: TOKEN_DETAIL_QUERY_KEY(token.address) });
        void queryClient.invalidateQueries({ queryKey: TOKEN_TRADES_QUERY_KEY(token.address) });
        void queryClient.invalidateQueries({ queryKey: ["candles", token.address] });
        void queryClient.invalidateQueries({ queryKey: ["tokens"] });
        void wallet.refreshBalance();
      };
      refresh();
      window.setTimeout(refresh, 3000);
      window.setTimeout(refresh, 8000);
    } catch (e) {
      toast.error("Trade failed", {
        id: "trade",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-[var(--color-bg-page)] p-4">
      {/* Buy / Sell segmented tabs */}
      <div className="grid grid-cols-2 gap-1 rounded-[10px] bg-[var(--color-bg-page)] p-1">
        {(["buy", "sell"] as const).map((s) => {
          const active = side === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => setSide(s)}
              className={`rounded-[8px] px-4 py-2 font-display text-[13px] font-semibold capitalize transition ${
                active
                  ? s === "buy"
                    ? "bg-[var(--color-accent-solid)]/15 text-[var(--color-accent-strong)]"
                    : "bg-[var(--color-negative)]/15 text-[#ff7a7a]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              {s}
            </button>
          );
        })}
      </div>

      {/* Big amount field */}
      <div className="rounded-[10px] bg-[var(--color-bg-page)] px-4 py-3.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
            {side === "buy" ? "You pay" : "You sell"}
          </span>
          <span className="rounded-[6px] bg-[var(--color-bg-surface)] px-2 py-0.5 font-mono text-[10px] font-semibold text-[var(--color-text-secondary)]">
            {payLabel}
          </span>
        </div>
        <div className="flex items-baseline gap-3">
          <span className="shrink-0 font-mono text-[15px] text-[var(--color-text-subtle)]">{payLabel}</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Enter amount"
            inputMode="decimal"
            aria-label={side === "buy" ? `Amount of ${payLabel} to spend` : `Amount of ${payLabel} to sell`}
            className="min-w-0 flex-1 bg-transparent text-right font-mono text-[28px] font-semibold tabular-nums text-[var(--color-text-primary)] outline-none placeholder:text-[18px] placeholder:font-normal placeholder:text-[var(--color-text-subtle)]"
          />
        </div>
        <p className="mt-2 text-right text-[12px] text-[var(--color-text-muted)]">
          {quoteOut != null && numeric > 0 ? (
            <>
              <span className="text-[var(--color-text-subtle)]">≈ </span>
              <span className="font-mono tabular-nums text-[var(--color-text-secondary)]">
                {quoteOut.toLocaleString(undefined, { maximumFractionDigits: 6 })}
              </span>{" "}
              {outLabel}
            </>
          ) : (
            "Enter an amount to quote"
          )}
        </p>
      </div>

      {/* Quick-amount chips + slippage gear */}
      <div className="flex items-center gap-1.5">
        {quickChips.map((chip, i) => (
          <button
            key={i}
            type="button"
            disabled={chip.disabled}
            onClick={() => setAmount(chip.value)}
            className="flex-1 rounded-[8px] bg-[var(--color-bg-page)] px-2 py-1.5 font-mono text-[11px] font-semibold text-[var(--color-text-secondary)] transition hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[var(--color-bg-page)] disabled:hover:text-[var(--color-text-secondary)]"
          >
            {chip.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowSlippage((v) => !v)}
          title="Slippage settings"
          aria-label="Slippage settings"
          aria-expanded={showSlippage}
          className={`flex shrink-0 items-center justify-center rounded-[8px] px-2 py-1.5 transition ${
            showSlippage
              ? "bg-[var(--color-accent-solid)]/15 text-[var(--color-accent-strong)]"
              : "bg-[var(--color-bg-page)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]"
          }`}
        >
          <Gear size={15} weight="fill" />
        </button>
      </div>

      {/* Slippage control (held by the gear) */}
      {showSlippage && (
        <div className="rounded-[10px] bg-[var(--color-bg-page)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">Slippage tolerance</span>
            <span className="font-mono text-[11px] font-semibold text-[var(--color-accent-strong)]">{pctLabel(slippage)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {SLIPPAGE_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => selectPreset(p)}
                className={`flex-1 rounded-[6px] px-2 py-1.5 font-mono text-[11px] font-semibold transition ${
                  !customSlippage && slippage === p
                    ? "bg-[var(--color-accent-solid)] text-[var(--color-on-accent)]"
                    : "bg-[var(--color-bg-page)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]"
                }`}
              >
                {pctLabel(p)}
              </button>
            ))}
            <div className="relative flex-1">
              <input
                value={customSlippage}
                onChange={(e) => applyCustomSlippage(e.target.value)}
                placeholder="Custom"
                inputMode="decimal"
                aria-label="Custom slippage percent"
                className="w-full rounded-[6px] bg-[var(--color-bg-page)] px-2 py-1.5 pr-5 text-right font-mono text-[11px] text-[var(--color-text-primary)] outline-none transition placeholder:text-[var(--color-text-subtle)] focus:bg-[var(--color-bg-surface)]"
              />
              <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 font-mono text-[11px] text-[var(--color-text-subtle)]">%</span>
            </div>
          </div>
          <p className="mt-2 text-[10px] text-[var(--color-text-subtle)]">Allowed range {pctLabel(MIN_SLIPPAGE)} to {pctLabel(MAX_SLIPPAGE)}.</p>
        </div>
      )}

      {/* Balance line */}
      <button
        type="button"
        onClick={() => {
          if (availBalance != null && availBalance > 0) setAmount(String(availBalance));
        }}
        disabled={availBalance == null || availBalance <= 0}
        title="Use full balance"
        className="flex items-center justify-between text-[11px] text-[var(--color-text-muted)] transition enabled:hover:text-[var(--color-text-secondary)] disabled:cursor-default"
      >
        <span className="uppercase tracking-[0.08em]">Balance</span>
        <span className="font-mono tabular-nums">
          {(availBalance ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} {availLabel} available
        </span>
      </button>

      {/* Action button */}
      {!wallet.connected ? (
        <ConnectButton />
      ) : (
        <Button
          onClick={submit}
          disabled={busy || numeric <= 0}
          className={
            "h-12 rounded-[10px] border-0 font-display text-[14px] font-semibold text-[var(--color-text-primary)] " +
            (side === "buy"
              ? "bg-[var(--color-accent-solid)] hover:bg-[var(--color-accent-strong)]"
              : "bg-[#c9403f] hover:bg-[#d54847]")
          }
        >
          {busy ? "Submitting…" : side === "buy" ? `Buy ${symbol}` : `Sell ${symbol}`}
        </Button>
      )}

      <p className="text-[11px] leading-relaxed text-[var(--color-text-subtle)]">
        Trades settle on the Floatdesk {graduated ? "AMM" : "bonding curve"}. Slippage tolerance {pctLabel(slippage)}.
      </p>
    </div>
  );
}
