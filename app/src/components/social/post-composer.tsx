"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Image as ImageIcon, X, MagnifyingGlass, CurrencyCircleDollar } from "@phosphor-icons/react";
import { useFloorWallet } from "@/components/wallet/solana-wallet-provider";
import { addPost, useProfile, type Post } from "@/lib/social";
import { useTokens } from "@/hooks/use-tokens";
import type { TokenListItem } from "@/lib/api";
import {
  Avatar,
  downscaleImage,
  errMsg,
  short,
  ago,
  usdCompact,
  capUsd,
  useToken,
} from "@/components/social/shared";

const MAX = 1000;
type Wallet = ReturnType<typeof useFloorWallet>;

/**
 * Twitter-style composer: line-divided (a section closed by a bottom hairline),
 * not a bordered box. Supports an inline image, a token-preview attachment, and
 * an optional quote of another post.
 */
export function PostComposer({
  wallet,
  onPosted,
  quoteOf,
  onCancel,
  autoFocus,
  placeholder = "What's happening?",
  compact,
}: {
  wallet: Wallet;
  onPosted: () => Promise<void> | void;
  quoteOf?: Post;
  onCancel?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  compact?: boolean;
}) {
  const me = useProfile(wallet.address ?? "");
  const [text, setText] = useState("");
  const [image, setImage] = useState<string | undefined>();
  const [token, setToken] = useState<string | undefined>();
  const [imgBusy, setImgBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const trimmed = text.trim();
  const over = text.length > MAX;
  const empty = !trimmed && !image && !token;
  const canPost = Boolean(wallet.address) && !empty && !over && !busy;

  async function onFile(file: File | undefined) {
    if (!file) return;
    setImgBusy(true);
    try {
      setImage(await downscaleImage(file, { maxEdge: 1400 }));
    } catch (e) {
      toast.error("Couldn't use that image", { description: errMsg(e) });
    } finally {
      setImgBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function submit() {
    if (!canPost || !wallet.address) return;
    setBusy(true);
    try {
      await addPost(wallet.address, trimmed, wallet, {
        image,
        token,
        quoteOf: quoteOf?.id,
      });
      setText("");
      setImage(undefined);
      setToken(undefined);
      await onPosted();
      onCancel?.();
    } catch (e) {
      toast.error("Could not post", { description: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!wallet.address) {
    return (
      <div className="flex flex-col items-center gap-3 border-b border-[var(--hairline)] px-4 py-8 text-center">
        <p className="font-sans text-[14px] text-[var(--color-text-secondary)]">
          Connect your wallet to post to the feed.
        </p>
        <button
          type="button"
          onClick={() => void wallet.connect()}
          disabled={wallet.connecting}
          className="h-9 rounded-lg bg-[var(--color-accent-solid)] px-4 font-sans text-[13px] font-semibold text-[var(--color-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {wallet.connecting ? "Connecting…" : "Connect to post"}
        </button>
      </div>
    );
  }

  return (
    <div className={`border-b border-[var(--hairline)] ${compact ? "py-2" : "py-3"}`}>
      <div className="flex gap-3">
        <Avatar src={me.data?.avatar} className="mt-0.5 h-10 w-10" iconSize={20} />
        <div className="min-w-0 flex-1">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            rows={quoteOf ? 2 : 2}
            maxLength={MAX + 200}
            disabled={busy}
            autoFocus={autoFocus}
            aria-label="Compose a post"
            className="w-full resize-none bg-transparent text-[15px] leading-6 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)]"
          />

          {/* Quoted post embed (quote mode) */}
          {quoteOf && <QuotedEmbed post={quoteOf} />}

          {/* Image preview */}
          {image && (
            <div className="relative mt-2 w-fit">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image}
                alt=""
                className="max-h-[280px] rounded-xl border border-[var(--hairline)] object-cover"
              />
              <button
                type="button"
                onClick={() => setImage(undefined)}
                aria-label="Remove image"
                className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-[var(--color-text-primary)] hover:bg-black"
              >
                <X size={14} weight="bold" />
              </button>
            </div>
          )}

          {/* Token chip */}
          {token && <TokenChip address={token} onRemove={() => setToken(undefined)} />}

          {/* Token picker */}
          {pickerOpen && (
            <TokenPicker
              onPick={(t) => {
                setToken(t.address);
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}

          {/* Toolbar */}
          <div className="mt-2 flex items-center justify-between border-t border-[var(--hairline)] pt-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={imgBusy || busy}
                aria-label="Add image"
                title="Add image"
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-accent-strong)] transition-colors hover:bg-[var(--color-accent-solid)]/10 disabled:opacity-50"
              >
                <ImageIcon size={18} weight="regular" />
              </button>
              <button
                type="button"
                onClick={() => setPickerOpen((o) => !o)}
                disabled={busy}
                aria-label="Add token"
                title="Add token"
                className={`flex h-8 items-center gap-1 rounded-full px-2 text-[12px] font-medium transition-colors hover:bg-[var(--color-accent-solid)]/10 disabled:opacity-50 ${
                  pickerOpen ? "text-[var(--color-text-primary)]" : "text-[var(--color-accent-strong)]"
                }`}
              >
                <CurrencyCircleDollar size={18} weight="regular" /> Token
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
              {imgBusy && <span className="font-mono text-[11px] text-[var(--color-text-muted)]">Processing…</span>}
            </div>

            <div className="flex items-center gap-3">
              <span
                className={`font-mono text-[11px] tabular-nums ${
                  over
                    ? "text-[var(--color-negative)]"
                    : text.length > MAX - 100
                      ? "text-[var(--color-text-secondary)]"
                      : "text-[var(--color-text-subtle)]"
                }`}
              >
                {text.length}/{MAX}
              </span>
              {onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  className="h-8 rounded-lg px-3 font-sans text-[13px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canPost}
                className="h-8 rounded-full bg-[var(--color-accent-solid)] px-4 font-sans text-[13px] font-semibold text-[var(--color-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {busy ? "Signing…" : quoteOf ? "Quote" : "Post"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- token chip (selected attachment) ---------------- */

function TokenChip({ address, onRemove }: { address: string; onRemove: () => void }) {
  const token = useToken(address);
  return (
    <div className="mt-2 flex items-center gap-2.5 rounded-xl border border-[var(--hairline)] bg-[var(--color-bg-page)] px-3 py-2">
      <div className="h-8 w-8 shrink-0 overflow-hidden rounded-md border border-[var(--hairline)] bg-[var(--color-bg-raised)]">
        {token?.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={token.image} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full items-center justify-center font-mono text-[11px] text-[var(--color-text-subtle)]">
            {token?.symbol?.slice(0, 1) ?? "?"}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <span className="truncate font-display text-[13px] font-semibold text-[var(--color-accent-strong)]">
          ${token?.symbol ?? short(address)}
        </span>
        {token?.name && (
          <span className="ml-1.5 truncate font-sans text-[12px] text-[var(--color-text-muted)]">{token.name}</span>
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove token"
        className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--color-text-muted)] hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-text-primary)]"
      >
        <X size={13} weight="bold" />
      </button>
    </div>
  );
}

/* ---------------- token picker ---------------- */

function TokenPicker({
  onPick,
  onClose,
}: {
  onPick: (t: TokenListItem) => void;
  onClose: () => void;
}) {
  const { data: tokens } = useTokens();
  const [q, setQ] = useState("");

  const results = useMemo(() => {
    const list = tokens ?? [];
    const query = q.trim().toLowerCase();
    const base = query
      ? list.filter(
          (t) =>
            (t.symbol ?? "").toLowerCase().includes(query) ||
            (t.name ?? "").toLowerCase().includes(query) ||
            t.address.toLowerCase().includes(query),
        )
      : [...list].sort((a, b) => capUsd(b) - capUsd(a));
    return base.slice(0, 8);
  }, [tokens, q]);

  return (
    <div className="ansem-fade-in mt-2 overflow-hidden rounded-xl border border-[var(--hairline)] bg-[var(--color-bg-page)]">
      <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-3 py-2">
        <MagnifyingGlass size={14} className="text-[var(--color-text-muted)]" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a coin by name, ticker, or address"
          className="h-6 flex-1 bg-transparent font-sans text-[13px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)]"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close token picker"
          className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          <X size={14} weight="bold" />
        </button>
      </div>
      <ul className="max-h-[240px] overflow-y-auto">
        {results.length === 0 ? (
          <li className="px-3 py-4 text-center font-sans text-[12px] text-[var(--color-text-subtle)]">No coins found.</li>
        ) : (
          results.map((t) => (
            <li key={t.address}>
              <button
                type="button"
                onClick={() => onPick(t)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--color-bg-raised)]"
              >
                <div className="h-8 w-8 shrink-0 overflow-hidden rounded-md border border-[var(--hairline)] bg-[var(--color-bg-raised)]">
                  {t.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={t.image} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full items-center justify-center font-mono text-[11px] text-[var(--color-text-subtle)]">
                      {t.symbol?.slice(0, 1)}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-display text-[13px] font-semibold text-[var(--color-accent-strong)]">
                      ${t.symbol}
                    </span>
                    <span className="truncate font-sans text-[12px] text-[var(--color-text-muted)]">{t.name}</span>
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-[var(--color-text-secondary)]">
                  {usdCompact(capUsd(t))}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/* ---------------- quoted embed (inside composer) ---------------- */

function QuotedEmbed({ post }: { post: Post }) {
  const profile = useProfile(post.author);
  const p = profile.data ?? {};
  const name = p.displayName || (p.username ? `@${p.username}` : short(post.author));
  return (
    <div className="mt-2 rounded-xl border border-[var(--hairline)] bg-[var(--color-bg-page)] p-3">
      <div className="flex items-center gap-1.5">
        <Avatar src={p.avatar} className="h-5 w-5" iconSize={11} />
        <span className="truncate font-sans text-[13px] font-semibold text-[var(--color-text-primary)]">{name}</span>
        <span className="text-[12px] text-[var(--color-text-subtle)]">·</span>
        <span className="font-mono text-[12px] text-[var(--color-text-subtle)]">{ago(post.createdAt)}</span>
      </div>
      {post.text && (
        <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words font-sans text-[13px] leading-5 text-[var(--color-text-secondary)]">
          {post.text}
        </p>
      )}
    </div>
  );
}
