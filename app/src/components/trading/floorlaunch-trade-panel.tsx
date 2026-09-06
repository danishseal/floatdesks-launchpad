"use client";

/**
 * Trade panel for a launched token.
 *
 * Three venues meet here and they take different money, which is most of what
 * this file is about:
 *
 *   TokenLaunchpad, live curve   quoted in the token's UNDERLYING fSHARE, so a
 *                                buyer needs that fSHARE first. Rather than
 *                                reverting with an opaque transfer failure, the
 *                                panel reads the balance and offers the missing
 *                                leg: buy the fSHARE from the Desk with USDG,
 *                                then buy the token on its curve.
 *   CurveFunder, live curve      quoted in USDG at 6dp. No fSHARE step at all.
 *   Graduated, either venue      two Uniswap v4 pools, USDG in.
 *
 * On the two USDG venues the pay leg can also be NATIVE ETH. The curve cannot
 * take ETH (it pulls USDG with `transferFrom`, and native ETH has no allowance
 * to pull), so that route is two transactions with a state in between, and the
 * half-done state is handled here rather than swallowed: see lib/float/eth-buy.ts.
 *
 * The SELL leg on the CurveFunder venue is deliberately left as it was found.
 * That venue's `sell` pays out in the fSHARE and `sellToUsdg` in dollars, which
 * is a UX decision about what "You receive" means, not part of the buy flow.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatUnits, parseUnits } from "viem";
import { ArrowSquareOut, Gear, WarningCircle } from "@phosphor-icons/react";
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
import { cfPreviewBuy, cfTx } from "@/lib/float/curve-funder";
import { activeNetwork } from "@/lib/float/networks";
import { readableError } from "@/lib/float/errors";
import {
  routeFor, quoteGraduated, buyGraduated, sellGraduated, type SwapRoute,
} from "@/lib/float/v4-router";
import {
  planEthBuy, runEthBuy, resumeEthBuy, ethSwapperAddress, usdgToken,
  saveStranded, loadStranded, clearStranded,
  type BuyLeg, type EthBuyPlan, type EthBuyStep, type StrandedBuy,
} from "@/lib/float/eth-buy";

const DEFAULT_SLIPPAGE = 0.02;
const SLIPPAGE_PRESETS = [0.005, 0.01, 0.02, 0.05];
const WAD = 1e18;

/**
 * ETH held back from the max button so the two transactions this route needs
 * can still be paid for. Gas here is fractions of a gwei, so this is roughly
 * three times what the whole route costs.
 */
const GAS_RESERVE_ETH = 0.001;

function pctLabel(frac: number): string {
  return `${Number((frac * 100).toFixed(3))}%`;
}

/**
 * Text to raw units without going through a float.
 *
 * `Math.round(x * 1e18)` is exact only below 2^53, so it silently rounds every
 * ETH amount above about 0.009 to something the user did not type. parseUnits
 * works on the digits. The fallback covers a value that arrived as a number and
 * came back in exponent form, which parseUnits refuses.
 */
function parseAmount(text: string, decimals: number): bigint | null {
  const s = text.trim();
  if (!s || s === ".") return null;
  if (/^\d*\.?\d*$/.test(s)) {
    try {
      const v = parseUnits(s, decimals);
      return v > 0n ? v : null;
    } catch {
      /* fall through */
    }
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * 10 ** decimals));
}

/**
 * Amounts at a precision worth reading. A curve buy returns hundreds of
 * millions of tokens, and six decimals on that is nine digits of noise sitting
 * where the eye looks for the magnitude.
 */
function fmtAmount(n: number): string {
  if (!Number.isFinite(n)) return "-";
  const max = n >= 1000 ? 2 : n >= 1 ? 4 : 8;
  return n.toLocaleString(undefined, { maximumFractionDigits: max });
}

function fmtUnits(raw: bigint, decimals: number): string {
  return fmtAmount(Number(formatUnits(raw, decimals)));
}

