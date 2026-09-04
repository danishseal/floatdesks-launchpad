"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CircleNotch,
  Coins,
  Globe,
  LockSimple,
  Plus,
  TelegramLogo,
  X,
  XLogo,
} from "@phosphor-icons/react";
import { useFloorWallet } from "@/components/wallet/solana-wallet-provider";
import { useTokenProposals, TOKEN_PROPOSALS_QUERY_KEY } from "@/hooks/use-token-proposals";
import { useTokenDetail } from "@/hooks/use-token-detail";
import { useTokenMeta, effectiveTeamLaunch } from "@/lib/token-meta";
import {
  submitTokenProposal,
  castTokenProposalVote,
  encodeProposalMemo,
  TOKEN_CATEGORY,
  type TokenProposal,
} from "@/lib/ansem/proposals";
import type { TokenListItem } from "@/lib/api";
import { explorerUrl } from "@/lib/floorlaunch/config";

const MEMO_LIMIT = 2048;

export function TokenProposals({ token }: { token: string }) {
  const wallet = useFloorWallet();
  const viewer = wallet.address ?? undefined;
  const { data, isLoading, error, refetch } = useTokenProposals(token, viewer);
  const { data: detail } = useTokenDetail(token);
  const { data: meta } = useTokenMeta(token);
  const [creating, setCreating] = useState(false);

  const proposals = data ?? [];
  // A team-launch flag only counts when the token's real creator set it.
  const teamLaunch = effectiveTeamLaunch(meta, detail?.creator);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-4 py-2.5">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-[var(--color-text-primary)]">Token proposals</p>
          <p className="truncate text-[11px] text-[var(--color-text-muted)]">
            On-chain governance for this token, category{" "}
            <span className="font-mono text-[var(--color-accent-strong)]">token</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-accent-solid)] px-3 text-[12px] font-bold text-[var(--color-on-accent)] transition hover:bg-[var(--color-accent-strong)]"
        >
          <Plus size={14} weight="bold" />
          New proposal
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <CurrentStatePanel token={detail} teamLaunch={teamLaunch} />

        {isLoading ? (
          <PanelMessage>
            <CircleNotch size={16} className="animate-spin text-[var(--color-text-muted)]" />
            Loading proposals from the chain…
          </PanelMessage>
        ) : error ? (
          <PanelMessage>
            Could not reach the governance treasury.{" "}
            <button
              type="button"
              onClick={() => refetch()}
              className="font-semibold text-[var(--color-accent-strong)] hover:underline"
            >
              Retry
            </button>
          </PanelMessage>
        ) : proposals.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-3">
            {proposals.map((p) => (
              <ProposalCard key={p.id} token={token} proposal={p} viewer={viewer} />
            ))}
          </div>
        )}
      </div>

      {creating ? (
        <CreateProposalModal
          token={token}
          teamLaunch={teamLaunch}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center py-6 text-center">
      <div>
        <p className="text-[14px] font-semibold text-[var(--color-text-primary)]">No token proposals yet</p>
        <p className="mt-1 max-w-xs text-[12px] text-[var(--color-text-muted)]">
          Open the first governance proposal with New proposal above. Holders vote
          on-chain, tallied live from the treasury.
        </p>
      </div>
    </div>
  );
}

