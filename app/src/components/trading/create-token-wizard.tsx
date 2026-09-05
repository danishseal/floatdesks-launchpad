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
import { readableError } from "@/lib/float/errors";
import { cfTx, cfLaunchParams, tokenMetaOwner, setTokenMeta } from "@/lib/float/curve-funder";

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

/** What a launcher needs to see, in one shape for both venues. */
interface LaunchParams {
  launchFee: bigint;
  /** Only CurveFunder can list a new stock, so only it charges a list fee. */
  listFee: bigint | null;
  feeBps: number;
  creatorShareBps: number;
  graduationLabel: string;
}

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
  const [params, setParams] = useState<LaunchParams | null>(null);
  const [paramsError, setParamsError] = useState<string | null>(null);
  // TokenMetadata.setUri is onlyOwner, so whether THIS wallet can attach an
  // image and links is a fact about the deployment, not a preference.
  const [metaOwner, setMetaOwner] = useState<string | null>(null);
  const [metaChecked, setMetaChecked] = useState(false);

  useEffect(() => {
    if (data?.venue !== "curve-funder") return;
    void tokenMetaOwner()
      .then((o) => { setMetaOwner(o); setMetaChecked(true); })
      .catch(() => setMetaChecked(true));
  }, [data?.venue]);

  useEffect(() => {
    if (!data?.venue) return;
    void (async () => {
      try {
        if (data.venue === "curve-funder") {
          const p = await cfLaunchParams();
          setParams({
            launchFee: p.launchFee, listFee: p.listFee, feeBps: p.feeBps,
            creatorShareBps: p.creatorShareBps,
            graduationLabel: "the raise target set for that stock",
          });
        } else {
          const p = await launchpadParams();
          setParams({
            launchFee: p.launchFee, listFee: null, feeBps: p.feeBps,
            creatorShareBps: p.creatorShareBps,
            graduationLabel: `${usd(Number(p.graduationUsd) / 1e6)} of the underlying raised`,
          });
        }
      } catch (e) {
        // Swallowing this printed a review screen with no fee, no trade fee and
        // no graduation target, which reads as "this launch is free".
        setParams(null);
        setParamsError(e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : String(e));
      }
    })();
  }, [data?.venue]);

  // TokenLaunchpad reverts UnderlyingNotLive on anything but an open market.
  // CurveFunder accepts a HALTED one, which goes Live on the first buy, so on
  // that venue every listing is launchable and restricting to open markets
  // would hide most of them for no reason.
  const curveFunder = data?.venue === "curve-funder";
  const live = useMemo(
    () => (data?.markets ?? []).filter((m) => (curveFunder ? true : m.status === 0)),
    [data?.markets, curveFunder],
  );
  const chosen = live.find((m) => m.assetId === underlying) ?? null;

  // What actually happens to the image and links, stated per deployment.
  const canSetMeta =
    data?.venue !== "curve-funder" ||
    (metaOwner !== null && wallet.address?.toLowerCase() === metaOwner.toLowerCase());
  const metaNote =
    data?.venue !== "curve-funder"
      ? null
      : canSetMeta
        ? "Stored in this deployment's TokenMetadata contract as a second transaction right after the launch."
        : metaOwner
          ? `On this deployment only ${metaOwner.slice(0, 8)}… can write token metadata, so these are saved with the launch for that admin to set rather than written by you.`
          : metaChecked
            ? "This deployment has no metadata contract, so these cannot be stored on chain."
            : "Checking where this deployment stores token metadata…";
  const identityValid = name.trim().length > 1 && /^[A-Za-z0-9]{2,12}$/.test(symbol.trim());

  async function launch() {
    if (!chosen || !data) return;
    setBusy(true);
    try {
      const account = wallet.getAccount();
      if (wallet.wrongChain) await wallet.switchChain();
      toast.info("Approving the launch fee and creating the token…");
      // Both venues launch; they differ in what the curve settles in and
      // whether on-chain metadata exists. CurveFunder stores no TokenMeta, so
      // image and socials are dropped there rather than silently discarded.
      const hash = data.venue === "curve-funder"
        ? await cfTx.launchToken(account, name.trim(), symbol.trim().toUpperCase(), chosen.assetId)
        : await tx.launchToken(account, name.trim(), symbol.trim().toUpperCase(), chosen.assetId, {
            image: image.trim(), website: website.trim(), twitter: twitter.trim(), telegram: telegram.trim(),
          });
      const receipt = await waitFor(hash);
      toast.success(`${symbol.toUpperCase()} launched on f${chosen.ticker}.`);

      // CurveFunder's token carries no image or links, so attach them in a
      // second transaction against TokenMetadata. Only its owner may write, so
      // this runs only when the connected wallet is that owner; everyone else
      // was told on the previous step rather than finding out here.
      const wantsMeta = image.trim() || website.trim() || twitter.trim() || telegram.trim();
      if (data.venue === "curve-funder" && canSetMeta && wantsMeta) {
        try {
          const launchedAddr = await newTokenAddress(receipt);
          if (launchedAddr) {
            toast.info("Attaching image and links…");
            await waitFor(await setTokenMeta(account, launchedAddr, {
              name: name.trim(), symbol: symbol.trim().toUpperCase(),
              image: image.trim() || undefined, website: website.trim() || undefined,
              twitter: twitter.trim() || undefined, telegram: telegram.trim() || undefined,
            }));
            toast.success("Metadata attached.");
          }
        } catch (e) {
          // The launch already landed. Say what did and did not happen rather
          // than letting a metadata failure read as a failed launch.
          toast.error(`Launched, but the metadata did not attach: ${readableError(e)}`);
        }
      }
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

  if (data.venue !== "token-launchpad" && data.venue !== "curve-funder") {
    return (
      <Shell>
        <Notice
          title="No launch venue on this network"
          body={`The registry at ${data.network.registry.slice(0, 10)}… names neither a TokenLaunchpad nor a CurveFunder, so there is nothing here to launch against.`}
        />
      </Shell>
    );
  }

  if (live.length === 0) {
    // An empty list is not automatically "there are none". If the markets could
    // not be read, saying "no market is open yet" states as fact something we
    // never learned, and sends someone to fund a queue that may not need it.
    const unreadable = data.unreadable?.length ?? 0;
    return (
      <Shell>
        {unreadable > 0 ? (
          <Notice
            title="Markets could not be read"
            body={`${unreadable} market${unreadable === 1 ? "" : "s"} on this deployment failed to read, so there is nothing to launch against right now. This is a read failure, not an empty chain. Reload in a moment.`}
          />
        ) : (
          <Notice
            title="No market is open yet"
            body="Every launch is quoted in a live fSHARE, so at least one equity market has to be open first. Markets open one at a time as the funding queue fills."
            action={{ href: "/liquidity", label: "Fund the queue" }}
          />
        )}
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
          storesMetadata
          metaNote={metaNote}
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
          paramsError={paramsError}
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
        {data.venue === "curve-funder" ? (
          <>
            Your token&apos;s whole supply sits on a curve quoted in{" "}
            {data.quote.symbol}, and every buy funds this stock&apos;s vault, so the
            raise IS the underlying. A halted market is fine: it goes live on the
            first buy.
          </>
        ) : (
          <>
            Your token&apos;s whole supply sits on a curve priced and settled in this
            fSHARE, so every buy of your token has to buy the stock first. Only open
            markets can be launched against.
          </>
        )}
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
                {m.status !== 0
                  ? "halted, opens on the first buy"
                  : m.marketOpen ? "home market open" : "quoted overnight"}
              </span>
            </div>
          </button>
        ))}
      </div>

      {data.venue !== "curve-funder" && data.markets.length > live.length ? (
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
  storesMetadata: boolean;
  /** Says where these end up, since it differs per deployment. */
  metaNote: string | null;
  onBack: () => void; onContinue: () => void;
}) {
  const {
    name, setName, symbol, setSymbol, image, setImage, website, setWebsite,
    twitter, setTwitter, telegram, setTelegram, ticker, valid, storesMetadata,
    metaNote, onBack, onContinue,
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
        {storesMetadata ? (
          <>
            <Field label="Image URL" hint="ipfs:// or https://. Screeners will not render it, they have no logo standard, but the token page will.">
              <input className={FIELD} value={image} placeholder="ipfs://…" onChange={(e) => setImage(e.target.value)} />
              <input ref={fileRef} type="file" accept="image/*" className="hidden" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Website"><input className={FIELD} value={website} placeholder="https://" onChange={(e) => setWebsite(e.target.value)} /></Field>
              <Field label="X"><input className={FIELD} value={twitter} placeholder="https://x.com/" onChange={(e) => setTwitter(e.target.value)} /></Field>
              <Field label="Telegram"><input className={FIELD} value={telegram} placeholder="https://t.me/" onChange={(e) => setTelegram(e.target.value)} /></Field>
            </div>
          </>
        ) : null}
        {metaNote ? (
          <p className="text-[12px] text-[var(--color-text-subtle)]">{metaNote}</p>
        ) : null}
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
  data, market, name, symbol, image, website, twitter, telegram, params, paramsError, wallet, busy, onBack, onLaunch,
}: {
  data: PoolsResponse;
  market: PoolsResponse["markets"][number] | null;
  name: string; symbol: string; image: string; website: string; twitter: string; telegram: string;
  params: LaunchParams | null;
  paramsError: string | null;
  wallet: ReturnType<typeof useFloatWallet>;
  busy: boolean;
  onBack: () => void; onLaunch: () => void;
}) {
  if (!market) return null;
  const dp = data.quote.decimals;
  const fee = params ? Number(params.launchFee) / 10 ** dp : null;
  const short = wallet.balance !== null && fee !== null && wallet.balance < fee;

  // The quote asset is the venue's, not an assumption: CurveFunder settles the
  // curve in USDG, TokenLaunchpad in the underlying fSHARE.
  const curveFunder = data.venue === "curve-funder";
  const quoteAsset = curveFunder
    ? `${data.quote.symbol}, so buyers need no f${market.ticker} first`
    : `f${market.ticker} at ${usd(px8(market.markPx), { max: 2 })}`;

  const rows: Array<[string, string]> = [
    ["Ticker", `$${symbol.toUpperCase()}`],
    ["Name", name],
    ["Underlying", `f${market.ticker} · ${market.displayName}`],
    ["Quote asset", quoteAsset],
    ...(market.status !== 0 && curveFunder
      ? [["Market status", "halted, and goes live on the first buy"] as [string, string]]
      : []),
    ...(params ? [
      ["Launch fee", `${fee?.toFixed(2)} ${data.quote.symbol}`] as [string, string],
      ["Trade fee", `${params.feeBps / 100}%, ${params.creatorShareBps / 100}% of it to you`] as [string, string],
      ["Graduates at", params.graduationLabel] as [string, string],
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

      {paramsError ? (
        <p className="mt-4 text-center text-[13px] text-[var(--color-accent-strong)]">
          Could not read the launch terms from the contract, so they are not shown
          above. ({paramsError})
        </p>
      ) : null}

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

/**
 * The launched token's address, from the receipt.
 *
 * CurveFunder emits TokenLaunched(token, underlying, creator, name, symbol)
 * with the token indexed, so it is the first topic after the signature. Read it
 * from the log rather than re-reading allTokens, which would race another
 * launch in the same block.
 */
// keccak256("TokenLaunched(address,bytes32,address,string,string)"), verified
// against contracts/src/CurveFunder.sol:169 rather than assumed.
const TOKEN_LAUNCHED_TOPIC =
  "0xa8b3974b09b1de10bb055f1f5d0aa2744ae82c67d97863faf66308126f10d33d";

function newTokenAddress(receipt: { logs: readonly { topics: readonly string[] }[] }) {
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() === TOKEN_LAUNCHED_TOPIC && log.topics[1]) {
      return ("0x" + log.topics[1].slice(26)) as `0x${string}`;
    }
  }
  return null;
}

