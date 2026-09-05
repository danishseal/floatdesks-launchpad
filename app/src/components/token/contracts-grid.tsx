"use client";

/**
 * The contracts in play behind one token, each copyable in one click.
 *
 * The page named exactly one address before this, its own, in a row inside a
 * collapsed panel. Everything a trade actually goes through, the fSHARE it is
 * priced in and the two v4 pools it routes across, was unnamed on screen, so
 * there was no way to take one of those addresses anywhere else from here.
 *
 * Seamless grid: the cells sit on a hairline-coloured surface with a 1px gap,
 * so the dividers ARE the gaps and the block reads as one object rather than
 * six floating cards. That matches the token page's own language, which groups
 * with dividers and never with whitespace.
 */

import { useState } from "react";
import { Check, CopySimple } from "@phosphor-icons/react";
import { useTokenContracts, type ContractEntry } from "@/hooks/use-token-contracts";

const KIND_LABEL: Record<ContractEntry["kind"], string> = {
  token: "Token",
  fshare: "fShare",
  pool: "Pool",
  launcher: "Launcher",
  "pool-manager": "PoolManager",
};

export function ContractsGrid({ address }: { address: string }) {
  const { data, isLoading, error } = useTokenContracts(address);

  if (isLoading) {
    return (
      <Shell>
        <div className="grid grid-cols-2 gap-px bg-[var(--color-border-soft)]">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-[52px] animate-pulse bg-[var(--color-bg-page)]" />
          ))}
        </div>
      </Shell>
    );
  }

  if (error || !data) {
    // Say which read failed. "No contracts" would be a claim we cannot make:
    // an unreachable RPC and a token with no pools are not the same answer.
    return (
      <Shell>
        <p className="px-1 py-3 text-[11px] leading-4 text-[var(--color-text-muted)]">
          Could not read this token&apos;s contracts.{" "}
          <span className="text-[var(--color-text-subtle)]">
            {error instanceof Error ? error.message : "Unknown error"}
          </span>
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-[var(--color-border-soft)]">
        {data.entries.map((entry) => (
          <ContractCell key={`${entry.kind}-${entry.value}`} entry={entry} />
        ))}
      </div>
      {data.unreadable.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {data.unreadable.map((reason) => (
            <li key={reason} className="text-[10px] leading-3 text-[var(--color-text-subtle)]">
              {reason}
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-[var(--color-bg-page)] px-3 pb-3 pt-3">
      <h2 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">Contracts</h2>
      {children}
    </section>
  );
}

function ContractCell({ entry }: { entry: ContractEntry }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(entry.value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={`${entry.label}\n${entry.value}`}
      aria-label={`Copy ${entry.label} ${entry.kind === "pool" ? "pool id" : "address"} ${entry.value}`}
      className="group flex min-w-0 flex-col items-start gap-0.5 bg-[var(--color-bg-page)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--color-bg-raised)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-text-primary)]"
    >
      <span className="flex w-full min-w-0 items-baseline gap-1">
        <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-subtle)]">
          {KIND_LABEL[entry.kind]}
        </span>
        {entry.note && (
          <span className="min-w-0 truncate text-[9px] text-[var(--color-text-subtle)]">
            {entry.note}
          </span>
        )}
      </span>
      <span className="w-full truncate text-[11px] font-semibold leading-4 text-[var(--color-text-primary)]">
        {entry.label}
      </span>
      <span className="flex w-full min-w-0 items-center gap-1">
        <span className="min-w-0 truncate text-[11px] leading-4 tabular-nums text-[var(--color-text-muted)] group-hover:text-[var(--color-text-secondary)]">
          {short(entry.value)}
        </span>
        {copied ? (
          <Check size={12} weight="bold" className="shrink-0 text-[var(--color-positive)]" />
        ) : (
          <CopySimple
            size={12}
            className="shrink-0 text-[var(--color-text-subtle)] transition-colors group-hover:text-[var(--color-text-secondary)]"
          />
        )}
      </span>
    </button>
  );
}

/** Pool ids are 32 bytes, addresses 20, so both need the middle taken out. */
function short(value: string): string {
  return value.length > 16 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}
