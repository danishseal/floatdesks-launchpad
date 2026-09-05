"use client";

/**
 * Trade panel for a launched token.
 *
 * The quote asset is the token's UNDERLYING fSHARE, not a stablecoin, so buying
 * a token means holding that fSHARE first. Rather than reverting with an opaque
 * transfer failure, the panel reads the balance and offers the missing leg:
 * buy the fSHARE from the Desk with USDG, then buy the token on its curve.
 * That is the whole point of the venue, so it is shown rather than hidden.
 */

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Gear } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useFloatWallet } from "@/components/wallet/float-wallet-provider";
import { TOKEN_DETAIL_QUERY_KEY } from "@/hooks/use-token-detail";
import {
  TOKEN_TRADES_QUERY_KEY, TOKEN_HOLDERS_QUERY_KEY, fetchTokenBalance,
  type TokenListItem,
} from "@/lib/api";
import {
  tokenPreviewBuy, tokenPreviewSell, deskPreviewBuy, deskBuyRefusal,
  tx, waitFor, balanceOf, getListing,
} from "@/lib/float/chain";
import {
  routeFor, quoteGraduated, buyGraduated, sellGraduated, type SwapRoute,
} from "@/lib/float/v4-router";

const DEFAULT_SLIPPAGE = 0.02;
const SLIPPAGE_PRESETS = [0.005, 0.01, 0.02, 0.05];
const WAD = 1e18;

function pctLabel(frac: number): string {
  return `${Number((frac * 100).toFixed(3))}%`;
}

