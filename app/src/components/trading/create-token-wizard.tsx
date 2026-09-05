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
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ImageDrop } from "@/components/trading/image-drop";
import { ArrowLeft, ArrowSquareOut, CheckCircle } from "@phosphor-icons/react";
import { useFloatWallet } from "@/components/wallet/float-wallet-provider";
import { usePools, usd, px8, type PoolsResponse } from "@/components/liquidity/use-pools";
import { tx, waitFor, launchpadParams, publicClient } from "@/lib/float/chain";
import { readableError } from "@/lib/float/errors";
import { cfTx, cfLaunchParams, tokenMetaOwner, setTokenMeta } from "@/lib/float/curve-funder";
import { launchableCandidates, pricedNow, type Candidate } from "@/lib/float/catalogue";
import { activeNetwork } from "@/lib/float/networks";

// Geist, the same face the rest of the app uses. This wizard had been running
// on a woff2 lifted from the template it was cloned from, so it read as a
// different product from every other page.
const HEADING: React.CSSProperties = {
  fontFamily: "var(--font-display)", fontWeight: 600, fontSize: "26px",
  letterSpacing: "-0.02em", lineHeight: "1.15",
};
const BODY: React.CSSProperties = {
  fontFamily: "var(--font-sans)", fontWeight: 400, fontSize: "15px", lineHeight: "1.45",
};
const CTA: React.CSSProperties = {
  fontFamily: "var(--font-sans)", fontWeight: 600, fontSize: "14px",
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
  // A company with no market yet. Mutually exclusive with `underlying`:
  // launchNew creates the listing, launchToken needs one to exist.
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
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

  // Only CurveFunder can list a stock nobody has listed, so this is the only
  // venue where an unlisted company is offerable at all.
  useEffect(() => {
    if (data?.venue !== "curve-funder") { setCandidates([]); return; }
    const listed = new Set((data.markets ?? []).map((m) => m.assetId.toLowerCase()));
    void launchableCandidates(listed).then(setCandidates).catch(() => setCandidates([]));
  }, [data?.venue, data?.markets]);

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
  const listedAll = useMemo(
    () => (data?.markets ?? []).filter((m) => (curveFunder ? true : m.status === 0)),
    [data?.markets, curveFunder],
  );
  // ONE rule for both groups: offer a market only if the oracle prices it NOW.
  //
  // A halted market is fine, it opens on the first buy. A market nobody is
  // pricing is not: it cannot trade at any point, so offering it sells a
  // launcher a fee for a token that can never move. The hub hides this well,
  // answering a quorum failure with the last known price stamped far into the
  // past, so the check has to read the timestamp rather than the price.
  const [priced, setPriced] = useState<Set<string> | null>(null);
  useEffect(() => {
    const ms = data?.markets ?? [];
    if (ms.length === 0) { setPriced(new Set()); return; }
    let alive = true;
    void Promise.all(ms.map(async (m) => ((await pricedNow(m.assetId)) ? m.assetId.toLowerCase() : null)))
      .then((ids) => { if (alive) setPriced(new Set(ids.filter((i): i is string => i !== null))); })
      .catch(() => { if (alive) setPriced(new Set()); });
    return () => { alive = false; };
  }, [data?.markets]);
  const live = useMemo(
    () => (priced === null ? [] : listedAll.filter((m) => priced.has(m.assetId.toLowerCase()))),
    [listedAll, priced],
  );
  const hiddenUnpriced = priced === null ? 0 : listedAll.length - live.length;
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
          // This used to say the values were "saved with the launch for that
          // admin to set". Nothing saved them. TokenMetadata.setUri is
          // onlyOwner and the launch path only writes when the connected
          // wallet IS the owner, so everything typed here was discarded. Say
          // that, rather than offering reassurance for something that does not
          // happen.
          ? `Only ${metaOwner.slice(0, 8)}… can write token metadata on this deployment, so anything entered here is NOT saved anywhere. Leave it blank and ask that admin to set it after the launch.`
          : metaChecked
            ? "This deployment has no metadata contract, so these cannot be stored on chain."
            : "Checking where this deployment stores token metadata…";
  const identityValid = name.trim().length > 1 && /^[A-Za-z0-9]{2,12}$/.test(symbol.trim());

  async function launch() {
    if ((!chosen && !candidate) || !data) return;
    setBusy(true);
    try {
      const account = wallet.getAccount();
      if (wallet.wrongChain) await wallet.switchChain();
      toast.info("Approving the launch fee and creating the token…");
      // Both venues launch; they differ in what the curve settles in and
      // whether on-chain metadata exists. CurveFunder stores no TokenMeta, so
      // image and socials are dropped there rather than silently discarded.
      // Three cases, not two. A catalogue pick has no market yet, so it goes
      // through launchNew, which lists the stock and launches the token in one
      // transaction and costs the list fee on top of the launch fee.
      const nm = name.trim();
      const sym = symbol.trim().toUpperCase();
      let hash: `0x${string}`;
      if (candidate) {
        hash = await cfTx.launchNew(account, nm, sym, candidate.ticker, candidate.displayName);
      } else if (!chosen) {
        return; // the guard above already covers this; written out so the two
                // branches below narrow instead of asserting non-null
      } else if (data.venue === "curve-funder") {
        hash = await cfTx.launchToken(account, nm, sym, chosen.assetId);
      } else {
        hash = await tx.launchToken(account, nm, sym, chosen.assetId, {
          image: image.trim(), website: website.trim(), twitter: twitter.trim(), telegram: telegram.trim(),
        });
      }
      const receipt = await waitFor(hash);
      toast.success(`${sym} launched on f${candidate?.ticker ?? chosen?.ticker}.`);

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
        s === "underlying"
          ? true
          : s === "identity"
            ? Boolean(underlying || candidate)
            : Boolean(underlying || candidate) && identityValid} />

      {step === "underlying" ? (
        <UnderlyingStep
          data={data}
          live={live}
          candidates={candidates}
          hiddenUnpriced={hiddenUnpriced}
          selected={underlying}
          selectedNew={candidate}
          onSelect={(id) => { setCandidate(null); setUnderlying(id); setStep("identity"); }}
          onSelectNew={(c) => { setUnderlying(null); setCandidate(c); setStep("identity"); }}
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
          candidate={candidate}
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
    <div className="px-4 py-10 sm:py-14" style={{ fontFamily: "var(--font-sans)" }}>
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

/* ---------------------------------------------------------------- market row */

/**
 * One selectable market, with a link to its contract.
 *
 * The explorer link is a sibling of the select button rather than a child of
 * it: an anchor inside a button is invalid HTML, and browsers resolve it by
 * doing one or the other unpredictably, so picking a market would sometimes
 * open a tab instead.
 */
function MarketRow({ ticker, displayName, token, price, status, selected, onSelect, dashed }: {
  ticker: string;
  displayName: string;
  token?: string | null;
  price?: string | null;
  status: string;
  selected: boolean;
  onSelect: () => void;
  dashed?: boolean;
}) {
  const explorer = activeNetwork().explorer;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-center justify-between rounded-[12px] border px-4 py-4 pr-12 text-left transition ${
          selected
            ? "border-[var(--color-text-primary)] bg-[var(--color-bg-surface)]"
            : `${dashed ? "border-dashed " : ""}border-[var(--color-border-soft)] hover:border-[var(--color-text-subtle)] hover:bg-[var(--color-bg-surface)]/60`
        }`}
      >
        <div className="min-w-0">
          <span
            className="block text-[15px] text-[var(--color-text-primary)]"
            style={{ fontFamily: "var(--font-display)", fontWeight: 600, letterSpacing: "-0.01em" }}
          >
            f{ticker}
          </span>
          <span className="mt-1 block truncate text-[13px] text-[var(--color-text-secondary)]">
            {displayName}
          </span>
        </div>
        <div className="shrink-0 pl-3 text-right">
          {price ? (
            <span
              className="block text-[15px] text-[var(--color-text-primary)]"
              style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
            >
              {price}
            </span>
          ) : null}
          <span className="mt-1 block text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-subtle)]">
            {status}
          </span>
        </div>
      </button>
      {token ? (
        <a
          href={`${explorer}/token/${token}`}
          target="_blank"
          rel="noreferrer"
          aria-label={`f${ticker} contract on the explorer`}
          title={`f${ticker} on the explorer`}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-[8px] p-2 text-[var(--color-text-subtle)] transition hover:bg-[var(--color-bg-page)] hover:text-[var(--color-text-primary)]"
        >
          <ArrowSquareOut size={16} weight="bold" />
        </a>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- step one */

function UnderlyingStep({ data, live, candidates, hiddenUnpriced, selected, selectedNew, onSelect, onSelectNew }: {
  data: PoolsResponse;
  live: PoolsResponse["markets"];
  candidates: Candidate[];
  hiddenUnpriced: number;
  selected: `0x${string}` | null;
  selectedNew: Candidate | null;
  onSelect: (id: `0x${string}`) => void;
  onSelectNew: (c: Candidate) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[600px]">
      <h2 style={HEADING} className="text-center text-[var(--color-text-primary)]">Pick the underlying</h2>
      <p style={BODY} className="mx-auto mt-3 max-w-[460px] text-center text-[var(--color-text-secondary)]">
        {data.venue === "curve-funder" ? (
          <>
            Your token&apos;s whole supply sits on a curve, and every buy of it
            funds this stock. A halted market is fine: it goes live on the first
            buy.
          </>
        ) : (
          <>
            Your token&apos;s whole supply sits on a curve priced and settled in this
            fSHARE, so every buy of your token has to buy the stock first. Only open
            markets can be launched against.
          </>
        )}
      </p>

      {data.venue === "curve-funder" ? (
        <div className="mx-auto mt-7 max-w-[520px] rounded-[12px] border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)]/50 p-5">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-subtle)]">
            What your token is quoted in
          </h3>
          <p style={BODY} className="mt-3 text-[var(--color-text-secondary)]">
            It changes once, and both halves are worth knowing before you launch.
          </p>
          <div className="mt-4 space-y-4">
            <div className="flex gap-3">
              <span className="mt-[3px] shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-subtle)]">
                On the curve
              </span>
              <p style={BODY} className="text-[var(--color-text-secondary)]">
                Priced in <strong className="text-[var(--color-text-primary)]">{data.quote.symbol}</strong>,
                so a buyer needs none of the fSHARE to get in. Their money still
                becomes the stock: every buy is split, part into this
                market&apos;s cash cushion and part into buying its fSHARE
                reserve. That is why the raise IS the underlying even though
                nobody touches the fSHARE directly.
              </p>
            </div>
            <div className="flex gap-3">
              <span className="mt-[3px] shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-subtle)]">
                After graduation
              </span>
              <p style={BODY} className="text-[var(--color-text-secondary)]">
                The curve closes and the leftover supply opens a{" "}
                <strong className="text-[var(--color-text-primary)]">token / fSHARE</strong> pool,
                with an fSHARE / {data.quote.symbol} pool underneath it. From
                then on your token is quoted in the company, not in dollars, so
                its price moves with the stock as well as with its own demand.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-10 space-y-2">
        {live.map((m) => (
          <MarketRow
            key={m.assetId}
            ticker={m.ticker}
            displayName={m.displayName}
            token={m.token}
            price={usd(px8(m.markPx), { max: 2 })}
            status={m.status !== 0
              ? "halted, opens on the first buy"
              : m.marketOpen ? "home market open" : "quoted overnight"}
            selected={selected === m.assetId}
            onSelect={() => onSelect(m.assetId)}
          />
        ))}
      </div>

      {hiddenUnpriced > 0 ? (
        <p style={BODY} className="mt-6 text-center text-[13px] text-[var(--color-text-subtle)]">
          {hiddenUnpriced} listed market{hiddenUnpriced === 1 ? " is" : "s are"} hidden because no
          poster is pricing {hiddenUnpriced === 1 ? "it" : "them"} right now.
        </p>
      ) : null}

      {candidates.length > 0 ? (
        <div className="mt-10">
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-subtle)]">
            Not listed yet
          </h3>
          <p style={BODY} className="mt-2 text-[13px] text-[var(--color-text-secondary)]">
            Nobody has opened a market for these. Picking one lists the stock and
            launches your token in the same transaction, for the list fee on top
            of the launch fee. Only companies the oracle already prices are shown,
            because a market it cannot price would open halted and stay dark.
          </p>
          <div className="mt-4 space-y-2">
            {candidates.map((c) => (
              <button
                key={c.ticker}
                type="button"
                onClick={() => onSelectNew(c)}
                className={`flex w-full items-center justify-between rounded-[12px] border px-4 py-4 text-left transition ${
                  selectedNew?.ticker === c.ticker
                    ? "border-[var(--color-text-primary)] bg-[var(--color-bg-surface)]"
                    : "border-dashed border-[var(--color-border-soft)] hover:border-[var(--color-text-subtle)]"
                }`}
              >
                <div className="min-w-0">
                  <span className="block text-[16px] font-semibold text-[var(--color-text-primary)]">
                    f{c.ticker}
                  </span>
                  <span className="mt-0.5 block truncate text-[13px] text-[var(--color-text-secondary)]">
                    {c.displayName}
                  </span>
                </div>
                <div className="shrink-0 text-right">
                  <span className="block text-[13px] text-[var(--color-text-subtle)]">{c.line}</span>
                  <span className="mt-0.5 block text-[12px] text-[var(--color-text-subtle)]">
                    opens with your launch
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null}

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
            <Field label="Logo" hint="Dropped files are stored on chain inside the launch metadata, so they are downscaled to fit. A pasted URL is only linked. Screeners render neither, they have no logo standard, but the token page does.">
              <ImageDrop value={image} onChange={setImage} />
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
  data, market, candidate, name, symbol, image, website, twitter, telegram, params, paramsError, wallet, busy, onBack, onLaunch,
}: {
  data: PoolsResponse;
  market: PoolsResponse["markets"][number] | null;
  /** Set instead of `market` when launching on a company nobody has listed. */
  candidate: Candidate | null;
  name: string; symbol: string; image: string; website: string; twitter: string; telegram: string;
  params: LaunchParams | null;
  paramsError: string | null;
  wallet: ReturnType<typeof useFloatWallet>;
  busy: boolean;
  onBack: () => void; onLaunch: () => void;
}) {
  // A catalogue pick has no listed market yet, so this returned null and the
  // review step rendered empty. Take the identity from whichever is set.
  const isNew = !market && !!candidate;
  // The protocol fee is not what a launch costs. It is 0.10 USDG against a
  // transaction that deploys an ERC-20, and on a curve-funder launch of an
  // unlisted company it deploys two. Quoting only the fee understates the real
  // number by an order of magnitude, so price the gas and show both.
  const [gasEst, setGasEst] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const gwei = await publicClient().getGasPrice();
        // measured: launchToken 716k, launchNew 1.63M (it lists the stock too)
        const units = isNew ? 1_630_000n : 716_000n;
        const wei = gwei * units;
        const eth = Number(wei) / 1e18;
        if (alive) setGasEst(`${eth.toFixed(5)} ETH`);
      } catch {
        if (alive) setGasEst(null);
      }
    })();
    return () => { alive = false; };
  }, [isNew]);
  const ticker = market?.ticker ?? candidate?.ticker ?? null;
  const underlyingName = market?.displayName ?? candidate?.displayName ?? "";
  if (!ticker) return null;
  const dp = data.quote.decimals;
  const fee = params ? Number(params.launchFee) / 10 ** dp : null;

  const short = wallet.balance !== null && fee !== null && wallet.balance < fee;

  // The quote asset is the venue's, not an assumption: CurveFunder settles the
  // curve in USDG, TokenLaunchpad in the underlying fSHARE.
  const curveFunder = data.venue === "curve-funder";
  // Both halves, because naming only the first is what makes this read wrong.
  // On the curve the quote is USDG, so a buyer needs no fSHARE to start. Their
  // money still becomes the stock: every buy is split, part into that market's
  // cushion and part into its fSHARE reserve. And at graduation the token's
  // pool is MEME/fSHARE, so from then on it IS quoted in the fSHARE.
  const quoteAsset = curveFunder
    ? `${data.quote.symbol} on the curve, then f${ticker} once it graduates`
    : `f${ticker} at ${market ? usd(px8(market.markPx), { max: 2 }) : "the oracle price"}`;

  const rows: Array<[string, string]> = [
    ["Ticker", `$${symbol.toUpperCase()}`],
    ["Name", name],
    ["Underlying", `f${ticker} · ${underlyingName}`],
    ["Quote asset", quoteAsset],
    ...((isNew || market?.status !== 0) && curveFunder
      ? [["Market status", isNew
          ? "not listed yet, this launch lists it and it goes live on the first buy"
          : "halted, and goes live on the first buy"] as [string, string]]
      : []),
    ...(params ? [
      ["Launch fee", `${fee?.toFixed(2)} ${data.quote.symbol}${gasEst ? ` + ~${gasEst} gas` : " + network gas"}`] as [string, string],
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

