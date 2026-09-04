"use client";

import { useState } from "react";
import Link from "next/link";
import { Lightning } from "@phosphor-icons/react";
import type { TokenListItem } from "@/lib/api";
import { getHornVaultAddress, getHornFeeShareAddress } from "@/lib/floorlaunch/config";
import { useHornConfig, useTokenHorn } from "@/hooks/use-token-horn";

/**
 * Horns surfaces for the token terminal, shaped to the real CosmWasm contracts.
 *
 * The Horns stack is LIVE on ansem-1 (deployed 2026-08-28): the launchpad is
 * horn-aware, the Fee-Share / Decay / Dynamic-Fee horns are deployed, and the
 * Horn Vault takes stakes. HornsFeeSplitPanel reads the launchpad HornConfig and
 * the per-token AMM pool hook LIVE (see src/hooks/use-token-horn.ts) and shows:
 *
 *   Launchpad query  horn_config{}          -> { feeshare, skim_bps, ansem_bps }
 *   AMM query        pool{ token_address }   -> Pool incl. hook{address,flags}
 *
 * Existing (pre-migration) pools carry no hook, so they honestly resolve to
 * "None" with a "-" skim/split: a real attached-horn readout appears only once a
 * coin graduates AFTER the migration with a horn bolted on. Nothing here is
 * fabricated: a datum the chain does not expose renders "-".
 *
 * The Horn Vault stake/claim query + exec shapes live in src/lib/ansem/vault-tx.ts
 * and drive the dedicated /vault page (HornVaultPanel below is a compact preview
 * of that surface and is not mounted on the token page).
 */
const HORN_VAULT_ADDRESS = getHornVaultAddress() ?? "";
const FEE_SHARE_ADDRESS = getHornFeeShareAddress() ?? "";

type Coin = { denom: string; amount: string }; // micro-units, cosmos Coin shape

const DENOM_LABEL: Record<string, string> = {
  uansem: "ANSEM",
  uchanse: "CHANSE",
};

function denomLabel(denom: string): string {
  return DENOM_LABEL[denom] ?? denom.replace(/^u/, "").toUpperCase();
}

const DASH = "-";

/** basis points -> percent string, e.g. 2000 -> "20%", 50 -> "0.5%". */
function bpsPct(bps: number): string {
  const p = bps / 100;
  return `${Number.isInteger(p) ? p : p.toFixed(2)}%`;
}

/* ---------------- What Horns are (explainer + fee mechanic) ---------------- */

