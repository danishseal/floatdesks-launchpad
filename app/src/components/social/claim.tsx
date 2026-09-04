"use client";

/**
 * Reserved-username claim surface. Two ways in:
 *
 *  1. WALLET CLAIM (the original path): connect a wallet, paste the token, sign a
 *     message binding that token, and the reserved handle + preset bind to your
 *     wallet. Normal wallet-signature identity model.
 *
 *  2. CLAIM WITHOUT A WALLET (token-as-credential) — a DELIBERATE, DOCUMENTED
 *     EXCEPTION to that model. Paste the token, no wallet needed: the handle +
 *     preset bind to a synthetic `token-<username>` owner and become publicly
 *     visible (verified). The claim token itself is the credential for editing
 *     the account (display name / bio / avatar / banner). Later you BIND a real
 *     wallet — that step re-introduces a wallet signature (the token proves the
 *     account, the signature proves the new wallet) — after which it is an
 *     ordinary wallet-owned profile and the token is spent.
 *
 * An admin can also deep-link the recipient straight here with the token
 * prefilled: /claim?token=<raw token>.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  SealCheck,
  Ticket,
  ArrowRight,
  CheckCircle,
  Camera,
  ShieldWarning,
  User,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { useFloorWallet } from "@/components/wallet/solana-wallet-provider";
import {
  useClaimUsername,
  useClaimNoWallet,
  useEditTokenProfile,
  useBindWallet,
  type Profile,
} from "@/lib/social";
import { resolveIdentity, errMsg, downscaleImage } from "@/components/social/shared";

export function ClaimUsername() {
  const wallet = useFloorWallet();
  const router = useRouter();
  const params = useSearchParams();
  const claim = useClaimUsername();
  const claimNoWallet = useClaimNoWallet();

  const [token, setToken] = useState("");
  const [claimed, setClaimed] = useState<Profile | null>(null);
  // A token-owned account created via the no-wallet path. Its presence switches
  // the surface to the token editor + bind-a-wallet CTA.
  const [tokenAccount, setTokenAccount] = useState<{ profile: Profile; ownerId: string } | null>(null);

  // Prefill the token from a deep link (/claim?token=...), once.
  useEffect(() => {
    const t = params.get("token");
    if (t) setToken(t.trim());
  }, [params]);

  async function handleClaim() {
    if (!wallet.address) {
      try {
        await wallet.connect();
      } catch {
        /* the connect UI surfaces its own errors */
      }
      return;
    }
    const raw = token.trim();
    if (!raw) {
      toast.error("Paste your claim token first");
      return;
    }
    try {
      const profile = await claim.mutateAsync({ address: wallet.address, token: raw, signer: wallet });
      setClaimed(profile);
      const identity = resolveIdentity(profile, wallet.address);
      toast.success(`Claimed ${identity.handle ?? identity.name}`);
    } catch (e) {
      toast.error("Could not claim", { description: errMsg(e) });
    }
  }

  async function handleClaimNoWallet() {
    const raw = token.trim();
    if (!raw) {
      toast.error("Paste your claim token first");
      return;
    }
    try {
      const res = await claimNoWallet.mutateAsync({ token: raw });
      setTokenAccount(res);
      toast.success("Handle claimed");
    } catch (e) {
      toast.error("Could not claim", { description: errMsg(e) });
    }
  }

  // ── token-owned account (claimed without a wallet) ───────────────────────────
  if (tokenAccount) {
    return (
      <TokenAccountView
        token={token.trim()}
        initial={tokenAccount.profile}
        onBound={(walletAddr) => router.push(`/creator/${encodeURIComponent(walletAddr)}`)}
      />
    );
  }

  // ── wallet-claim success ─────────────────────────────────────────────────────
  if (claimed && wallet.address) {
    const identity = resolveIdentity(claimed, wallet.address);
    return (
      <div className="mx-auto w-full max-w-md">
        <div className="rounded-2xl border border-[var(--hairline)] bg-[var(--color-bg-surface)] p-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-accent-solid)]/10">
            <CheckCircle size={34} weight="fill" className="text-[var(--color-accent-strong)]" />
          </div>
          <h1 className="mt-4 font-display text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)]">
            Handle claimed
          </h1>
          <div className="mt-1.5 inline-flex items-center gap-1.5">
            <span className="font-display text-[16px] font-semibold text-[var(--color-text-primary)]">{identity.name}</span>
            {claimed.verified && (
              <SealCheck size={17} weight="fill" className="text-[var(--color-accent-strong)]" aria-label="Verified" />
            )}
          </div>
          <p className="mt-3 text-[13px] leading-6 text-[var(--color-text-muted)]">
            {identity.handle ? `${identity.handle} is` : "It is"} now bound to your wallet. This
            token has been used and can&apos;t be claimed again.
          </p>
          <button
            type="button"
            onClick={() => router.push(`/creator/${encodeURIComponent(wallet.address!)}`)}
            className="mt-6 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent-solid)] text-[14px] font-semibold text-[var(--color-on-accent)] transition-opacity hover:opacity-90"
          >
            View your profile <ArrowRight size={15} weight="bold" />
          </button>
        </div>
      </div>
    );
  }

  // ── claim form ───────────────────────────────────────────────────────────────
  const claiming = claim.isPending || claimNoWallet.isPending;
  return (
    <div className="mx-auto w-full max-w-md">
      <div className="mb-5 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--hairline)] bg-[var(--color-bg-raised)]">
          <Ticket size={24} weight="duotone" className="text-[var(--color-accent-strong)]" />
        </div>
        <h1 className="mt-3 font-display text-[22px] font-semibold tracking-tight text-[var(--color-text-primary)]">
          Claim a reserved handle
        </h1>
        <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-6 text-[var(--color-text-muted)]">
          Got a claim token? Paste it below. You can claim right now without a
          wallet and bind one later, or connect a wallet and claim straight to it.
        </p>
      </div>

      <div className="rounded-2xl border border-[var(--hairline)] bg-[var(--color-bg-surface)] p-5">
        <label htmlFor="claim-token" className="block text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
          Claim token
        </label>
        <input
          id="claim-token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void (wallet.address ? handleClaim() : handleClaimNoWallet());
          }}
          placeholder="Paste the token you were sent"
          spellCheck={false}
          autoComplete="off"
          className="mt-2 w-full rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-page)] px-3.5 py-2.5 font-mono text-[13px] text-[var(--color-text-primary)] outline-none transition-colors placeholder:text-[var(--color-text-subtle)] focus:border-[var(--color-accent-solid)]/50"
        />

        {wallet.address ? (
          <>
            <p className="mt-2.5 truncate text-[12px] text-[var(--color-text-muted)]">
              Wallet connected: <span className="font-mono text-[var(--color-text-secondary)]">{wallet.address}</span>
            </p>
            <button
              type="button"
              onClick={() => void handleClaim()}
              disabled={claiming}
              className="mt-4 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent-solid)] text-[14px] font-semibold text-[var(--color-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {claim.isPending ? "Claiming…" : (
                <>
                  Claim to my wallet <ArrowRight size={15} weight="bold" />
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => void handleClaimNoWallet()}
              disabled={claiming}
              className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-lg border border-[var(--hairline)] bg-transparent text-[13px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--hairline-strong)] hover:text-[var(--color-text-primary)] disabled:opacity-60"
            >
              {claimNoWallet.isPending ? "Claiming…" : "Claim without a wallet"}
            </button>
          </>
        ) : (
          <>
            <p className="mt-2.5 text-[12px] leading-5 text-[var(--color-text-muted)]">
              No wallet needed to claim. Your handle is secured by this claim link
              until you bind a wallet to protect it.
            </p>
            <button
              type="button"
              onClick={() => void handleClaimNoWallet()}
              disabled={claiming}
              className="mt-4 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent-solid)] text-[14px] font-semibold text-[var(--color-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {claimNoWallet.isPending ? "Claiming…" : (
                <>
                  Claim without a wallet <ArrowRight size={15} weight="bold" />
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => void handleClaim()}
              disabled={claiming}
              className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-lg border border-[var(--hairline)] bg-transparent text-[13px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--hairline-strong)] hover:text-[var(--color-text-primary)] disabled:opacity-60"
            >
              Connect a wallet & claim to it
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The screen shown after a no-wallet claim: a lightweight token-authed editor
 * (display name / bio / avatar / banner) plus a persistent security notice and a
 * "Bind a wallet" CTA. Editing is authorized by the claim token (the documented
 * exception); binding re-introduces a wallet signature.
 */
