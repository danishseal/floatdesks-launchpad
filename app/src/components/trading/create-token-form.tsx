"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Horse } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useFloorWallet } from "@/components/wallet/solana-wallet-provider";
import { createToken } from "@/lib/ansem/launchpad-tx";
import { HORNS } from "@/lib/horns-catalog";

// Extra Horns a creator can compose onto their pool. The reward skim (Vault /
// Fee-Share) is the base and always implied; the Composite router itself and the
// hook interface are not user-selectable. A dot marks Horns that need extra
// config or funding to actually do anything.
// Excludes the base reward Horns (vault/feeshare), the router itself, the
// interface, and limit/twamm, which are a standalone router and a keeper, not
// pool hooks (per the attach-path audit).
const COMPOSABLE_HORNS = HORNS.filter(
  (h) => !["vault", "feeshare", "composite", "_hooks-interface", "limit", "twamm"].includes(h.slug),
);
const HORN_NEEDS_CONFIG = new Set(["rehypo", "arb", "floor", "auction"]);
// Stateful Horns that must run alone (not composed): their after_swap invariants
// (budget, rent) are unsafe to stack. Selecting one is exclusive; picking a
// stackable Horn clears it, and vice versa.
const HORN_SOLO = new Set(["arb", "auction"]);
import { BASE_DENOMS } from "@/lib/floorlaunch/config";

type BaseChoice = "chanse" | "ansem";

/**
 * Downscale an uploaded image to a small square and return a JPEG data URL.
 * The launchpad stores this string on-chain as the token image, so it must be
 * compact: we cap it at 256px and re-encode so it renders everywhere with no
 * external host required.
 */
async function fileToDataUrl(file: File, max = 256): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.82);
}

