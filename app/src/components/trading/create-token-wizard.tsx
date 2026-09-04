"use client";

/**
 * Launch a token on Float.
 *
 * The launchpad is not "launch anything". Every token's quote asset is a LIVE
 * fSHARE, so the curve is priced and settled in the equity underneath it and
 * every buy of the token is demand for that stock. TokenLaunchpad._launch
 * reverts UnderlyingNotLive if the market is not open, so the first step is
 * picking from what is actually open rather than a free-text field.
 *
 * Curve parameters are read from the contract, never restated here, so this
 * screen cannot drift from what the chain will actually do.
 */

import localFont from "next/font/local";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, CheckCircle } from "@phosphor-icons/react";
import { useFloatWallet } from "@/components/wallet/float-wallet-provider";
import { usePools, usd, px8, type PoolsResponse } from "@/components/liquidity/use-pools";
import { tx, waitFor, launchpadParams } from "@/lib/float/chain";

const wizSans = localFont({
  src: "../../../83afe278b6a6bb3c-s.p.3a6ba036.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--wiz-sans",
  display: "swap",
});

const HEADING: React.CSSProperties = {
  fontFamily: "var(--wiz-sans)", fontWeight: 600, fontSize: "26px",
  letterSpacing: "-0.26px", lineHeight: "29.9px",
};
const BODY: React.CSSProperties = {
  fontFamily: "var(--wiz-sans)", fontWeight: 400, fontSize: "15px", lineHeight: "18px",
};
const CTA: React.CSSProperties = {
  fontFamily: "var(--wiz-sans)", fontWeight: 600, fontSize: "14px",
};

const FIELD =
  "w-full rounded-[10px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3.5 py-2.5 text-[15px] outline-none placeholder:text-[var(--color-text-subtle)] focus:border-[var(--color-text-primary)]";

type StepKey = "underlying" | "identity" | "review";
const STEPS: StepKey[] = ["underlying", "identity", "review"];
const STEP_LABEL: Record<StepKey, string> = {
  underlying: "Underlying",
  identity: "Identity",
  review: "Review",
};

export function CreateTokenWizard() {
  const router = useRouter();
  const wallet = useFloatWallet();
  const { data, isLoading } = usePools();

  const [step, setStep] = useState<StepKey>("underlying");
  const [underlying, setUnderlying] = useState<`0x${string}` | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useState<Awaited<ReturnType<typeof launchpadParams>> | null>(null);

  useEffect(() => {
    if (data?.venue !== "token-launchpad") return;
    void launchpadParams().then(setParams).catch(() => setParams(null));
  }, [data?.venue]);

  const live = useMemo(
    () => (data?.markets ?? []).filter((m) => m.status === 0),
    [data?.markets],
  );
  const chosen = live.find((m) => m.assetId === underlying) ?? null;
  const identityValid = name.trim().length > 1 && /^[A-Za-z0-9]{2,12}$/.test(symbol.trim());

  async function launch() {
    if (!chosen) return;
    setBusy(true);
    try {
      const account = wallet.getAccount();
      if (wallet.wrongChain) await wallet.switchChain();
      toast.info("Approving the launch fee and creating the token…");
      const hash = await tx.launchToken(account, name.trim(), symbol.trim().toUpperCase(), chosen.assetId, {
        image: image.trim(), website: website.trim(), twitter: twitter.trim(), telegram: telegram.trim(),
      });
      const receipt = await waitFor(hash);
      toast.success(`${symbol.toUpperCase()} launched on f${chosen.ticker}.`);
      // The token address is emitted by the launch; the indexer picks it up
      // within a poll, so send them to the board rather than a 404.
      void receipt;
      router.push("/");
    } catch (e) {
      toast.error(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  if (isLoading || !data) {
    return <Shell><p style={BODY} className="py-24 text-center text-[var(--color-text-secondary)]">Reading open markets…</p></Shell>;
  }

  if (data.venue !== "token-launchpad") {
    return (
      <Shell>
        <Notice
          title="Launching is not wired on this network"
          body={`${data.network.label} runs the CurveFunder venue, whose launch path this app does not build yet. Switch to a TokenLaunchpad deployment to launch a token. Reading and trading still work here.`}
        />
      </Shell>
    );
  }

  if (live.length === 0) {
    return (
      <Shell>
        <Notice
          title="No market is open yet"
          body="Every launch is quoted in a live fSHARE, so at least one equity market has to be open first. Markets open one at a time as the funding queue fills."
          action={{ href: "/liquidity", label: "Fund the queue" }}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <Progress step={step} onJump={setStep} canJump={(s) =>
        s === "underlying" || (s === "identity" ? Boolean(underlying) : Boolean(underlying) && identityValid)} />

      {step === "underlying" ? (
        <UnderlyingStep
          data={data}
          live={live}
          selected={underlying}
          onSelect={(id) => { setUnderlying(id); setStep("identity"); }}
        />
      ) : step === "identity" ? (
        <IdentityStep
          name={name} setName={setName}
          symbol={symbol} setSymbol={setSymbol}
          image={image} setImage={setImage}
          website={website} setWebsite={setWebsite}
          twitter={twitter} setTwitter={setTwitter}
          telegram={telegram} setTelegram={setTelegram}
          ticker={chosen?.ticker ?? ""}
          valid={identityValid}
          onBack={() => setStep("underlying")}
          onContinue={() => setStep("review")}
        />
      ) : (
        <ReviewStep
          data={data}
          market={chosen}
          name={name} symbol={symbol} image={image}
          website={website} twitter={twitter} telegram={telegram}
          params={params}
          wallet={wallet}
          busy={busy}
          onBack={() => setStep("identity")}
          onLaunch={launch}
        />
      )}
    </Shell>
  );
}

/* -------------------------------------------------------------------- chrome */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${wizSans.variable} px-4 py-10 sm:py-14`} style={{ fontFamily: "var(--wiz-sans)" }}>
      {children}
    </div>
  );
}

function Progress({ step, onJump, canJump }: {
  step: StepKey; onJump: (s: StepKey) => void; canJump: (s: StepKey) => boolean;
}) {
  const i = STEPS.indexOf(step);
  return (
    <div className="mx-auto mb-12 flex w-full max-w-[600px] items-center gap-2">
      {STEPS.map((s, idx) => (
        <button
          key={s}
          type="button"
          disabled={!canJump(s)}
          onClick={() => canJump(s) && onJump(s)}
          className="flex-1 text-left disabled:cursor-default"
        >
          <div className={`h-[3px] rounded-full ${idx <= i ? "bg-[var(--color-text-primary)]" : "bg-[var(--color-border-soft)]"}`} />
          <span style={CTA} className={`mt-2 block ${idx <= i ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-subtle)]"}`}>
            {STEP_LABEL[s]}
          </span>
        </button>
      ))}
    </div>
  );
}