function TokenAccountView({
  token,
  initial,
  onBound,
}: {
  token: string;
  initial: Profile;
  onBound: (walletAddress: string) => void;
}) {
  const wallet = useFloorWallet();
  const editTokenProfile = useEditTokenProfile();
  const bind = useBindWallet();

  const [form, setForm] = useState<Profile>(initial);
  const avatarInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);
  const [imgBusy, setImgBusy] = useState<"avatar" | "banner" | null>(null);

  const identity = resolveIdentity(form, "token");

  function set<K extends keyof Profile>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function onImage(kind: "avatar" | "banner", file: File | undefined) {
    if (!file) return;
    setImgBusy(kind);
    try {
      const out = await downscaleImage(file, { maxEdge: kind === "avatar" ? 512 : 1200 });
      set(kind, out);
    } catch (e) {
      toast.error("Couldn't use that image", { description: errMsg(e) });
    } finally {
      setImgBusy(null);
      if (kind === "avatar" && avatarInput.current) avatarInput.current.value = "";
      if (kind === "banner" && bannerInput.current) bannerInput.current.value = "";
    }
  }

  async function save() {
    try {
      const profile = await editTokenProfile.mutateAsync({
        token,
        profile: {
          displayName: form.displayName,
          bio: form.bio,
          avatar: form.avatar,
          banner: form.banner,
        },
      });
      setForm((f) => ({ ...f, ...profile }));
      toast.success("Profile saved");
    } catch (e) {
      toast.error("Could not save", { description: errMsg(e) });
    }
  }

  async function bindWallet() {
    if (!wallet.address) {
      try {
        await wallet.connect();
      } catch {
        /* connect UI surfaces its own errors */
      }
      return;
    }
    try {
      await bind.mutateAsync({ address: wallet.address, token, signer: wallet });
      toast.success("Wallet bound");
      onBound(wallet.address);
    } catch (e) {
      toast.error("Could not bind wallet", { description: errMsg(e) });
    }
  }

  const field =
    "h-10 w-full rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-raised)] px-3 text-[14px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)] focus:border-[var(--hairline-strong)]";

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="rounded-2xl border border-[var(--hairline)] bg-[var(--color-bg-surface)] p-5">
        {/* Success header */}
        <div className="flex items-center gap-2">
          <CheckCircle size={22} weight="fill" className="shrink-0 text-[var(--color-accent-strong)]" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h1 className="truncate font-display text-[17px] font-semibold text-[var(--color-text-primary)]">{identity.name}</h1>
              {form.verified && <SealCheck size={16} weight="fill" className="shrink-0 text-[var(--color-accent-strong)]" aria-label="Verified" />}
            </div>
            <p className="text-[12px] text-[var(--color-text-muted)]">Handle claimed. It&apos;s live and public now.</p>
          </div>
        </div>

        {/* Persistent security notice */}
        <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-[#f0c36c]/25 bg-[#f0c36c]/10 p-3">
          <ShieldWarning size={18} weight="fill" className="mt-0.5 shrink-0 text-[#f0c36c]" />
          <p className="text-[12px] leading-5 text-[#e9d5a8]">
            This account is secured by your claim link until you bind a wallet.
            Bind a wallet to protect it and enable posting.
          </p>
        </div>

        {/* Lightweight token-authed editor */}
        <div className="mt-5 space-y-4">
          {/* Banner + avatar */}
          <div>
            <span className="mb-1.5 block text-[12px] font-medium text-[var(--color-text-secondary)]">Banner &amp; avatar</span>
            <div className="relative">
              <button
                type="button"
                onClick={() => bannerInput.current?.click()}
                className="group relative block aspect-[3.8/1] w-full overflow-hidden rounded-xl border border-[var(--hairline)] bg-[var(--color-bg-raised)]"
              >
                {form.banner ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={form.banner} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="h-full w-full bg-gradient-to-br from-[#1f2a20] via-[#1c1c1e] to-[#161616]" />
                )}
                <span className="absolute inset-0 flex items-center justify-center gap-1.5 bg-black/40 text-[12px] font-medium text-[var(--color-text-primary)] opacity-0 transition-opacity group-hover:opacity-100">
                  <Camera size={16} weight="fill" /> {imgBusy === "banner" ? "Processing…" : form.banner ? "Change banner" : "Upload banner"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => avatarInput.current?.click()}
                className="group absolute -bottom-8 left-4 h-20 w-20 overflow-hidden rounded-full border-2 border-[var(--color-bg-surface)] bg-[var(--color-bg-raised)] ring-4 ring-[var(--color-bg-surface)]"
              >
                {form.avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={form.avatar} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-[var(--color-text-muted)]">
                    <User size={34} weight="fill" />
                  </span>
                )}
                <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-[var(--color-text-primary)] opacity-0 transition-opacity group-hover:opacity-100">
                  <Camera size={18} weight="fill" />
                </span>
              </button>
            </div>
            <div className="mt-2.5 pl-[108px] text-[11px] text-[var(--color-text-subtle)]">
              {imgBusy === "avatar" ? "Processing avatar…" : "Click either image to upload. Downscaled automatically."}
            </div>
            <input ref={bannerInput} type="file" accept="image/*" className="hidden" onChange={(e) => onImage("banner", e.target.files?.[0])} />
            <input ref={avatarInput} type="file" accept="image/*" className="hidden" onChange={(e) => onImage("avatar", e.target.files?.[0])} />
          </div>

          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-[var(--color-text-secondary)]">Display name</span>
            <input className={field} value={form.displayName ?? ""} onChange={(e) => set("displayName", e.target.value)} placeholder="satoshi" maxLength={40} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-[var(--color-text-secondary)]">Bio</span>
            <textarea
              className="w-full resize-none rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-raised)] px-3 py-2 text-[14px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)] focus:border-[var(--hairline-strong)]"
              rows={2}
              value={form.bio ?? ""}
              onChange={(e) => set("bio", e.target.value)}
              placeholder="A short bio"
              maxLength={160}
            />
          </label>

          <button
            type="button"
            onClick={() => void save()}
            disabled={editTokenProfile.isPending}
            className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-[var(--hairline-strong)] bg-[var(--color-bg-raised)] text-[13px] font-semibold text-[var(--color-text-primary)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-60"
          >
            {editTokenProfile.isPending ? "Saving…" : "Save profile"}
          </button>
        </div>

        {/* Bind-a-wallet CTA */}
        <div className="mt-5 border-t border-[var(--hairline)] pt-5">
          <button
            type="button"
            onClick={() => void bindWallet()}
            disabled={bind.isPending}
            className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent-solid)] text-[14px] font-semibold text-[var(--color-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {bind.isPending
              ? "Binding…"
              : wallet.address
                ? (
                  <>
                    Bind this wallet <ArrowRight size={15} weight="bold" />
                  </>
                )
                : "Connect a wallet to bind"}
          </button>
          {wallet.address && (
            <p className="mt-2 truncate text-center text-[11px] text-[var(--color-text-muted)]">
              Binding <span className="font-mono text-[var(--color-text-secondary)]">{wallet.address}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