// ── current state: the baseline a proposal would change ──────────────────────
function CurrentStatePanel({
  token,
  teamLaunch,
}: {
  token: TokenListItem | undefined;
  teamLaunch: boolean;
}) {
  if (!token) return null;

  const name = token.name?.trim() || "-";
  const symbol = token.symbol?.trim();
  const baseLabel = token.base_label || "-";
  const description = token.description?.trim();
  const creator = token.creator || token.listing?.launchedBy || "";
  const priceBase = Number(token.current_price) / 1e6;
  const priceStr =
    Number.isFinite(priceBase) && priceBase > 0
      ? `${priceBase.toLocaleString(undefined, { maximumSignificantDigits: 6 })} ${token.base_label}`
      : "-";

  // Only the links actually present on the listing (indexer gives none for most,
  // so absent rows are simply omitted rather than shown as dead icons).
  const links = token.listing?.links ?? {};
  const site = links.site ?? links.website;
  const x = links.x ?? links.twitter;
  const tg = links.telegram ?? links.tg;
  const hasLinks = Boolean(site || x || tg);

  return (
    <div className="mb-3 rounded-[10px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] p-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
        Current state
      </p>

      <div className="mt-2.5 flex items-center gap-3">
        {token.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={token.image}
            alt={name}
            className="h-11 w-11 shrink-0 rounded-[9px] object-cover"
          />
        ) : (
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[9px] bg-[var(--color-bg-page)] text-[var(--color-text-subtle)]">
            <Coins size={20} />
          </div>
        )}
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[14px] font-bold text-[var(--color-text-primary)]">{name}</span>
            {symbol ? (
              <span className="shrink-0 font-mono text-[11px] text-[var(--color-accent-strong)]">${symbol}</span>
            ) : null}
          </div>
          {teamLaunch ? (
            <span className="mt-1 inline-flex items-center gap-1 rounded bg-[var(--color-accent-solid)]/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[var(--color-accent-strong)]">
              <LockSimple size={9} weight="fill" /> Team launch
            </span>
          ) : null}
        </div>
      </div>

      {description ? (
        <p className="mt-2.5 line-clamp-3 whitespace-pre-wrap text-[11.5px] leading-[16px] text-[var(--color-text-secondary)]">
          {description}
        </p>
      ) : null}

      <div className="mt-2.5 flex flex-col gap-1.5 border-t border-[var(--color-border-soft)] pt-2.5">
        <StateRow label="Trades in" value={baseLabel} />
        <StateRow label="Price" value={priceStr} mono />
        <StateRow label="Creator" value={creator ? short(creator) : "-"} mono />
      </div>

      {hasLinks ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {site ? <LinkChip href={site} icon={<Globe size={12} />} label="Site" /> : null}
          {x ? <LinkChip href={x} icon={<XLogo size={12} weight="bold" />} label="X" /> : null}
          {tg ? <LinkChip href={tg} icon={<TelegramLogo size={12} weight="fill" />} label="Telegram" /> : null}
        </div>
      ) : null}
    </div>
  );
}

function StateRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11.5px]">
      <span className="shrink-0 text-[var(--color-text-muted)]">{label}</span>
      <span
        className={`truncate text-right text-[var(--color-text-secondary)] ${mono ? "font-mono tabular-nums" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

function LinkChip({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)] transition hover:border-[#2a3a2e] hover:text-[var(--color-accent-strong)]"
    >
      {icon}
      {label}
    </a>
  );
}

function ProposalCard({
  token,
  proposal,
  viewer,
}: {
  token: string;
  proposal: TokenProposal;
  viewer?: string;
}) {
  const wallet = useFloorWallet();
  const queryClient = useQueryClient();
  const [voting, setVoting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const leader = useMemo(() => {
    let best = -1;
    let bestIdx = -1;
    proposal.optionCounts.forEach((c, i) => {
      if (c > best) {
        best = c;
        bestIdx = i;
      }
    });
    return proposal.totalVotes > 0 ? bestIdx : -1;
  }, [proposal]);

  async function vote(optionIndex: number) {
    if (!wallet.connected || !wallet.address) {
      try {
        await wallet.connect();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      return;
    }
    setError(null);
    setVoting(optionIndex);
    try {
      const client = await wallet.getSigningClient();
      const choice: "yes" | "no" | number = proposal.binary
        ? optionIndex === 0
          ? "yes"
          : "no"
        : optionIndex;
      await castTokenProposalVote(client, wallet.address, proposal.id, choice);
      // Give the block time to commit, then refresh the tally from chain.
      window.setTimeout(() => {
        void queryClient.invalidateQueries({
          queryKey: TOKEN_PROPOSALS_QUERY_KEY(token, viewer),
        });
      }, 6000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVoting(null);
    }
  }

  return (
    <div className="rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[var(--color-accent-strong)]">
              {proposal.category || TOKEN_CATEGORY}
            </span>
            <span className="rounded border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              {proposal.binary ? "Yes / No" : `${proposal.optionLabels.length} options`}
            </span>
          </div>
          <p className="mt-1.5 text-[14px] font-bold leading-tight text-[var(--color-text-primary)]">
            {proposal.title}
          </p>
        </div>
        <a
          href={explorerUrl("tx", proposal.id)}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 font-mono text-[10px] text-[var(--color-text-subtle)] hover:text-[var(--color-accent-strong)]"
          title="View proposal tx"
        >
          {proposal.id.slice(0, 6)}…
        </a>
      </div>

      {proposal.description ? (
        <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-[17px] text-[var(--color-text-secondary)]">
          {proposal.description}
        </p>
      ) : null}

      <div className="mt-3 flex flex-col gap-1.5">
        {proposal.optionLabels.map((label, i) => {
          const count = proposal.optionCounts[i] ?? 0;
          const pct =
            proposal.totalVotes > 0 ? (count / proposal.totalVotes) * 100 : 0;
          const chosen = proposal.yourChoice === i;
          const isLeader = leader === i;
          return (
            <button
              key={`${label}-${i}`}
              type="button"
              disabled={voting !== null}
              onClick={() => vote(i)}
              className="group relative overflow-hidden rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3 py-2 text-left transition hover:border-[#2a3a2e] disabled:cursor-wait"
            >
              <span
                className={`absolute inset-y-0 left-0 transition-[width] duration-500 ${
                  isLeader ? "bg-[var(--color-accent-solid)]/15" : "bg-[var(--color-bg-surface)]/[0.04]"
                }`}
                style={{ width: `${Math.max(pct, count > 0 ? 4 : 0)}%` }}
                aria-hidden
              />
              <span className="relative flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  {voting === i ? (
                    <CircleNotch size={13} className="shrink-0 animate-spin text-[var(--color-accent-strong)]" />
                  ) : null}
                  <span
                    className={`truncate text-[12.5px] font-semibold ${
                      chosen ? "text-[var(--color-accent-strong)]" : "text-[var(--color-text-primary)]"
                    }`}
                  >
                    {label}
                  </span>
                  {chosen ? (
                    <span className="shrink-0 rounded bg-[var(--color-accent-solid)]/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-[var(--color-accent-strong)]">
                      Your vote
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-[11px] font-semibold tabular-nums text-[var(--color-text-muted)]">
                  {count} · {pct.toFixed(0)}%
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-2.5 flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
        <span>
          {proposal.totalVotes} vote{proposal.totalVotes === 1 ? "" : "s"} ·{" "}
          {relativeTime(proposal.timestamp)}
        </span>
        <span className="font-mono">by {short(proposal.proposer)}</span>
      </div>

      {error ? <p className="mt-2 text-[11px] text-[#f87171]">{error}</p> : null}
      {!wallet.connected ? (
        <p className="mt-2 text-[11px] text-[var(--color-text-subtle)]">
          Connect a wallet to vote. Each vote is 1 CHANSE to the treasury (anti-spam).
        </p>
      ) : null}
    </div>
  );
}

// Proposal categories shown in the create flow. `metadata` is the one gated off
// for team launches; the rest stay available. The chosen category is tagged into
// the on-chain proposal (see `decorateDescription`) so voters see what it targets.
const KINDS = [
  { key: "metadata", label: "Metadata", hint: "Name, image, links" },
  { key: "params", label: "Parameters", hint: "Fees, venue settings" },
  { key: "general", label: "General", hint: "Anything else" },
] as const;
type Kind = (typeof KINDS)[number]["key"];

function CreateProposalModal({
  token,
  teamLaunch,
  onClose,
}: {
  token: string;
  teamLaunch: boolean;
  onClose: () => void;
}) {
  const wallet = useFloorWallet();
  const queryClient = useQueryClient();
  const viewer = wallet.address ?? undefined;
  const { data: detail } = useTokenDetail(token);

  // Default away from the gated category when this is a team launch.
  const [kind, setKind] = useState<Kind>(teamLaunch ? "general" : "metadata");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [proposedFee, setProposedFee] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Current on-chain trade fee, if the token/pool data exposes it. Never
  // fabricated: absent data renders "-" and encodes "-" into the memo.
  const currentFeePct = useMemo(() => feePctFromToken(detail), [detail]);
  const currentFeeStr = currentFeePct != null ? `${trimNum(currentFeePct)}%` : "-";

  const feeTrimmed = proposedFee.trim();
  const feeNum = Number(feeTrimmed);
  const feeEntered = feeTrimmed.length > 0;
  const feeValid =
    kind !== "params" ||
    !feeEntered ||
    (Number.isFinite(feeNum) && feeNum >= 0 && feeNum <= 100);

  // For a Parameters/fee proposal, record "current X -> proposed Y%" so voters
  // read exactly what would change. Only emitted when a fee is actually typed.
  const feeSummary =
    kind === "params" && feeEntered && feeValid
      ? `Fee change: current ${currentFeeStr} -> proposed ${trimNum(feeNum)}%`
      : null;

  // Compose the on-chain description: fee summary (params only) + the author's
  // text, prefixed with the category tag so the choice persists for voters.
  // "General" carries no tag.
  const buildDescription = (desc: string): string => {
    let body = desc;
    if (feeSummary) body = body.trim() ? `${feeSummary}\n\n${body}` : feeSummary;
    if (kind === "general") return body;
    const label = KINDS.find((k) => k.key === kind)?.label ?? "";
    return `[${label}] ${body}`;
  };

  const memoBytes = useMemo(() => {
    const memo = encodeProposalMemo(
      title.trim() || " ",
      buildDescription(description.trim() || " "),
      undefined,
      TOKEN_CATEGORY,
      token,
    );
    return new TextEncoder().encode(memo).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, kind, token, feeSummary]);

  const overLimit = memoBytes > MEMO_LIMIT;

  const canSubmit =
    !!wallet.address &&
    !submitting &&
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    feeValid &&
    !(kind === "metadata" && teamLaunch) &&
    !overLimit;

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      // Guard: metadata governance is off for team launches.
      if (kind === "metadata" && teamLaunch) {
        throw new Error("Metadata changes are disabled for team launches.");
      }
      const client = await wallet.getSigningClient();
      const hash = await submitTokenProposal(client, wallet.address!, token, {
        title: title.trim(),
        description: buildDescription(description.trim()),
        options: undefined,
      });
      setTxHash(hash);
      window.setTimeout(() => {
        void queryClient.invalidateQueries({
          queryKey: TOKEN_PROPOSALS_QUERY_KEY(token, viewer),
        });
      }, 6000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-[500px] overflow-y-auto rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {detail?.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={detail.image}
                alt={detail.name ?? "token"}
                className="h-10 w-10 shrink-0 rounded-[9px] object-cover"
              />
            ) : detail ? (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[9px] bg-[var(--color-bg-page)] text-[var(--color-text-subtle)]">
                <Coins size={18} />
              </div>
            ) : null}
            <div className="min-w-0">
              <h2 className="text-[18px] font-bold text-[var(--color-text-primary)]">New token proposal</h2>
              <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-text-muted)]">
                category token · {short(token)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-[var(--color-text-muted)] transition hover:bg-[var(--color-bg-surface)]/10 hover:text-[var(--color-text-primary)]"
          >
            <X size={18} weight="bold" />
          </button>
        </div>

        {txHash ? (
          <div className="mt-5 rounded-xl border border-[var(--color-accent-solid)]/30 bg-[var(--color-accent-solid)]/10 p-5 text-center">
            <p className="text-[15px] font-semibold text-[var(--color-accent-strong)]">Proposal submitted.</p>
            <a
              href={explorerUrl("tx", txHash)}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block break-all font-mono text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent-strong)]"
            >
              {txHash}
            </a>
            <p className="mt-2 text-[12px] text-[var(--color-text-secondary)]">
              It joins this token&apos;s list within a few seconds, once the block
              commits and the treasury tx is indexed.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 h-10 rounded-lg bg-[var(--color-accent-solid)] px-6 text-[13px] font-bold text-[var(--color-on-accent)]"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <label className="mt-4 block text-[12px] font-semibold text-[var(--color-text-secondary)]">Category</label>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              {KINDS.map((k) => {
                const disabled = k.key === "metadata" && teamLaunch;
                const active = kind === k.key && !disabled;
                return (
                  <button
                    key={k.key}
                    type="button"
                    disabled={disabled}
                    title={disabled ? "Disabled for team launches" : k.hint}
                    onClick={() => setKind(k.key)}
                    className={`rounded-lg px-2 py-2 text-left transition ${
                      active
                        ? "bg-[var(--color-accent-solid)] text-[var(--color-on-accent)]"
                        : disabled
                          ? "cursor-not-allowed border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] text-[var(--color-text-subtle)] opacity-60"
                          : "border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                    }`}
                  >
                    <span className="block text-[12px] font-semibold">{k.label}</span>
                    <span
                      className={`mt-0.5 block text-[10px] leading-tight ${
                        active ? "text-[var(--color-on-accent)]/60" : "text-[var(--color-text-muted)]"
                      }`}
                    >
                      {k.hint}
                    </span>
                  </button>
                );
              })}
            </div>
            {teamLaunch ? (
              <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
                Metadata changes are disabled for team launches.
              </p>
            ) : null}

            <label className="mt-4 block text-[12px] font-semibold text-[var(--color-text-secondary)]">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What are we deciding for this token?"
              className="mt-1.5 h-10 w-full rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3 text-[13px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)] focus:border-[var(--color-accent-solid)]"
            />

            <label className="mt-3 block text-[12px] font-semibold text-[var(--color-text-secondary)]">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Add the context voters need."
              className="mt-1.5 w-full resize-none rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3 py-2.5 text-[13px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)] focus:border-[var(--color-accent-solid)]"
            />

            {kind === "params" ? (
              <div className="mt-3 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] p-3">
                <p className="text-[11px] font-semibold text-[var(--color-text-secondary)]">Trade fee</p>
                <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                  Propose a specific fee. Voters see the exact change.
                </p>
                <div className="mt-2.5 grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-medium text-[var(--color-text-muted)]">
                      Current fee
                    </label>
                    <div className="mt-1.5 flex h-10 items-center rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3 text-[13px] font-semibold tabular-nums text-[var(--color-text-secondary)]">
                      {currentFeeStr}
                    </div>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-[var(--color-text-muted)]">
                      Proposed fee (%)
                    </label>
                    <input
                      value={proposedFee}
                      onChange={(e) => setProposedFee(e.target.value)}
                      inputMode="decimal"
                      placeholder="e.g. 3.5"
                      className="mt-1.5 h-10 w-full rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3 text-[13px] tabular-nums text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)] focus:border-[var(--color-accent-solid)]"
                    />
                  </div>
                </div>
                {feeEntered && !feeValid ? (
                  <p className="mt-2 text-[11px] text-[#f87171]">
                    Enter a fee between 0 and 100 percent.
                  </p>
                ) : feeSummary ? (
                  <p className="mt-2 text-[11px] text-[var(--color-text-secondary)]">
                    Recorded in the proposal: {feeSummary}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="mt-3 flex items-center justify-between text-[11px]">
              <span className={overLimit ? "font-semibold text-[#f87171]" : "text-[var(--color-text-subtle)]"}>
                Memo {memoBytes}/{MEMO_LIMIT} bytes
              </span>
              <span className="text-[var(--color-text-subtle)]">Costs 1 CHANSE to the treasury (anti-spam)</span>
            </div>

            {error ? <p className="mt-2 text-[12px] text-[#f87171]">{error}</p> : null}

            <div className="mt-4">
              {!wallet.address ? (
                <button
                  type="button"
                  disabled={wallet.connecting}
                  onClick={() => wallet.connect()}
                  className="h-10 w-full rounded-lg bg-[var(--color-bg-surface)] text-[13px] font-bold text-[var(--color-on-accent)] disabled:opacity-60"
                >
                  {wallet.connecting ? "Connecting…" : "Connect wallet"}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!canSubmit}
                  onClick={submit}
                  className="h-10 w-full rounded-lg bg-[var(--color-accent-solid)] text-[13px] font-bold text-[var(--color-on-accent)] transition hover:bg-[var(--color-accent-strong)] disabled:opacity-40"
                >
                  {submitting ? "Signing…" : "Submit proposal"}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Read the current trade fee as a percent from whatever the token/pool object
// exposes, checking the field names the indexer might carry. Fees are stored in
// bps on-chain (amm_fee_bps / curve_fee_bps), so a bps field is divided by 100;
// a percent field is taken as-is. Returns null when nothing real is available so
// the UI shows "-" rather than a fabricated number.
function feePctFromToken(token: TokenListItem | undefined): number | null {
  if (!token) return null;
  const rec = token as unknown as Record<string, unknown>;
  const num = (key: string): number | null => {
    const v = rec[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
    return null;
  };
  const graduated = token.graduated || token.market?.venue === "amm";
  const bpsKeys = graduated
    ? ["augmented_fee_bps", "amm_fee_bps", "fee_bps"]
    : ["augmented_fee_bps", "curve_fee_bps", "fee_bps"];
  for (const key of bpsKeys) {
    const v = num(key);
    if (v != null) return v / 100;
  }
  for (const key of ["fee_pct", "fee_percent"]) {
    const v = num(key);
    if (v != null) return v;
  }
  return null;
}

// Trim trailing zeros from a fee number for a clean "3.5" / "1" display.
function trimNum(n: number): string {
  return Number(n.toFixed(4)).toString();
}

function PanelMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-36 items-center justify-center gap-2 px-6 text-center text-sm text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}

function short(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function relativeTime(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
