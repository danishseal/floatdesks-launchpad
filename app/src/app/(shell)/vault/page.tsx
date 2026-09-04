"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lightning, Horse } from "@phosphor-icons/react";
import { useFloorWallet } from "@/components/wallet/solana-wallet-provider";
import { ConnectButton } from "@/components/wallet/connect-button";
import { useVault, VAULT_QUERY_KEY, type VaultSink } from "@/hooks/use-vault";
import {
  stakeVault,
  unstakeVault,
  claimVault,
  toMicro,
  fromMicro,
} from "@/lib/ansem/vault-tx";
import { denomLabel, explorerUrl } from "@/lib/floorlaunch/config";

/**
 * The Horn Vault, a standalone page (moved off the token terminal). The Vault
 * has two GLOBAL sinks (ANSEM + CHANSE); every graduated pool's fee-skim flows
 * into them, and stakers of either token earn it.
 *
 * Two states, chosen by whether the ansem-horn-vault contract address is
 * configured (env NEXT_PUBLIC_HORN_VAULT_ADDRESS, or a reserved registry slot):
 *   - configured  => LIVE data from useVault (TVL / your stake / pending come
 *                    STRAIGHT from the contract; stake/unstake/claim are real
 *                    signed txs). APR stays "-" because the contract exposes no
 *                    reward-rate query; no APR is ever fabricated.
 *   - unconfigured => the honest preview below (every figure "-"), shown until
 *                     the Horns program is deployed and wired in.
 */
const DASH = "-";

type Sink = "uansem" | "uchanse";
type Action = "stake" | "unstake";
const LABEL: Record<Sink, string> = { uansem: "ANSEM", uchanse: "CHANSE" };
const SINKS: Sink[] = ["uansem", "uchanse"];