export function HornsFeeSplitPanel({ token }: { token: TokenListItem }) {
  const configQ = useHornConfig();
  const hornQ = useTokenHorn(token);

  const config = configQ.data;
  // Live once the horn stack addresses exist AND the launchpad HornConfig
  // resolved. If that query fails, config is undefined and we fall back to the
  // preview copy.
  const hornsLive = config?.live === true;

  const horn = hornQ.data;
  const poolResolved = hornQ.isSuccess && horn != null;
  const poolHasHorn = poolResolved && horn.attached;

  // "This pool" values: real when resolved, "-" while pending / on error.
  const attachedHornValue = poolResolved ? (horn.attached ? horn.name ?? "Attached" : "None") : DASH;
  const skimValue = poolHasHorn && horn.skimBps != null ? bpsPct(horn.skimBps) : DASH;
  const splitValue =
    poolHasHorn && horn.ansemBps != null && horn.chanseBps != null
      ? `${bpsPct(horn.ansemBps)} / ${bpsPct(horn.chanseBps)}`
      : DASH;

  // Illustrative flow reflects the real launchpad defaults when config resolves.
  const flowSkim = config ? bpsPct(config.skimBps) : "creator-set";
  const flowSplit = config ? `${bpsPct(config.ansemBps)} / ${bpsPct(config.chanseBps)}` : "split";

  return (
    <section className="flex flex-col rounded-xl bg-[var(--color-bg-page)] p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-[15px] font-semibold text-[var(--color-text-primary)]">Horns</h3>
        <span className="rounded-[4px] border border-[var(--color-border-soft)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
          {hornsLive ? "live" : "preview"}
        </span>
      </div>

      <p className="mt-2 text-[12px] leading-[17px] text-[var(--color-text-secondary)]">
        Horns are v4-style hooks on the graduation AMM. When a Horn is attached,
        a slice of <span className="text-[var(--color-text-primary)]">every swap fee</span> is skimmed
        off and routed to the <span className="text-[var(--color-text-primary)]">Horn Vault</span>,
        split between the ANSEM and CHANSE staker sinks by a ratio the creator sets
        at launch. Stakers of either token earn a real cut of the pool&apos;s trading.
      </p>

      {/* Platform defaults from the live launchpad HornConfig (not per-pool). */}
      <div className="mt-3 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] p-3">
        <FlowRow tone="#2563eb" label="Swap fee" value="pool rate" sub="charged on every trade" />
        <div className="my-1.5 ml-[3px] h-3 w-px bg-[var(--color-bg-raised)]" />
        <FlowRow tone="#2563eb" label="Skim to Horns" value={flowSkim} sub="of the swap fee" />
        <FlowRow tone="#8ab4ff" label="ANSEM + CHANSE sinks" value={flowSplit} sub="to Vault stakers" />
      </div>

      {/* This pool: real per-pool params. Pre-hook pools honestly read "None". */}
      <div className="mt-3">
        <p className="mb-1.5 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-subtle)]">This pool</p>
        <div className="space-y-1.5 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] p-3">
          <PoolRow label="Attached Horn" value={attachedHornValue} />
          <PoolRow label="Skim to Vault" value={skimValue} />
          <PoolRow label="ANSEM / CHANSE split" value={splitValue} />
        </div>
      </div>

      {/* What creators + holders get out of it. */}
      <p className="mt-3 text-[12px] leading-[17px] text-[var(--color-text-secondary)]">
        A creator can bolt on Horns like <span className="text-[var(--color-text-primary)]">Fee Decay</span>,{" "}
        <span className="text-[var(--color-text-primary)]">Dynamic Fee</span> or <span className="text-[var(--color-text-primary)]">Oracle Arb</span>{" "}
        at graduation to reshape how the pool prices and pays. Stakers earn the skim from every graduated
        pool through the Vault.
      </p>

      {/* Genuinely useful links, and they fill the panel. */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Link
          href="/horns"
          className="flex items-center justify-center rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3 py-2 font-display text-[12px] font-semibold text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-border)] hover:text-[var(--color-text-primary)]"
        >
          Explore Horns
        </Link>
        <Link
          href="/vault"
          className="flex items-center justify-center rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3 py-2 font-display text-[12px] font-semibold text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-border)] hover:text-[var(--color-text-primary)]"
        >
          Horn Vault
        </Link>
      </div>

      <p className="mt-3 text-[10px] leading-4 text-[var(--color-text-subtle)]">
        {hornsLive
          ? poolHasHorn
            ? "Live skim + split for this pool shown above."
            : "Horns config live. This pool has no horn attached yet; a real per-pool readout appears once a coin graduates with a horn."
          : "Preview: this pool's live skim and split appear once the Horns config resolves."}
      </p>
    </section>
  );
}

function PoolRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-[var(--color-text-muted)]">{label}</span>
      <span className="mono text-[12px] font-semibold text-[var(--color-text-secondary)]">{value}</span>
    </div>
  );
}

function FlowRow({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
        <span className="h-2 w-2 rounded-full" style={{ background: tone }} />
        {label}
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="mono text-[12px] font-semibold text-[var(--color-text-primary)]">{value}</span>
        <span className="mono text-[10px] text-[var(--color-text-subtle)]">{sub}</span>
      </span>
    </div>
  );
}

/* ---------------- Stake / Claim (Horn Vault) ---------------- */

type StakeDenom = "uansem" | "uchanse";
type VaultAction = "stake" | "unstake";