function Notice({ title, body, action }: { title: string; body: string; action?: { href: string; label: string } }) {
  return (
    <div className="mx-auto w-full max-w-[600px] text-center">
      <h2 style={HEADING} className="text-[var(--color-text-primary)]">{title}</h2>
      <p style={BODY} className="mt-3 text-[var(--color-text-secondary)]">{body}</p>
      {action ? (
        <Link href={action.href} style={CTA} className="mt-8 inline-block rounded-[10px] bg-[var(--color-text-primary)] px-5 py-3 text-[var(--color-bg-page)]">
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- step one */

function UnderlyingStep({ data, live, selected, onSelect }: {
  data: PoolsResponse;
  live: PoolsResponse["markets"];
  selected: `0x${string}` | null;
  onSelect: (id: `0x${string}`) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[600px]">
      <h2 style={HEADING} className="text-center text-[var(--color-text-primary)]">Pick the underlying</h2>
      <p style={BODY} className="mx-auto mt-3 max-w-[460px] text-center text-[var(--color-text-secondary)]">
        Your token&apos;s whole supply sits on a curve priced and settled in this
        fSHARE, so every buy of your token has to buy the stock first. Only open
        markets can be launched against.
      </p>

      <div className="mt-10 space-y-2">
        {live.map((m) => (
          <button
            key={m.assetId}
            type="button"
            onClick={() => onSelect(m.assetId)}
            className={`flex w-full items-center justify-between rounded-[12px] border px-4 py-4 text-left transition ${
              selected === m.assetId
                ? "border-[var(--color-text-primary)] bg-[var(--color-bg-surface)]"
                : "border-[var(--color-border-soft)] hover:border-[var(--color-text-subtle)]"
            }`}
          >
            <div className="min-w-0">
              <span className="block text-[16px] font-semibold text-[var(--color-text-primary)]">
                f{m.ticker}
              </span>
              <span className="mt-0.5 block truncate text-[13px] text-[var(--color-text-secondary)]">
                {m.displayName}
              </span>
            </div>
            <div className="shrink-0 text-right">
              <span className="block text-[15px] font-semibold text-[var(--color-text-primary)]">
                {usd(px8(m.markPx), { max: 2 })}
              </span>
              <span className="mt-0.5 block text-[12px] text-[var(--color-text-subtle)]">
                {m.marketOpen ? "home market open" : "quoted overnight"}
              </span>
            </div>
          </button>
        ))}
      </div>

      {data.markets.length > live.length ? (
        <p style={BODY} className="mt-6 text-center text-[13px] text-[var(--color-text-subtle)]">
          {data.markets.length - live.length} more market
          {data.markets.length - live.length === 1 ? " is" : "s are"} listed but not open yet.{" "}
          <Link href="/liquidity" className="underline">Fund the queue</Link> to bring the next one forward.
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- step two */

function IdentityStep(props: {
  name: string; setName: (v: string) => void;
  symbol: string; setSymbol: (v: string) => void;
  image: string; setImage: (v: string) => void;
  website: string; setWebsite: (v: string) => void;
  twitter: string; setTwitter: (v: string) => void;
  telegram: string; setTelegram: (v: string) => void;
  ticker: string; valid: boolean;
  onBack: () => void; onContinue: () => void;
}) {
  const {
    name, setName, symbol, setSymbol, image, setImage, website, setWebsite,
    twitter, setTwitter, telegram, setTelegram, ticker, valid, onBack, onContinue,
  } = props;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const display = symbol.trim() ? `$${symbol.trim().toUpperCase()}` : "$TICKER";

  return (
    <div className="mx-auto w-full max-w-[600px]">
      <h2 style={HEADING} className="text-center text-[var(--color-text-primary)]">Name your token</h2>
      <p style={BODY} className="mt-2 text-center text-[var(--color-text-secondary)]">
        Stored on chain with the launch, so the token page reads it from the contract.
      </p>

      <div className="mt-12 flex min-h-[100px] items-center gap-4 rounded-[16px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-5 py-4 shadow-[0_14px_40px_rgba(0,0,0,.18)]">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="h-14 w-14 shrink-0 rounded-full object-cover" />
        ) : (
          <div className="h-14 w-14 shrink-0 rounded-full bg-[radial-gradient(circle_at_32%_28%,#e8e8ec,#71717a_55%,#2a2a30)]" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <span className="block truncate text-[18px] font-bold text-[var(--color-text-primary)]">{display}</span>
          <span className="mt-1 block truncate text-[13px] text-[var(--color-text-secondary)]">
            {name.trim() || "Your token"}
            {ticker ? ` · on f${ticker}` : ""}
          </span>
        </div>
      </div>

      <div className="mt-8 space-y-5">
        <Field label="Ticker" hint="2 to 12 letters or digits">
          <input className={FIELD} value={symbol} maxLength={12} placeholder="TICKER"
            onChange={(e) => setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, ""))} />
        </Field>
        <Field label="Name">
          <input className={FIELD} value={name} placeholder="Token name" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Image URL" hint="ipfs:// or https://. Screeners will not render it, they have no logo standard, but the token page will.">
          <input className={FIELD} value={image} placeholder="ipfs://…" onChange={(e) => setImage(e.target.value)} />
          <input ref={fileRef} type="file" accept="image/*" className="hidden" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Website"><input className={FIELD} value={website} placeholder="https://" onChange={(e) => setWebsite(e.target.value)} /></Field>
          <Field label="X"><input className={FIELD} value={twitter} placeholder="https://x.com/" onChange={(e) => setTwitter(e.target.value)} /></Field>
          <Field label="Telegram"><input className={FIELD} value={telegram} placeholder="https://t.me/" onChange={(e) => setTelegram(e.target.value)} /></Field>
        </div>
      </div>

      <div className="mt-10 flex items-center gap-3">
        <button type="button" onClick={onBack} style={CTA}
          className="flex items-center gap-1.5 rounded-[10px] border border-[var(--color-border-soft)] px-4 py-3 text-[var(--color-text-secondary)]">
          <ArrowLeft size={14} weight="bold" /> Back
        </button>
        <button type="button" onClick={onContinue} disabled={!valid} style={CTA}
          className="flex-1 rounded-[10px] bg-[var(--color-text-primary)] px-5 py-3 text-[var(--color-bg-page)] disabled:opacity-40">
          Continue
        </button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-2 block text-[14px] font-semibold text-[var(--color-text-primary)]">{label}</label>
      {children}
      {hint ? <p className="mt-1.5 text-[12px] text-[var(--color-text-subtle)]">{hint}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------- step three */

function ReviewStep({
  data, market, name, symbol, image, website, twitter, telegram, params, wallet, busy, onBack, onLaunch,
}: {
  data: PoolsResponse;
  market: PoolsResponse["markets"][number] | null;
  name: string; symbol: string; image: string; website: string; twitter: string; telegram: string;
  params: Awaited<ReturnType<typeof launchpadParams>> | null;
  wallet: ReturnType<typeof useFloatWallet>;
  busy: boolean;
  onBack: () => void; onLaunch: () => void;
}) {
  if (!market) return null;
  const dp = data.quote.decimals;
  const fee = params ? Number(params.launchFee) / 10 ** dp : null;
  const short = wallet.balance !== null && fee !== null && wallet.balance < fee;

  const rows: Array<[string, string]> = [
    ["Ticker", `$${symbol.toUpperCase()}`],
    ["Name", name],
    ["Underlying", `f${market.ticker} · ${market.displayName}`],
    ["Quote asset", `f${market.ticker} at ${usd(px8(market.markPx), { max: 2 })}`],
    ...(params ? [
      ["Launch fee", `${fee?.toFixed(2)} ${data.quote.symbol}`] as [string, string],
      ["Trade fee", `${params.feeBps / 100}%, ${params.creatorShareBps / 100}% of it to you`] as [string, string],
      ["Graduates at", `${usd(Number(params.graduationUsd) / 10 ** dp)} of f${market.ticker} raised`] as [string, string],
    ] : []),
    ...(website ? [["Website", website] as [string, string]] : []),
    ...(twitter ? [["X", twitter] as [string, string]] : []),
    ...(telegram ? [["Telegram", telegram] as [string, string]] : []),
  ];

  return (
    <div className="mx-auto w-full max-w-[600px]">
      <h2 style={HEADING} className="text-center text-[var(--color-text-primary)]">Review and launch</h2>
      <p style={BODY} className="mx-auto mt-3 max-w-[460px] text-center text-[var(--color-text-secondary)]">
        These terms come from the launchpad contract, not from this page.
      </p>

      <div className="mt-10 flex items-center gap-4 rounded-[16px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-5 py-4">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="h-12 w-12 shrink-0 rounded-full object-cover" />
        ) : (
          <div className="h-12 w-12 shrink-0 rounded-full bg-[radial-gradient(circle_at_32%_28%,#e8e8ec,#71717a_55%,#2a2a30)]" aria-hidden />
        )}
        <div>
          <span className="block text-[17px] font-bold text-[var(--color-text-primary)]">${symbol.toUpperCase()}</span>
          <span className="text-[13px] text-[var(--color-text-secondary)]">{name}</span>
        </div>
      </div>

      <dl className="mt-6 divide-y divide-[var(--color-border-soft)] rounded-[12px] border border-[var(--color-border-soft)]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-6 px-4 py-3">
            <dt className="text-[13px] text-[var(--color-text-secondary)]">{k}</dt>
            <dd className="min-w-0 truncate text-right text-[13px] font-medium text-[var(--color-text-primary)]">{v}</dd>
          </div>
        ))}
      </dl>

      {short ? (
        <p className="mt-4 text-center text-[13px] text-[var(--color-accent-strong)]">
          You hold {wallet.balance?.toFixed(2)} {data.quote.symbol}, the fee is {fee?.toFixed(2)}.
        </p>
      ) : null}

      <div className="mt-8 flex items-center gap-3">
        <button type="button" onClick={onBack} style={CTA}
          className="flex items-center gap-1.5 rounded-[10px] border border-[var(--color-border-soft)] px-4 py-3 text-[var(--color-text-secondary)]">
          <ArrowLeft size={14} weight="bold" /> Back
        </button>
        {wallet.connected ? (
          <button type="button" onClick={onLaunch} disabled={busy || short} style={CTA}
            className="flex flex-1 items-center justify-center gap-2 rounded-[10px] bg-[var(--color-text-primary)] px-5 py-3 text-[var(--color-bg-page)] disabled:opacity-40">
            {busy ? "Confirming…" : <><CheckCircle size={15} weight="bold" /> Launch ${symbol.toUpperCase()}</>}
          </button>
        ) : (
          <button type="button" onClick={() => void wallet.connect()} style={CTA}
            className="flex-1 rounded-[10px] bg-[var(--color-text-primary)] px-5 py-3 text-[var(--color-bg-page)]">
            Connect wallet
          </button>
        )}
      </div>
    </div>
  );
}

function readableError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/UnderlyingNotLive/.test(msg)) return "That market is not open yet.";
  if (/User rejected|denied transaction/i.test(msg)) return "Rejected in wallet.";
  const named = msg.match(/reverted with the following reason:\s*\n?(.+)/);
  return named ? named[1].trim() : msg.split("\n")[0].slice(0, 160);
}