export function FloorlaunchTradePanel({ token }: { token: TokenListItem }) {
  const wallet = useFloatWallet();
  const queryClient = useQueryClient();
  const net = activeNetwork();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [payWith, setPayWith] = useState<"quote" | "eth">("quote");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<EthBuyStep | null>(null);
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
  // 6 everywhere on this chain, but read rather than assumed: defaulting the
  // decimals of a 6dp dollar to 18 is a silent 1e12 error in every number
  // derived from it, and this app has paid for that once already.
  const [usdgDecimals, setUsdgDecimals] = useState(6);
  const [swapperReady, setSwapperReady] = useState(false);
  const [ethPlan, setEthPlan] = useState<EthBuyPlan | null>(null);
  const [ethPlanError, setEthPlanError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [stranded, setStranded] = useState<StrandedBuy | null>(null);

  const assetId = token.base_denom as `0x${string}`;
  const baseLabel = token.base_label || "fSHARE";
  const symbol = token.symbol || "tokens";
  const numeric = Number(amount) || 0;

  /**
   * Which asset the buy leg is paid in. The CurveFunder venue quotes its curve
   * in USDG, so a token from it needs no fSHARE at any point; a live
   * TokenLaunchpad curve still does.
   */
  const curveVenue = token.source.startsWith("curve-funder");
  const payKind: "usdg" | "fshare" = token.graduated || curveVenue ? "usdg" : "fshare";
  const payDecimals = payKind === "usdg" ? usdgDecimals : 18;

  /**
   * ETH is offered only where hop two takes USDG. A live TokenLaunchpad curve
   * wants its underlying fSHARE, which would make this a three-hop route
   * through the Desk, so the option is absent there rather than half-built.
   */
  const ethOffered =
    side === "buy" && payKind === "usdg" && swapperReady && (!token.graduated || route !== null);
  const payingEth = ethOffered && payWith === "eth";

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

  // Is there an ETH route on this chain at all, and what is a dollar worth of
  // raw units? Both are chain facts, read once.
  useEffect(() => {
    let cancelled = false;
    void ethSwapperAddress().then((a) => { if (!cancelled) setSwapperReady(a !== null); })
      .catch(() => { if (!cancelled) setSwapperReady(false); });
    void usdgToken().then(({ decimals }) => { if (!cancelled) setUsdgDecimals(decimals); })
      .catch(() => { /* keep the 6dp default */ });
    return () => { cancelled = true; };
  }, [net.chainId]);

  // A buy that stopped between its two halves, remembered across reloads.
  useEffect(() => {
    if (!wallet.address) { setStranded(null); return; }
    setStranded(loadStranded(net.chainId, wallet.address, token.address));
  }, [wallet.address, token.address, net.chainId]);

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

  /**
   * Live quote off whichever venue actually holds this token: the CurveFunder
   * preview in dollars, the TokenLaunchpad preview in its fSHARE, or the v4
   * quoter once the curve is spent. The ETH leg is priced separately, below,
   * because it is two hops and the second one needs the first one's output.
   */
  useEffect(() => {
    let cancelled = false;
    if (payingEth) return;
    const raw = parseAmount(amount, side === "buy" ? payDecimals : 18);
    if (raw === null) { setQuoteOut(null); return; }

    const done = (out: bigint | null, scale: number) => {
      if (!cancelled) setQuoteOut(out === null ? null : Number(out) / scale);
    };
    const fail = () => { if (!cancelled) setQuoteOut(null); };

    if (token.graduated) {
      if (!route) { setQuoteOut(null); return; }
      // Buys are priced in USDG on the pool route; sells are token in.
      void quoteGraduated(route, raw, side)
        .then((out) => done(out, side === "buy" ? WAD : 10 ** usdgDecimals))
        .catch(fail);
      return () => { cancelled = true; };
    }

    if (side === "buy" && curveVenue) {
      void cfPreviewBuy(token.address as `0x${string}`, raw)
        .then(([out]) => done(out, WAD)).catch(fail);
      return () => { cancelled = true; };
    }

    const p = side === "buy"
      ? tokenPreviewBuy(token.address as `0x${string}`, raw)
      : tokenPreviewSell(token.address as `0x${string}`, raw);
    void p.then(([out]) => done(out, WAD)).catch(fail);
    return () => { cancelled = true; };
  }, [amount, side, payingEth, payDecimals, usdgDecimals, curveVenue, token.address, token.graduated, route]);

  /**
   * The ETH route, priced end to end. Debounced, because it is six or seven
   * chain reads per keystroke: five candidate pools, a reference trade in the
   * winner, and the second hop at both the quoted and the floor amount.
   */
  useEffect(() => {
    let cancelled = false;
    if (!payingEth) { setEthPlan(null); setEthPlanError(null); setPlanning(false); return; }
    const ethIn = parseAmount(amount, 18);
    if (ethIn === null) { setEthPlan(null); setEthPlanError(null); setPlanning(false); return; }
    setPlanning(true);
    const timer = setTimeout(() => {
      void planEthBuy({
        token: token.address as `0x${string}`,
        underlying: assetId,
        ethIn,
        slippage,
        route: token.graduated ? route : null,
      })
        .then((p) => { if (!cancelled) { setEthPlan(p); setEthPlanError(null); } })
        .catch((e) => { if (!cancelled) { setEthPlan(null); setEthPlanError(readableError(e)); } })
        .finally(() => { if (!cancelled) setPlanning(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [payingEth, amount, slippage, assetId, token.address, token.graduated, route]);

  // On a graduated token, and on the CurveFunder venue, the buy leg is paid in
  // USDG, so the curve's "you need the fSHARE first" step does not apply.
  const needsFshare =
    payKind === "fshare" && side === "buy" && fshare !== null && numeric > fshare.balance;

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

  /** Hop two as the ETH route and the recovery path both need it. */
  const buyLeg = useMemo<BuyLeg>(
    () => (token.graduated && route
      ? { kind: "pool", route }
      : { kind: "curve", token: token.address as `0x${string}` }),
    [token.graduated, route, token.address],
  );

  async function trade() {
    setBusy(true);
    try {
      const account = wallet.getAccount();
      if (wallet.wrongChain) await wallet.switchChain();
      const raw = parseAmount(amount, side === "buy" ? payDecimals : 18);
      if (raw === null) throw new Error("Enter an amount above zero.");
      // No quote, no trade. This used to fall back to a minimum of zero, which
      // is not a slippage setting, it is the absence of one: the case where the
      // quote failed is exactly the case where the venue is behaving oddly.
      if (quoteOut === null) {
        throw new Error("No quote for that amount yet. Try again in a moment.");
      }
      const outScale = side === "buy" ? WAD : (token.graduated ? 10 ** usdgDecimals : WAD);
      const minOut = BigInt(Math.floor(quoteOut * (1 - slippage) * outScale));

      if (token.graduated) {
        if (!route) throw new Error("Could not resolve this token's pools.");
        const hash = side === "buy"
          ? await buyGraduated(account, route, raw, minOut)
          : await sellGraduated(account, route, raw, minOut);
        await waitFor(hash);
        toast.success(`${side === "buy" ? "Bought" : "Sold"} ${symbol} in its v4 pools.`);
        setAmount("");
        await invalidate();
        await wallet.refreshBalance();
        return;
      }

      if (side === "buy") {
        if (curveVenue) {
          const hash = await cfTx.buy(account, token.address as `0x${string}`, raw, minOut);
          await waitFor(hash);
        } else {
          if (!fshare) throw new Error("Could not resolve the underlying fSHARE.");
          const hash = await tx.tokenBuy(account, token.address as `0x${string}`, raw, minOut, fshare.address);
          await waitFor(hash);
        }
        toast.success(`Bought ${symbol}.`);
      } else {
        const hash = await tx.tokenSell(account, token.address as `0x${string}`, raw, minOut);
        await waitFor(hash);
        toast.success(`Sold ${symbol}.`);
      }
      setAmount("");
      await invalidate();
      await wallet.refreshBalance();
    } catch (e) {
      toast.error(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The ETH route. Two transactions, so there is a state between them, and it
   * is reported rather than thrown away: an outcome of "stranded" means the
   * swap happened and the buy did not, and the buyer is holding USDG.
   */
  async function buyWithEth() {
    if (!ethPlan) return;
    setBusy(true);
    try {
      const account = wallet.getAccount();
      if (wallet.wrongChain) await wallet.switchChain();
      const outcome = await runEthBuy(account, ethPlan, setStep);

      if (outcome.kind === "filled") {
        clearStranded(net.chainId, account, token.address);
        setStranded(null);
        toast.success(
          `Bought ${fmtUnits(outcome.tokensOut, 18)} ${symbol} for ${fmtUnits(outcome.usdgIn, usdgDecimals)} USDG of ETH.`,
        );
        setAmount("");
        await invalidate();
      } else {
        const record: StrandedBuy = {
          chainId: net.chainId,
          account,
          token: token.address,
          symbol,
          usdg: outcome.usdgIn.toString(),
          usdgDecimals,
          swapHash: outcome.swapHash,
          reason: outcome.reason,
          at: Date.now(),
        };
        saveStranded(record);
        setStranded(record);
        toast.error(`Your ETH became USDG, but the ${symbol} buy did not run. Read the panel.`);
      }
      await wallet.refreshBalance();
    } catch (e) {
      // Hop one itself failed, so nothing moved.
      toast.error(readableError(e));
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  /** Finish a stranded buy out of the USDG already in the wallet. No ETH. */
  async function finishStranded() {
    if (!stranded) return;
    setBusy(true);
    try {
      const account = wallet.getAccount();
      if (wallet.wrongChain) await wallet.switchChain();
      const done = await resumeEthBuy(account, buyLeg, BigInt(stranded.usdg), slippage);
      clearStranded(net.chainId, account, token.address);
      setStranded(null);
      toast.success(`Bought ${fmtUnits(done.tokensOut, 18)} ${symbol}. That buy is finished.`);
      await invalidate();
      await wallet.refreshBalance();
    } catch (e) {
      // Still stranded, with a fresher reason than last time.
      const next = { ...stranded, reason: readableError(e), at: Date.now() };
      saveStranded(next);
      setStranded(next);
      toast.error(next.reason);
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
  const quoteLabel = payKind === "usdg" ? "USDG" : baseLabel;
  const payLabel = payingEth ? "ETH" : quoteLabel;
  const outLabel = side === "buy" ? symbol : quoteLabel;
  const inLabel = side === "buy" ? payLabel : symbol;
  const quoteBalance = payKind === "usdg" ? wallet.balance : fshare?.balance ?? null;
  const balance = side === "buy"
    ? (payingEth ? wallet.nativeBalance : quoteBalance)
    : holdings;
  // Leave enough ETH behind to pay for the two transactions this route needs.
  const maxAmount = payingEth && balance !== null
    ? Math.max(0, balance - GAS_RESERVE_ETH)
    : balance;

  const strandedUsdg = stranded ? BigInt(stranded.usdg) : 0n;
  const shownOut = payingEth
    ? (ethPlan ? Number(formatUnits(ethPlan.tokensOut, 18)) : null)
    : quoteOut;
  const ethBlocked = payingEth ? ethPlan?.blocked ?? null : null;

  /**
   * How far the price this trade actually gets is from the current price.
   *
   * Taken from the quote already in hand rather than a second read: the
   * effective price is what you pay divided by what you receive, and spot is
   * the venue's marginal price, so their ratio IS the slippage. On a constant
   * product curve it works out to exactly the trade size over the quote
   * reserve, which is why $100 into a $876 virtual reserve costs 11% and no
   * amount of UI softens it. The panel showed this for the ETH hop only, so a
   * buyer moving the price a quarter was told nothing at all.
   *
   * Shown only where BOTH legs are dollars. On the TokenLaunchpad venue the
   * quote is denominated in the fSHARE, and dividing that by a USD spot would
   * print a confident number about nothing.
   */
  const spotUsd = (Number(token.current_price || 0) / 1e6) * (token.market.solUsd || 1);
  const usdLeg = payingEth
    ? (ethPlan ? Number(formatUnits(ethPlan.hop1.usdgOut, ethPlan.hop1.usdgDecimals)) : null)
    : numeric;
  const priceImpact = (() => {
    if (!curveVenue && !token.graduated) return null;
    if (!spotUsd || spotUsd <= 0) return null;
    if (shownOut === null || shownOut <= 0) return null;
    if (side === "buy") {
      if (!usdLeg || usdLeg <= 0) return null;
      return (usdLeg / shownOut) / spotUsd - 1;
    }
    if (numeric <= 0) return null;
    return 1 - (shownOut / numeric) / spotUsd;
  })();

  return (
    <div className="rounded-[14px] border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-4 flex items-center gap-1 rounded-[10px] bg-[var(--color-bg-page)] p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setSide(s); setAmount(""); if (s === "sell") setPayWith("quote"); }}
            className={`flex-1 rounded-[8px] py-2 text-[14px] font-semibold capitalize transition ${
              side === s ? "bg-[var(--color-text-primary)] text-[var(--color-bg-page)]" : "text-[var(--color-text-secondary)]"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {stranded ? (
        <div className="mb-4 rounded-[10px] border border-[var(--color-negative)] bg-[var(--color-negative-soft)] p-3">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-negative)]">
            <WarningCircle size={15} weight="fill" />
            Half of this buy went through
          </p>
          {strandedUsdg > 0n ? (
            <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
              Your ETH was swapped and{" "}
              <strong className="font-semibold text-[var(--color-text-primary)]">
                {fmtUnits(strandedUsdg, stranded.usdgDecimals)} USDG
              </strong>{" "}
              is sitting in your wallet now. The {stranded.symbol} buy never ran, so no{" "}
              {stranded.symbol} was bought and nothing beyond that swap was taken from you.
            </p>
          ) : (
            <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
              Your ETH was swapped, but the swap reported no USDG arriving, so the{" "}
              {stranded.symbol} buy was not attempted. Open the transaction below and check
              where that ETH went before trying again.
            </p>
          )}
          {/* The reason is printed verbatim rather than folded into a sentence:
              it comes from readableError, which returns whole sentences, and
              splicing one mid-clause reads as a bug of its own. */}
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
            <span className="text-[var(--color-text-subtle)]">Why it stopped: </span>
            {stranded.reason}
          </p>
          <a
            className="mt-2 inline-flex items-center gap-1 text-[12px] text-[var(--color-accent-strong)] underline"
            href={`${net.explorer}/tx/${stranded.swapHash}`}
            target="_blank"
            rel="noreferrer"
          >
            The swap on the explorer <ArrowSquareOut size={12} />
          </a>
          <div className="mt-3 flex flex-wrap gap-2">
            {strandedUsdg > 0n ? (
              <Button size="sm" disabled={busy} onClick={finishStranded}>
                {busy
                  ? "Confirming…"
                  : `Finish with that ${fmtUnits(strandedUsdg, stranded.usdgDecimals)} USDG`}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                if (wallet.address) clearStranded(net.chainId, wallet.address, token.address);
                setStranded(null);
              }}
            >
              {strandedUsdg > 0n ? "Keep the USDG" : "Dismiss"}
            </Button>
          </div>
        </div>
      ) : null}

      {ethOffered ? (
        <div className="mb-3">
          <div className="mb-1.5 text-[13px] text-[var(--color-text-secondary)]">Pay with</div>
          <div className="flex items-center gap-1 rounded-[10px] bg-[var(--color-bg-page)] p-1">
            {([
              { key: "quote" as const, label: quoteLabel },
              { key: "eth" as const, label: "ETH" },
            ]).map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => { setPayWith(o.key); setAmount(""); }}
                className={`flex-1 rounded-[8px] py-1.5 text-[13px] font-semibold transition ${
                  payWith === o.key
                    ? "bg-[var(--color-bg-surface)] text-[var(--color-text-primary)] shadow-sm"
                    : "text-[var(--color-text-secondary)]"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-[13px] text-[var(--color-text-secondary)]">You pay</label>
          <span className="text-[12px] text-[var(--color-text-subtle)]">
            {balance === null ? "-" : `${balance.toFixed(4)} ${inLabel}`}
            {maxAmount !== null && maxAmount > 0 ? (
              <button type="button" className="ml-2 underline" onClick={() => setAmount(String(maxAmount))}>max</button>
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
          {shownOut === null
            ? (payingEth && planning ? "Pricing…" : "-")
            : `${fmtAmount(shownOut)} ${outLabel}`}
        </span>
      </div>

      {priceImpact !== null && Number.isFinite(priceImpact) ? (
        <div className="mb-4 flex items-center justify-between text-[12px]">
          <span className="text-[var(--color-text-secondary)]">Price impact</span>
          <span
            className={
              priceImpact >= 0.05
                ? "font-semibold text-[var(--color-negative)]"
                : "font-semibold text-[var(--color-text-primary)]"
            }
          >
            {priceImpact < 0 && priceImpact > -0.0001 ? "0.00%" : `${(priceImpact * 100).toFixed(2)}%`}
          </span>
        </div>
      ) : null}

      {payingEth && ethPlan ? (
        <div className="mb-4 rounded-[10px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3 py-2.5 text-[12px]">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[var(--color-text-secondary)]">1. ETH to USDG, in a v4 pool</span>
            <span className="shrink-0 font-semibold">
              {fmtUnits(ethPlan.hop1.usdgOut, ethPlan.hop1.usdgDecimals)} USDG
            </span>
          </div>
          <p className="mt-1 text-[11px] text-[var(--color-text-subtle)]">
            {fmtAmount(ethPlan.hop1.rate)} per ETH
            {" · "}{pctLabel(ethPlan.hop1.fee / 1_000_000)} pool fee
            {" · "}
            {ethPlan.hop1.priceImpact === null
              ? "impact not measurable"
              : `${pctLabel(ethPlan.hop1.priceImpact)} impact`}
          </p>

          <div className="mt-2.5 flex items-baseline justify-between gap-3 border-t border-[var(--color-border-soft)] pt-2.5">
            <span className="text-[var(--color-text-secondary)]">
              2. USDG to {symbol}, {ethPlan.hop2.kind === "curve" ? "on the curve" : "in its two pools"}
            </span>
            <span className="shrink-0 font-semibold">{fmtUnits(ethPlan.tokensOut, 18)}</span>
          </div>
          {ethPlan.curveFeeUsdg !== null && ethPlan.curveFeeUsdg > 0n ? (
            <p className="mt-1 text-[11px] text-[var(--color-text-subtle)]">
              {fmtUnits(ethPlan.curveFeeUsdg, ethPlan.hop1.usdgDecimals)} USDG curve fee
            </p>
          ) : null}

          <div className="mt-2.5 flex items-baseline justify-between gap-3 border-t border-[var(--color-border-soft)] pt-2.5">
            <span className="text-[var(--color-text-secondary)]">You receive at least</span>
            <span className="shrink-0 font-semibold">
              {fmtUnits(ethPlan.minTokensOut, 18)} {symbol}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-[var(--color-text-subtle)]">
            {pctLabel(slippage)} slippage on each hop, floors signed into both
          </p>

          <p className="mt-2.5 border-t border-[var(--color-border-soft)] pt-2.5 text-[11px] leading-relaxed text-[var(--color-text-subtle)]">
            {ethPlan.hop2.kind === "curve"
              ? "The curve only takes dollars, so this is two transactions and your wallet asks twice."
              : "These pools are priced in dollars, so this is two transactions and your wallet asks twice."}
            {" "}
            If the swap goes through and the buy does not, you keep the USDG and this panel
            says so.
          </p>
        </div>
      ) : null}

      {payingEth && ethPlanError ? (
        <p className="mb-4 text-[12px] text-[var(--color-negative)]">{ethPlanError}</p>
      ) : null}

      {ethBlocked ? (
        <p className="mb-4 text-[12px] leading-relaxed text-[var(--color-negative)]">
          The second half would be refused right now: {ethBlocked.replace(/\.$/, "")}. Your ETH
          stays where it is until that clears.
        </p>
      ) : null}

      <div className="mb-4">
        <button
          type="button"
          onClick={() => setShowSlippage((v) => !v)}
          className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-subtle)]"
        >
          <Gear size={13} /> Slippage {pctLabel(slippage)}{payingEth ? " per hop" : ""}
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
      ) : payingEth ? (
        <Button
          className="w-full"
          disabled={
            busy || planning || !ethPlan || ethBlocked !== null
            || numeric <= 0 || (balance !== null && numeric > balance)
          }
          onClick={buyWithEth}
        >
          {/* Reasons that DISABLE the button come before the wrong-chain
              prompt: a disabled button reading "Switch network" tells someone
              to do the one thing it will not let them do. */}
          {step === "swapping" ? "1 of 2: swapping ETH…"
            : step === "buying" ? `2 of 2: buying ${symbol}…`
            : busy ? "Confirming…"
            : numeric <= 0 ? "Enter an amount"
            : balance !== null && numeric > balance ? "Not enough ETH"
            : planning ? "Pricing…"
            : ethBlocked ? `${symbol} cannot be bought right now`
            : !ethPlan ? "No route for that amount"
            : wallet.wrongChain ? "Switch network"
            : `Buy ${symbol} with ETH`}
        </Button>
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
            : `${side === "buy" ? "Buy" : "Sell"} ${symbol}`}
        </Button>
      )}

      {token.graduated && route && !payingEth ? (
        <p className="mt-2 text-[11px] text-[var(--color-text-subtle)]">
          Filled in this token&apos;s two Uniswap v4 pools, {quoteLabel} through the
          fSHARE. The quote above is the chain&apos;s own, not an estimate.
        </p>
      ) : null}
    </div>
  );
}