export function HornVaultPanel({ token: _token }: { token: TokenListItem }) {
  const [denom, setDenom] = useState<StakeDenom>("uansem");
  const [action, setAction] = useState<VaultAction>("stake");
  const [amount, setAmount] = useState("");

  const label = denomLabel(denom);
  // Compact, non-interactive preview of the Horn Vault. The LIVE stake / claim
  // surface (real Sink / Stake / Pending reads + exec) is the dedicated /vault
  // page (src/app/(shell)/vault/page.tsx + src/hooks/use-vault.ts); this widget
  // is not mounted on the token page, so it stays an honest preview.
  const live = false;
  // Every figure is a dash, never a fake number.
  const rewards: Coin[] = [];
  const hasRewards = rewards.length > 0;

  return (
    <section className="rounded-xl bg-[var(--color-bg-page)] p-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 font-display text-[13px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-primary)]">
          <Lightning size={15} weight="fill" className="text-[var(--color-accent-strong)]" />
          Horn Vault
        </h3>
        <span className="rounded-[4px] border border-[var(--color-border-soft)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
          {live ? "live" : "preview"}
        </span>
      </div>

      {/* Sink stats for the selected denom: dashes until wired. */}
      <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)]">
        <VaultStat label="APR" value={DASH} accent />
        <VaultStat label="Sink TVL" value={DASH} />
        <VaultStat label="Your stake" value={DASH} />
      </div>

      {/* Denom tabs: two sinks, ANSEM (uansem) + CHANSE (uchanse) */}
      <div className="mt-4 grid grid-cols-2 gap-1 rounded-[6px] bg-[var(--color-bg-page)] p-1">
        {(["uansem", "uchanse"] as StakeDenom[]).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDenom(d)}
            className={`h-8 rounded-[4px] font-display text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors ${
              denom === d ? "bg-[var(--color-bg-hover)] text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            {denomLabel(d)}
          </button>
        ))}
      </div>

      {/* Stake / Unstake switch */}
      <div className="mt-3 flex items-center gap-3">
        {(["stake", "unstake"] as VaultAction[]).map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => setAction(a)}
            className={`pb-1 font-display text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors ${
              action === a
                ? "border-b-2 border-[var(--color-accent-solid)] text-[var(--color-text-primary)]"
                : "border-b-2 border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            }`}
          >
            {a}
          </button>
        ))}
      </div>

      {/* Amount */}
      <div className="mt-2">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="0.0"
          disabled={!live}
          className="h-10 w-full rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3 font-mono text-[14px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)] focus:border-[var(--color-border-soft)] disabled:cursor-not-allowed disabled:opacity-60"
        />
      </div>

      <button
        type="button"
        disabled={!live}
        title={live ? undefined : "Horn Vault staking goes live with the Horns program"}
        className={`mt-3 h-11 w-full rounded-[4px] font-display text-[12px] uppercase tracking-[0.12em] ${
          action === "stake" ? "btn-white" : "border border-[var(--color-border-soft)] bg-transparent text-[var(--color-text-primary)] hover:border-[var(--color-border)]"
        } ${live ? "" : "cursor-not-allowed opacity-60"}`}
      >
        {action === "stake" ? `Stake ${label}` : `Unstake ${label}`}
      </button>

      {/* Pending rewards (Coin[]) + Claim */}
      <div className="mt-3 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] p-3">
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-subtle)]">
            Pending rewards
          </p>
          <button
            type="button"
            disabled={!live || !hasRewards}
            title={live ? undefined : "Claim goes live with the Horn Vault"}
            className={`h-7 rounded-[4px] border px-3 font-display text-[10px] font-semibold uppercase tracking-[0.1em] transition-colors ${
              live && hasRewards
                ? "border-[#2f7d3f] bg-[var(--color-accent-solid)]/10 text-[var(--color-accent-strong)] hover:bg-[var(--color-accent-solid)]/15"
                : "cursor-not-allowed border-[var(--color-border-soft)] text-[var(--color-text-subtle)]"
            }`}
          >
            Claim {label}
          </button>
        </div>
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="mono text-[11px] text-[var(--color-text-muted)]">ANSEM</span>
            <span className="mono text-[13px] font-semibold text-[var(--color-text-muted)]">{DASH}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="mono text-[11px] text-[var(--color-text-muted)]">CHANSE</span>
            <span className="mono text-[13px] font-semibold text-[var(--color-text-muted)]">{DASH}</span>
          </div>
        </div>
      </div>

      <p className="mt-2 text-[10px] leading-4 text-[var(--color-text-subtle)]">
        {live
          ? "Stake ANSEM or CHANSE into this coin's Horn Vault sink to earn its skimmed swap fees. Rewards accrue per block in both denoms and are claimed independently."
          : "Preview of the live Horn Vault. Staking, sink TVL and rewards activate once the Horns program is wired in; the interface is final."}
      </p>
    </section>
  );
}

function VaultStat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-[var(--color-bg-page)]/80 px-2.5 py-2 text-center">
      <p className="text-[9px] uppercase tracking-[0.14em] text-[var(--color-text-subtle)]">{label}</p>
      <p className={`mono mt-1 text-[13px] font-semibold ${accent ? "text-[var(--color-accent-strong)]" : "text-[var(--color-text-primary)]"}`}>
        {value}
      </p>
    </div>
  );
}

// Reserved for when live contract addresses are handed over.
export const HORNS_ADDRESSES = { HORN_VAULT_ADDRESS, FEE_SHARE_ADDRESS };