function fmt(n: number): string {
  if (!Number.isFinite(n)) return DASH;
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default function VaultPage() {
  const wallet = useFloorWallet();
  const queryClient = useQueryClient();
  const { data } = useVault(wallet.address);

  const [sink, setSink] = useState<Sink>("uansem");
  const [action, setAction] = useState<Action>("stake");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const label = LABEL[sink];

  const live = data?.configured ?? false;
  const selected: VaultSink | undefined = data?.sinks[sink];

  // Pending rewards for the selected sink, keyed by denom (micro-units).
  const rewardByDenom = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of selected?.rewards ?? []) m[c.denom] = c.amount;
    return m;
  }, [selected?.rewards]);

  const numeric = Number(amount);
  const amountValid = Number.isFinite(numeric) && numeric > 0;

  function refetch() {
    void queryClient.invalidateQueries({ queryKey: VAULT_QUERY_KEY(wallet.address) });
  }

  function txToast(hash: string, id: string, verb: string) {
    toast.success(verb, {
      id,
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
  }

  async function submit() {
    if (!wallet.address) return;
    if (!amountValid) {
      toast.error("Enter an amount greater than zero.", { id: "vault" });
      return;
    }
    setBusy(true);
    toast.loading(`Confirm the ${action} in your wallet…`, { id: "vault" });
    try {
      const client = await wallet.getSigningClient();
      const micro = toMicro(numeric);
      const hash =
        action === "stake"
          ? await stakeVault(client, wallet.address, sink, micro)
          : await unstakeVault(client, wallet.address, sink, micro);
      txToast(hash, "vault", action === "stake" ? `Staked ${label}` : `Unstaked ${label}`);
      setAmount("");
      refetch();
      void wallet.refreshBalance();
      window.setTimeout(refetch, 3000);
    } catch (e) {
      toast.error(`${action === "stake" ? "Stake" : "Unstake"} failed`, {
        id: "vault",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    if (!wallet.address) return;
    setBusy(true);
    toast.loading("Confirm the claim in your wallet…", { id: "vault-claim" });
    try {
      const client = await wallet.getSigningClient();
      const hash = await claimVault(client, wallet.address, sink);
      txToast(hash, "vault-claim", `Claimed ${label} rewards`);
      refetch();
      void wallet.refreshBalance();
      window.setTimeout(refetch, 3000);
    } catch (e) {
      toast.error("Claim failed", {
        id: "vault-claim",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  const canAct = live && wallet.connected;

  return (
    <div className="mx-auto max-w-2xl space-y-6 font-sans">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 font-display text-[24px] font-semibold tracking-tight text-[var(--color-text-primary)]">
            <Lightning size={20} weight="fill" className="text-[var(--color-accent-strong)]" />
            Horn Vault
          </h1>
          <p className="mt-1 max-w-lg text-[13px] leading-5 text-[var(--color-text-secondary)]">
            Stake ANSEM or CHANSE into the Vault to earn a cut of every graduated
            pool's swap fees. Two sinks, both denoms, rewards accrue per block.{" "}
            <Link href="/horns" className="text-[var(--color-text-primary)] underline underline-offset-4 hover:text-[var(--color-accent-strong)]">
              How Horns work
            </Link>
          </p>
        </div>
        <span className="shrink-0 rounded-[4px] border border-[var(--hairline)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
          {live ? "live" : "preview"}
        </span>
      </div>

      {/* Sink overview */}
      <div className="grid gap-3 sm:grid-cols-2">
        {SINKS.map((s) => {
          const info = data?.sinks[s];
          const tvl = live && info ? fmt(fromMicro(info.totalStaked)) : DASH;
          const yourStake =
            live && wallet.connected && info?.staked != null
              ? fmt(fromMicro(info.staked))
              : DASH;
          return (
            <button
              key={s}
              type="button"
              onClick={() => setSink(s)}
              className={`rounded-xl border bg-[var(--color-bg-surface)] p-4 text-left transition-colors ${
                sink === s ? "border-[var(--color-accent-solid)]" : "border-[var(--hairline)] hover:border-zinc-500"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-display text-[15px] font-semibold text-[var(--color-text-primary)]">{LABEL[s]} sink</span>
                <span className="rounded-[3px] bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[9px] uppercase text-[var(--color-text-muted)]">
                  {s}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Stat label="APR" value={DASH} accent />
                <Stat label="Sink TVL" value={tvl} />
                <Stat label="Your stake" value={yourStake} />
              </div>
            </button>
          );
        })}
      </div>

      {/* Stake / claim panel for the selected sink */}
      <div className="rounded-2xl border border-[var(--hairline)] bg-[var(--color-bg-surface)] p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-[15px] font-semibold text-[var(--color-text-primary)]">{label} sink</h2>
          <div className="flex items-center gap-3">
            {(["stake", "unstake"] as Action[]).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setAction(a)}
                className={`pb-1 font-display text-[12px] font-semibold uppercase tracking-[0.1em] transition-colors ${
                  action === a
                    ? "border-b-2 border-[var(--color-accent-solid)] text-[var(--color-text-primary)]"
                    : "border-b-2 border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                }`}
              >
                {a}
              </button>
            ))}
          </div>
        </div>

        <div key={`${sink}-${action}`} className="ansem-fade-in">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.0"
            disabled={!canAct}
            className="mt-4 h-11 w-full rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-raised)] px-3.5 font-mono text-[15px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)] focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
          />

          {live && !wallet.connected ? (
            <div className="mt-3">
              <ConnectButton className="h-11 w-full" label="Connect to stake" />
            </div>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canAct || busy || !amountValid}
              title={live ? undefined : "Staking activates with the Horns program"}
              className={`mt-3 h-11 w-full rounded-lg font-display text-[13px] font-semibold uppercase tracking-[0.1em] ${
                canAct && amountValid && !busy
                  ? "bg-[var(--color-accent-solid)] text-[var(--color-on-accent)] hover:opacity-90"
                  : "cursor-not-allowed bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]"
              }`}
            >
              {busy
                ? "Submitting…"
                : action === "stake"
                  ? `Stake ${label}`
                  : `Unstake ${label}`}
            </button>
          )}
        </div>

        {/* Pending rewards */}
        <div className="mt-4 rounded-xl border border-[var(--hairline)] bg-[var(--color-bg-page)] p-3.5">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-subtle)]">Pending rewards</p>
            <button
              type="button"
              onClick={claim}
              disabled={!canAct || busy}
              className={`h-7 rounded-[4px] border border-[var(--hairline)] px-3 font-display text-[10px] font-semibold uppercase tracking-[0.1em] ${
                canAct && !busy
                  ? "text-[var(--color-accent-strong)] hover:border-[var(--color-accent-solid)]"
                  : "cursor-not-allowed text-[var(--color-text-subtle)]"
              }`}
            >
              Claim {label}
            </button>
          </div>
          <div className="mt-2 space-y-1.5">
            {SINKS.map((s) => {
              const value =
                live && wallet.connected && selected?.rewards != null
                  ? fmt(fromMicro(rewardByDenom[s] ?? "0"))
                  : DASH;
              return <Reward key={s} denom={denomLabel(s)} value={value} />;
            })}
          </div>
        </div>

        <p className="mt-3 flex items-center gap-1.5 text-[11px] leading-4 text-[var(--color-text-subtle)]">
          <Horse size={12} weight="fill" className="text-[var(--color-text-subtle)]" />
          {live
            ? "APR appears here once graduated-pool fees begin flowing into the sinks; the contract exposes no reward-rate until then."
            : "Preview of the live Horn Vault. Staking, TVL and rewards activate once the Horns program is wired in. The interface is final."}
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-[0.14em] text-[var(--color-text-subtle)]">{label}</p>
      <p className={`mono mt-0.5 text-[13px] font-semibold ${accent ? "text-[var(--color-accent-strong)]" : "text-[var(--color-text-primary)]"}`}>{value}</p>
    </div>
  );
}

function Reward({ denom, value }: { denom: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="mono text-[11px] text-[var(--color-text-muted)]">{denom}</span>
      <span className="mono text-[13px] font-semibold text-[var(--color-text-secondary)]">{value}</span>
    </div>
  );
}