export function FloorlaunchTradePanel({ token }: { token: TokenListItem }) {
  const wallet = useFloatWallet();
  const queryClient = useQueryClient();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [quoteOut, setQuoteOut] = useState<number | null>(null);
  const [slippage, setSlippage] = useState(DEFAULT_SLIPPAGE);
  const [customSlippage, setCustomSlippage] = useState("");
  const [showSlippage, setShowSlippage] = useState(false);
  const [holdings, setHoldings] = useState<number | null>(null);
  const [fshare, setFshare] = useState<{ address: `0x${string}`; balance: number } | null>(null);
  // A graduated token no longer has a curve: it lives in two v4 pools. Quote it
  // from the chain's own quoter so the page shows a real price even though
  // execution is not wired yet.
  // Whether the Desk would actually accept the fSHARE leg. previewBuy prices a
  // trade without checking Halted, settle-only or the OI cap, all of which
  // buy() enforces, so quoting from the preview alone advertises trades the
  // chain refuses.
  const [deskRefusal, setDeskRefusal] = useState<string | null>(null);
  const [route, setRoute] = useState<SwapRoute | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);

  const assetId = token.base_denom as `0x${string}`;
  const baseLabel = token.base_label || "fSHARE";
  const numeric = Number(amount) || 0;

  // Token balance for the sell tab.
  useEffect(() => {
    let cancelled = false;
    if (!wallet.address) { setHoldings(null); return; }
    void fetchTokenBalance(token.address, wallet.address).then((b) => {
      if (!cancelled) setHoldings(b);
    });
    return () => { cancelled = true; };
  }, [wallet.address, token.address, busy]);

  // The underlying fSHARE the curve is quoted in, and how much of it we hold.
  useEffect(() => {
    let cancelled = false;
    if (!assetId) return;
    void (async () => {
      try {
        const listing = await getListing(assetId);
        const bal = wallet.address ? await balanceOf(listing.token, wallet.address) : 0n;
        if (!cancelled) setFshare({ address: listing.token, balance: Number(bal) / WAD });
      } catch {
        if (!cancelled) setFshare(null);
      }
    })();
    return () => { cancelled = true; };
  }, [assetId, wallet.address, busy]);

  useEffect(() => {
    let cancelled = false;
    if (!token.graduated) { setRoute(null); setRouteError(null); return; }
    void routeFor(token.address as `0x${string}`).then((r) => {
      if (cancelled) return;
      if ("error" in r) { setRoute(null); setRouteError(r.error); }
      else { setRoute(r); setRouteError(null); }
    }).catch((e) => { if (!cancelled) setRouteError(String(e).slice(0, 120)); });
    return () => { cancelled = true; };
  }, [token.graduated, token.address]);

  // Live quote off the curve's own preview functions, or the v4 quoter once the
  // curve is spent.
  useEffect(() => {
    let cancelled = false;
    if (numeric <= 0) { setQuoteOut(null); return; }
    if (token.graduated) {
      if (!route) { setQuoteOut(null); return; }
      // Buys are priced in USDG (6dp) on the pool route; sells are token in.
      const rawIn = side === "buy"
        ? BigInt(Math.round(numeric * 1e6))
        : BigInt(Math.round(numeric * WAD));
      void quoteGraduated(route, rawIn, side).then((out) => {
        if (cancelled) return;
        setQuoteOut(out === null ? null : Number(out) / (side === "buy" ? WAD : 1e6));
      });
      return;
    }
    const raw = BigInt(Math.round(numeric * WAD));
    const p = side === "buy"
      ? tokenPreviewBuy(token.address as `0x${string}`, raw)
      : tokenPreviewSell(token.address as `0x${string}`, raw);
    void p.then(([out]) => { if (!cancelled) setQuoteOut(Number(out) / WAD); })
      .catch(() => { if (!cancelled) setQuoteOut(null); });
    return () => { cancelled = true; };
  }, [numeric, side, token.address]);

  // On a graduated token the buy leg is paid in USDG through the pools, not in
  // the fSHARE, so the curve's "you need the fSHARE first" step does not apply.
  const needsFshare =
    !token.graduated && side === "buy" && fshare !== null && numeric > fshare.balance;

  useEffect(() => {
    let cancelled = false;
    if (!needsFshare || !assetId) { setDeskRefusal(null); return; }
    const shortfall = Math.max(0, numeric - (fshare?.balance ?? 0));
    const usdgGuess = BigInt(Math.round(shortfall * (token.market.solUsd || 1) * 1.05 * 1e6));
    if (usdgGuess <= 0n) { setDeskRefusal(null); return; }
    void deskBuyRefusal(assetId, usdgGuess).then((r) => { if (!cancelled) setDeskRefusal(r); });
    return () => { cancelled = true; };
  }, [needsFshare, assetId, numeric, fshare?.balance, token.market.solUsd]);

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: TOKEN_DETAIL_QUERY_KEY(token.address) }),
      queryClient.invalidateQueries({ queryKey: TOKEN_TRADES_QUERY_KEY(token.address) }),
      queryClient.invalidateQueries({ queryKey: TOKEN_HOLDERS_QUERY_KEY(token.address) }),
    ]);
  }, [queryClient, token.address]);

  async function trade() {
    setBusy(true);
    try {
      const account = wallet.getAccount();
      if (wallet.wrongChain) await wallet.switchChain();
      const raw = BigInt(Math.round(numeric * WAD));
      const minOut = quoteOut !== null
        ? BigInt(Math.floor(quoteOut * (1 - slippage) * WAD))
        : 0n;

      if (token.graduated) {
        if (!route) throw new Error("Could not resolve this token's pools.");
        // Buy pays USDG at 6dp; sell pays the token at 18dp.
        const inRaw = side === "buy"
          ? BigInt(Math.round(numeric * 1e6))
          : BigInt(Math.round(numeric * WAD));
        const outScale = side === "buy" ? WAD : 1e6;
        const min = quoteOut !== null
          ? BigInt(Math.floor(quoteOut * (1 - slippage) * outScale))
          : 0n;
        const hash = side === "buy"
          ? await buyGraduated(account, route, inRaw, min)
          : await sellGraduated(account, route, inRaw, min);
        await waitFor(hash);
        toast.success(`${side === "buy" ? "Bought" : "Sold"} ${token.symbol ?? "token"} in its v4 pools.`);
        setAmount("");
        await invalidate();
        await wallet.refreshBalance();
        return;
      }

      if (side === "buy") {
        if (!fshare) throw new Error("Could not resolve the underlying fSHARE.");
        const hash = await tx.tokenBuy(account, token.address as `0x${string}`, raw, minOut, fshare.address);
        await waitFor(hash);
        toast.success(`Bought ${token.symbol ?? "token"}.`);
      } else {
        const hash = await tx.tokenSell(account, token.address as `0x${string}`, raw, minOut);
        await waitFor(hash);
        toast.success(`Sold ${token.symbol ?? "token"}.`);
      }
      setAmount("");
      await invalidate();
    } catch (e) {
      toast.error(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  /** Buy the underlying fSHARE from the Desk so the curve trade can settle. */
  async function getUnderlying() {
    setBusy(true);
    try {
      const account = wallet.getAccount();
      if (wallet.wrongChain) await wallet.switchChain();
      const shortfall = Math.max(0, numeric - (fshare?.balance ?? 0));
      // Size the USDG leg off the Desk's own preview so the spread and impact
      // are priced in, then add a small buffer for the move between quote and fill.
      const usdgGuess = BigInt(Math.round(shortfall * (token.market.solUsd || 1) * 1.05 * 1e6));
      const [baseOut] = await deskPreviewBuy(assetId, usdgGuess);
      const minBase = (baseOut * 99n) / 100n;
      const hash = await tx.deskBuy(account, assetId, usdgGuess, minBase);
      await waitFor(hash);
      toast.success(`Bought ${baseLabel} from the Desk.`);
      await wallet.refreshBalance();
    } catch (e) {
      toast.error(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  // What the input leg actually is, per venue.
  const payLabel = token.graduated ? "USDG" : baseLabel;
  const outLabel = side === "buy" ? token.symbol ?? "tokens" : payLabel;
  const inLabel = side === "buy" ? payLabel : token.symbol ?? "tokens";
  const balance = side === "buy"
    ? (token.graduated ? wallet.balance : fshare?.balance ?? null)
    : holdings;

  return (
    <div className="rounded-[14px] border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-4 flex items-center gap-1 rounded-[10px] bg-[var(--color-bg-page)] p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setSide(s); setAmount(""); }}
            className={`flex-1 rounded-[8px] py-2 text-[14px] font-semibold capitalize transition ${
              side === s ? "bg-[var(--color-text-primary)] text-[var(--color-bg-page)]" : "text-[var(--color-text-secondary)]"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-[13px] text-[var(--color-text-secondary)]">You pay</label>
          <span className="text-[12px] text-[var(--color-text-subtle)]">
            {balance === null ? "-" : `${balance.toFixed(4)} ${inLabel}`}
            {balance !== null && balance > 0 ? (
              <button type="button" className="ml-2 underline" onClick={() => setAmount(String(balance))}>max</button>
            ) : null}
          </span>
        </div>
        <div className="flex items-center gap-2 rounded-[10px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3 py-2.5">
          <input
            className="w-full bg-transparent text-[16px] outline-none"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          />
          <span className="shrink-0 text-[13px] font-semibold">{inLabel}</span>
        </div>
      </div>

      <div className="mb-4 flex items-center justify-between text-[13px]">
        <span className="text-[var(--color-text-secondary)]">You receive</span>
        <span className="font-semibold">
          {quoteOut === null ? "-" : `${quoteOut.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${outLabel}`}
        </span>
      </div>

      <div className="mb-4">
        <button
          type="button"
          onClick={() => setShowSlippage((v) => !v)}
          className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-subtle)]"
        >
          <Gear size={13} /> Slippage {pctLabel(slippage)}
        </button>
        {showSlippage ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {SLIPPAGE_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setSlippage(p)}
                className={`rounded-[7px] border px-2 py-1 text-[12px] ${
                  slippage === p ? "border-[var(--color-text-primary)]" : "border-[var(--color-border-soft)]"
                }`}
              >
                {pctLabel(p)}
              </button>
            ))}
            <input
              className="w-20 rounded-[7px] border border-[var(--color-border-soft)] bg-transparent px-2 py-1 text-[12px] outline-none"
              placeholder="custom %"
              value={customSlippage}
              onChange={(e) => {
                setCustomSlippage(e.target.value);
                const v = Number(e.target.value) / 100;
                if (v >= 0.001 && v <= 0.5) setSlippage(v);
              }}
            />
          </div>
        ) : null}
      </div>

      {!wallet.connected ? (
        <Button className="w-full" onClick={() => void wallet.connect()}>Connect wallet</Button>
      ) : token.graduated && !route ? (
        <div className="rounded-[10px] border border-[var(--color-border-soft)] px-3 py-3 text-[13px] text-[var(--color-text-secondary)]">
          {routeError
            ? `This token has graduated and ${routeError}, so it cannot be traded here.`
            : "Graduated. Finding its pools…"}
        </div>
      ) : needsFshare ? (
        <div className="space-y-2">
          <p className="text-[12px] text-[var(--color-text-secondary)]">
            This curve settles in {baseLabel}, and you hold {(fshare?.balance ?? 0).toFixed(4)}.
            Buy the rest from the Desk first.
          </p>
          {deskRefusal ? (
            <p className="text-[12px] text-[var(--color-accent-strong)]">
              The Desk will not fill that right now: {deskRefusal}.
            </p>
          ) : null}
          <Button
            className="w-full"
            disabled={busy || deskRefusal !== null}
            onClick={getUnderlying}
          >
            {busy ? "Confirming…"
              : deskRefusal ? `${baseLabel} not available`
              : `Buy ${baseLabel} with USDG`}
          </Button>
        </div>
      ) : (
        <Button
          className="w-full"
          disabled={busy || numeric <= 0 || (balance !== null && numeric > balance)}
          onClick={trade}
        >
          {busy ? "Confirming…"
            : wallet.wrongChain ? "Switch network"
            : numeric <= 0 ? "Enter an amount"
            : balance !== null && numeric > balance ? `Not enough ${inLabel}`
            : `${side === "buy" ? "Buy" : "Sell"} ${token.symbol ?? "token"}`}
        </Button>
      )}

      {token.graduated && route ? (
        <p className="mt-2 text-[11px] text-[var(--color-text-subtle)]">
          Filled in this token&apos;s two Uniswap v4 pools, {payLabel} through the
          fSHARE. The quote above is the chain&apos;s own, not an estimate.
        </p>
      ) : null}
    </div>
  );
}

function readableError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/User rejected|denied transaction/i.test(msg)) return "Rejected in wallet.";
  if (/Graduated/.test(msg)) return "This curve has graduated; trade the pool instead.";
  if (/Slippage|minOut/i.test(msg)) return "Price moved past your slippage. Try again.";
  const named = msg.match(/reverted with the following reason:\s*\n?(.+)/);
  return named ? named[1].trim() : msg.split("\n")[0].slice(0, 160);
}