export function CreateTokenForm() {
  const wallet = useFloorWallet();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState("");
  const [description, setDescription] = useState("");
  const [twitter, setTwitter] = useState("");
  const [website, setWebsite] = useState("");
  const [telegram, setTelegram] = useState("");
  const [base, setBase] = useState<BaseChoice>("chanse");
  const [gradAnsem, setGradAnsem] = useState(""); // Floatdesk graduation target (whole Floatdesk)
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [imgBusy, setImgBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Wizard: 1 = customize the coin, 2 = launch config (denomination + Horns).
  const [step, setStep] = useState<1 | 2>(1);
  // Horns: attach a fee-skim Horn at graduation, split Floatdesk/CHANSE.
  const [attachHorns, setAttachHorns] = useState(true);
  const [skimPct, setSkimPct] = useState(3); // % of each swap fee -> Horn Vault (0..10)
  const [ansemPct, setAnsemPct] = useState(50); // share of the skim to the Floatdesk sink
  const [composite, setComposite] = useState<string[]>([]); // extra Horns via the Composite router

  const handleFile = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image file");
      return;
    }
    setImgBusy(true);
    try {
      setImage(await fileToDataUrl(file));
    } catch {
      toast.error("Could not read that image");
    } finally {
      setImgBusy(false);
    }
  }, []);

  const step1Valid = useMemo(
    () => name.trim().length > 0 && symbol.trim().length > 0 && description.trim().length > 0,
    [name, symbol, description],
  );

  const canSubmit = useMemo(
    () =>
      Boolean(wallet.connected) &&
      !submitting &&
      step1Valid &&
      (base === "chanse" || Number(gradAnsem) > 0),
    [wallet.connected, submitting, step1Valid, base, gradAnsem],
  );

  async function submit() {
    if (!wallet.address) {
      await wallet.connect();
      return;
    }
    setSubmitting(true);
    toast.loading("Confirm the launch in your wallet…", { id: "launch" });
    try {
      const client = await wallet.getSigningClient();
      const socialLinks = [twitter, website, telegram].filter((l) => l.trim());
      const hash = await createToken(client, wallet.address, {
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        image: image.trim(),
        description: description.trim(),
        socialLinks,
        baseDenom: base === "chanse" ? BASE_DENOMS.chanse : BASE_DENOMS.ansem,
        baseGradThreshold:
          base === "ansem"
            ? String(Math.round(Number(gradAnsem) * 1_000_000))
            : undefined,
        horn: attachHorns
          ? { skimBps: Math.round(skimPct * 100), ansemBps: Math.round(ansemPct * 100), composite }
          : undefined,
      });
      toast.success("Token launched", {
        id: "launch",
        description: `${symbol.toUpperCase()} is live on its bonding curve.`,
      });
      await queryClient.invalidateQueries({ queryKey: ["tokens"] });
      await wallet.refreshBalance();
      router.push("/");
      void hash;
    } catch (e) {
      toast.error("Launch failed", {
        id: "launch",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  }

  const field =
    "h-11 w-full rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3.5 text-[14px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)] focus:border-[var(--color-border-soft)]";

  const skimBps = Math.round(skimPct * 100);
  const chansePct = 100 - ansemPct;

  return (
    <div className="flex flex-col gap-5">
      {/* Stepper */}
      <div className="flex items-center gap-2">
        <StepPip n={1} label="Customize" active={step === 1} done={step > 1} onClick={() => setStep(1)} />
        <span className="h-px flex-1 bg-[var(--color-bg-hover)]" />
        <StepPip n={2} label="Launch" active={step === 2} done={false} onClick={() => step1Valid && setStep(2)} />
      </div>

      {step === 1 ? (
        <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-2 block text-[13px] font-medium text-[var(--color-text-secondary)]">Name</label>
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="My Token" />
        </div>
        <div>
          <label className="mb-2 block text-[13px] font-medium text-[var(--color-text-secondary)]">Symbol</label>
          <input className={field} value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="MTK" maxLength={12} />
        </div>
      </div>

      <div>
        <label className="mb-2 block text-[13px] font-medium text-[var(--color-text-secondary)]">Image</label>
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); void handleFile(e.dataTransfer.files?.[0]); }}
          className={`flex cursor-pointer items-center gap-4 rounded-xl border border-dashed px-4 py-4 transition ${
            dragOver ? "border-[var(--color-accent-solid)] bg-[var(--color-accent-solid)]/10" : "border-[var(--color-border-soft)] bg-[var(--color-bg-page)] hover:border-[var(--color-border)]"
          }`}
        >
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="token" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-[22px] text-[var(--color-text-subtle)]">＋</div>
          )}
          <div className="min-w-0 text-[13px]">
            <p className="font-medium text-[var(--color-text-primary)]">
              {imgBusy ? "Processing…" : image ? "Image ready, click to replace" : "Drag & drop or click to upload"}
            </p>
            <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">PNG, JPG or GIF. Downscaled to 256px and stored with the token.</p>
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ""; }}
        />
        <input
          className={`${field} mt-2`}
          value={image.startsWith("data:") ? "" : image}
          onChange={(e) => setImage(e.target.value)}
          placeholder="…or paste an image URL"
        />
      </div>

      <div>
        <label className="mb-2 block text-[13px] font-medium text-[var(--color-text-secondary)]">Description</label>
        <textarea
          className="w-full resize-none rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3.5 py-3 text-[14px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)] focus:border-[var(--color-border-soft)]"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this token?"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <input className={field} value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="Twitter (optional)" />
        <input className={field} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="Website (optional)" />
        <input className={field} value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="Telegram (optional)" />
      </div>

      <button
        type="button"
        disabled={!step1Valid}
        onClick={() => setStep(2)}
        className="btn-white mt-1 h-12 rounded-[6px] font-display text-[13px] uppercase tracking-[0.1em] disabled:opacity-40"
      >
        Next: launch settings
      </button>
        </>
      ) : (
        <>
      <div>
        <label className="mb-2 block text-[13px] font-medium text-[var(--color-text-secondary)]">Launch denomination</label>
        <div className="flex gap-2">
          {(["chanse", "ansem"] as BaseChoice[]).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBase(b)}
              className={`flex-1 rounded-[6px] px-4 py-3 font-display text-[13px] font-bold uppercase tracking-[0.08em] transition ${
                base === b
                  ? "bg-[var(--color-accent-solid)] text-[var(--color-on-accent)]"
                  : "border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              }`}
            >
              {b === "chanse" ? "CHANSE" : "Floatdesk"}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">
          The bonding curve, buys and sells, and the graduated pool all trade in the
          chosen asset. The platform creation fee is paid in CHANSE either way.
        </p>
      </div>

      {base === "ansem" ? (
        <div>
          <label className="mb-2 block text-[13px] font-medium text-[var(--color-text-secondary)]">
            Graduation target (Floatdesk)
          </label>
          <input
            className={field}
            value={gradAnsem}
            onChange={(e) => setGradAnsem(e.target.value)}
            placeholder="e.g. 50"
            inputMode="decimal"
          />
          <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">
            Floatdesk launches bypass the CHANSE/USD oracle. Set how much Floatdesk the curve
            raises before graduating to the AMM.
          </p>
        </div>
      ) : null}

      {/* Horns config */}
      <div className="rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-bg-page)]/80 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Horse size={16} weight="fill" className="text-[var(--color-accent-strong)]" />
            <span className="font-display text-[13px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-primary)]">
              Horns
            </span>
            <span className="rounded-[4px] border border-[var(--color-border-soft)] px-1.5 py-0.5 font-mono text-[9px] uppercase text-[var(--color-text-muted)]">
              at graduation
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={attachHorns}
            onClick={() => setAttachHorns((v) => !v)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${attachHorns ? "bg-[var(--color-accent-solid)]" : "bg-[var(--color-bg-raised)]"}`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-[var(--color-bg-surface)] transition-transform ${attachHorns ? "translate-x-[22px]" : "translate-x-0.5"}`}
            />
          </button>
        </div>

        {attachHorns ? (
          <div className="mt-4 space-y-4">
            {/* Skim */}
            <div>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-[var(--color-text-secondary)]">Skim to Horn Vault</span>
                <span className="mono font-semibold text-[var(--color-accent-strong)]">{skimPct}% of swap fees</span>
              </div>
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={skimPct}
                onChange={(e) => setSkimPct(Number(e.target.value))}
                className="ansem-range mt-2 w-full"
              />
            </div>

            {/* Split */}
            <div>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-[var(--color-text-secondary)]">Sink split</span>
                <span className="mono font-semibold text-[var(--color-text-primary)]">
                  <span className="text-[var(--color-accent-strong)]">{ansemPct}%</span> Floatdesk /{" "}
                  <span className="text-[#8ab4ff]">{chansePct}%</span> CHANSE
                </span>
              </div>
              <div className="mt-2 flex h-2 overflow-hidden rounded-full">
                <span style={{ width: `${ansemPct}%`, background: "#2563eb" }} className="block h-full" />
                <span style={{ width: `${chansePct}%`, background: "#8ab4ff" }} className="block h-full" />
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={ansemPct}
                onChange={(e) => setAnsemPct(Number(e.target.value))}
                className="ansem-range mt-2 w-full"
              />
            </div>

            {/* Composite: extra Horns run alongside the reward skim */}
            <div>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-[var(--color-text-secondary)]">Compose extra Horns</span>
                <span className="mono text-[var(--color-text-muted)]">{composite.length} selected</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {COMPOSABLE_HORNS.map((h) => {
                  const on = composite.includes(h.slug);
                  return (
                    <button
                      key={h.slug}
                      type="button"
                      title={h.tagline}
                      onClick={() =>
                        setComposite((c) => {
                          if (c.includes(h.slug)) return c.filter((s) => s !== h.slug);
                          if (HORN_SOLO.has(h.slug)) return [h.slug]; // solo: exclusive
                          return [...c.filter((s) => !HORN_SOLO.has(s)), h.slug];
                        })
                      }
                      className={`inline-flex items-center gap-1.5 rounded-[6px] border px-2 py-1 text-[11px] transition-colors ${
                        on
                          ? "border-[var(--color-accent-solid)] bg-[var(--color-accent-solid)]/10 text-[var(--color-accent-strong)]"
                          : "border-[var(--color-border-soft)] bg-[var(--color-bg-page)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                      }`}
                    >
                      {h.name}
                      {HORN_SOLO.has(h.slug) && (
                        <span className="rounded-[3px] bg-[var(--color-bg-raised)] px-1 py-0.5 font-mono text-[8px] uppercase tracking-wide text-[var(--color-text-muted)]">
                          solo
                        </span>
                      )}
                      {HORN_NEEDS_CONFIG.has(h.slug) && (
                        <span
                          title="Needs extra config or funding to do anything"
                          className="h-1.5 w-1.5 rounded-full bg-[#e0b341]"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] leading-4 text-[var(--color-text-subtle)]">
                {composite.length > 0
                  ? `${composite.length === 1 ? "1 extra Horn" : `${composite.length} extra Horns`} attach with the reward skim through the Composite router. A dot marks Horns that need extra config or funding.`
                  : "Optional. Add pricing, fee, or liquidity Horns to run alongside the reward skim. Two or more Horns run through the Composite router."}
              </p>
            </div>

            <p className="text-[11px] leading-4 text-[var(--color-text-subtle)]">
              When your coin graduates to the AMM, {skimPct}% of every swap fee ({skimBps} bps
              of the fee) is skimmed to the Horn Vault and split to Floatdesk / CHANSE stakers.
              Horns is in preview; this activates with the Horns program.
            </p>
          </div>
        ) : (
          <p className="mt-3 text-[12px] text-[var(--color-text-muted)]">
            No Horn attached. All swap fees stay with the pool. You can still launch;
            Horns can only be set at launch.
          </p>
        )}
      </div>

      {/* Step 2 nav */}
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          onClick={() => setStep(1)}
          className="h-12 shrink-0 rounded-[6px] border border-[var(--color-border-soft)] bg-transparent px-5 font-display text-[13px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border)] hover:text-[var(--color-text-primary)]"
        >
          Back
        </button>
        <button
          type="button"
          disabled={!canSubmit && wallet.connected}
          onClick={submit}
          className="btn-white h-12 flex-1 rounded-[6px] font-display text-[13px] uppercase tracking-[0.1em] disabled:opacity-40"
        >
          {!wallet.connected ? "Connect wallet" : submitting ? "Launching…" : "Launch token"}
        </button>
      </div>
        </>
      )}
    </div>
  );
}

function StepPip({
  n,
  label,
  active,
  done,
  onClick,
}: {
  n: number;
  label: string;
  active: boolean;
  done: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2"
    >
      <span
        className={`flex h-6 w-6 items-center justify-center rounded-full font-mono text-[11px] font-semibold transition-colors ${
          active
            ? "bg-[var(--color-accent-solid)] text-[var(--color-on-accent)]"
            : done
              ? "border border-[#2f7d3f] bg-[var(--color-accent-solid)]/10 text-[var(--color-accent-strong)]"
              : "border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] text-[var(--color-text-muted)]"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <span
        className={`font-display text-[11px] font-semibold uppercase tracking-[0.12em] ${
          active ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)]"
        }`}
      >
        {label}
      </span>
    </button>
  );
}
