"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ChatCircle,
  Repeat,
  Heart,
  ShareNetwork,
  Quotes,
} from "@phosphor-icons/react";
import { useFloorWallet } from "@/components/wallet/solana-wallet-provider";
import {
  useProfile,
  useLikePost,
  useRepostPost,
  usePostReplies,
  addPostReply,
  type Post,
} from "@/lib/social";
import { Avatar, short, ago, errMsg, TokenPreviewBanner, PostIdentity } from "@/components/social/shared";
import { PostComposer } from "@/components/social/post-composer";
import { RichText } from "@/components/social/rich-text";

const REPLY_MAX = 500;
type Wallet = ReturnType<typeof useFloorWallet>;

/**
 * Twitter/X-style post row. NOT a bordered card: rows are separated by a hairline
 * bottom border by the list that renders them. Header inline, then body, then any
 * image / token preview / quoted embed, then the action row.
 */
export function PostCard({
  post,
  wallet,
  onChanged,
  expanded = false,
}: {
  post: Post;
  wallet: Wallet;
  onChanged?: () => Promise<void> | void;
  /** Detail-view rendering: larger body, full reply thread always open, and the
   *  card itself does NOT navigate (it IS the isolated view). */
  expanded?: boolean;
}) {
  const profile = useProfile(post.author);
  const qc = useQueryClient();
  const router = useRouter();
  const p = profile.data ?? {};
  const name = p.displayName || (p.username ? `@${p.username}` : short(post.author));

  const likeM = useLikePost(wallet.address);
  const repostM = useRepostPost(wallet.address);
  const [showReplies, setShowReplies] = useState(false);
  const [repostMenu, setRepostMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const replyRef = useRef<HTMLDivElement>(null);
  const repostRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Open the repost menu as a body-level portal anchored under the trigger. A
  // portal is required because sibling post cards create stacking contexts (via
  // ansem-fade-in), which trap an in-card absolute dropdown behind the next card
  // so clicks land on the post below. At the body root nothing can cover it.
  function openRepostMenu() {
    if (repostMenu) {
      setRepostMenu(false);
      return;
    }
    const r = repostRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ top: r.bottom + 4, left: r.left });
    setRepostMenu(true);
  }

  // Close on an outside click (checking both the trigger and the portal menu) and
  // on scroll, since the fixed position would otherwise go stale.
  useEffect(() => {
    if (!repostMenu) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (repostRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setRepostMenu(false);
    }
    function onScroll() {
      setRepostMenu(false);
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [repostMenu]);

  // In the detail view the thread is permanently open; in the feed the reply
  // button toggles a quick-peek panel (unchanged behaviour).
  const repliesVisible = expanded || showReplies;

  /** Open the isolated /post/[id] detail from a whole-card click (feed only). */
  function openDetail() {
    if (expanded) return;
    // Don't hijack a text selection / drag as a navigation.
    if (typeof window !== "undefined") {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
    }
    router.push(`/post/${post.id}`);
  }

  function onCardKeyDown(e: React.KeyboardEvent) {
    if (expanded) return;
    if (e.key === "Enter") {
      e.preventDefault();
      router.push(`/post/${post.id}`);
    }
  }

  function onReplyClick() {
    if (expanded) {
      replyRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      setShowReplies((s) => !s);
    }
  }

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  function requireWallet(): boolean {
    if (!wallet.address) {
      toast.error("Connect your wallet first.");
      return false;
    }
    return true;
  }

  function onLike() {
    if (!requireWallet()) return;
    likeM.mutate(
      { postId: post.id, like: !post.viewerLiked, signer: wallet, onchainId: post.onchainId },
      { onError: (e) => toast.error("Could not like", { description: errMsg(e) }) },
    );
  }

  function onRepost() {
    setRepostMenu(false);
    if (!requireWallet()) return;
    repostM.mutate(
      { postId: post.id, repost: !post.viewerReposted, signer: wallet, onchainId: post.onchainId },
      { onError: (e) => toast.error("Could not repost", { description: errMsg(e) }) },
    );
  }

  function onQuote() {
    setRepostMenu(false);
    if (!requireWallet()) return;
    setQuoting(true);
  }

  async function onShare() {
    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}/post/${post.id}`
        : `/post/${post.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy link");
    }
  }

  async function refreshReplies() {
    await qc.invalidateQueries({ queryKey: ["social", "replies", post.id] });
    await qc.invalidateQueries({ queryKey: ["social", "posts"] });
    await qc.invalidateQueries({ queryKey: ["social", "post", post.id] });
  }

  const textClass = expanded
    ? "mt-1 whitespace-pre-wrap break-words font-sans text-[17px] leading-7 text-[var(--color-text-primary)]"
    : "mt-0.5 whitespace-pre-wrap break-words font-sans text-[14px] leading-6 text-[var(--color-text-primary)]";

  return (
    <div
      className={
        expanded
          ? "ansem-fade-in flex gap-3 px-1 py-4"
          : "ansem-fade-in flex cursor-pointer gap-3 border-b border-[var(--hairline)] px-1 py-4 transition-colors hover:bg-[var(--color-bg-surface)]/[0.015]"
      }
      onClick={expanded ? undefined : openDetail}
      onKeyDown={expanded ? undefined : onCardKeyDown}
      role={expanded ? undefined : "link"}
      tabIndex={expanded ? undefined : 0}
      aria-label={expanded ? undefined : `Open post by ${name}`}
    >
      <Link
        href={`/creator/${post.author}`}
        className="shrink-0"
        aria-label={`${name}'s profile`}
        onClick={stop}
      >
        <Avatar src={p.avatar} className={expanded ? "h-11 w-11" : "h-10 w-10"} iconSize={expanded ? 22 : 20} />
      </Link>
      <div className="min-w-0 flex-1">
        <PostIdentity profile={p} address={post.author} createdAt={post.createdAt} />

        {post.text && <RichText text={post.text} className={textClass} />}

        {/* On-chain badge: this post's text + author are signature-verified and
            recorded in the ansem-social contract. Links to the tx on the explorer. */}
        {post.txhash && (
          <a
            href={`https://explorer.ansemchain.fun/tx/${post.txhash}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={stop}
            title="Recorded on-chain in the ansem-social contract"
            className="mt-2 inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-[3px] font-mono text-[11px] text-emerald-400 transition-colors hover:bg-emerald-500/20"
          >
            <span aria-hidden="true">⛓</span> on-chain
          </a>
        )}

        {/* Inline image */}
        {post.image && (
          <div className="mt-2 w-fit">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={post.image}
              alt=""
              className={`w-full rounded-xl border border-[var(--hairline)] object-cover ${expanded ? "max-h-[560px]" : "max-h-[420px]"}`}
            />
          </div>
        )}

        {/* Token preview banner */}
        {post.token && <TokenPreviewBanner address={post.token} />}

        {/* Quoted post embed */}
        {post.quoted && <QuotedPost post={post.quoted} />}

        {/* Full timestamp (detail view) */}
        {expanded && (
          <div
            className="mt-3 border-b border-[var(--hairline)] pb-3 font-mono text-[13px] text-[var(--color-text-muted)]"
            title={new Date(post.createdAt).toISOString()}
          >
            {new Date(post.createdAt).toLocaleString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </div>
        )}

        {/* Action row */}
        <div
          className={`relative flex items-center text-[var(--color-text-muted)] ${expanded ? "mt-1 gap-2" : "mt-2 gap-1"}`}
          onClick={stop}
        >
          <ActionButton
            icon={<ChatCircle size={17} weight="regular" />}
            count={post.replyCount}
            label="Reply"
            active={!expanded && showReplies}
            activeClass="text-[var(--color-accent-strong)]"
            onClick={onReplyClick}
          />

          <div ref={repostRef} className="relative">
            <ActionButton
              icon={<Repeat size={17} weight={post.viewerReposted ? "bold" : "regular"} />}
              count={post.repostCount}
              label="Repost"
              active={Boolean(post.viewerReposted)}
              activeClass="text-[var(--color-accent-strong)]"
              busy={repostM.isPending}
              onClick={openRepostMenu}
            />
          </div>
          {repostMenu && menuPos &&
            createPortal(
              <div
                ref={menuRef}
                style={{ position: "fixed", top: menuPos.top, left: menuPos.left, zIndex: 1000 }}
                className="ansem-fade-in w-40 overflow-hidden rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-surface)] py-1 shadow-xl"
              >
                <button
                  type="button"
                  onClick={onRepost}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left font-sans text-[13px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-raised)]"
                >
                  <Repeat size={15} weight="regular" />
                  {post.viewerReposted ? "Undo repost" : "Repost"}
                </button>
                <button
                  type="button"
                  onClick={onQuote}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left font-sans text-[13px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-raised)]"
                >
                  <Quotes size={15} weight="regular" />
                  Quote
                </button>
              </div>,
              document.body,
            )}

          <ActionButton
            icon={<Heart size={17} weight={post.viewerLiked ? "fill" : "regular"} />}
            count={post.likeCount}
            label="Like"
            active={Boolean(post.viewerLiked)}
            activeClass="text-[var(--color-negative)]"
            busy={likeM.isPending}
            onClick={onLike}
          />
          <ActionButton
            icon={<ShareNetwork size={17} weight="regular" />}
            label="Share"
            active={false}
            activeClass="text-[var(--color-accent-strong)]"
            onClick={() => void onShare()}
          />
        </div>

        {/* Inline quote composer */}
        {quoting && (
          <div className="ansem-fade-in mt-2" onClick={stop}>
            <PostComposer
              wallet={wallet}
              quoteOf={post}
              autoFocus
              placeholder="Add your take"
              onCancel={() => setQuoting(false)}
              onPosted={async () => {
                setQuoting(false);
                await onChanged?.();
              }}
            />
          </div>
        )}

        {/* Replies */}
        {repliesVisible && (
          <div ref={replyRef} onClick={stop}>
            <ReplyPanel post={post} wallet={wallet} onReplied={refreshReplies} />
          </div>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  icon,
  count,
  label,
  active,
  activeClass,
  busy,
  onClick,
}: {
  icon: React.ReactNode;
  count?: number;
  label: string;
  active: boolean;
  activeClass: string;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      className={`group flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[12px] tabular-nums transition-colors hover:bg-[var(--color-bg-raised)] disabled:opacity-50 ${
        active ? activeClass : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      }`}
    >
      {icon}
      {count ? <span>{count}</span> : null}
    </button>
  );
}

/* ---------------- quoted post (rendered inside a card) ---------------- */

function QuotedPost({ post }: { post: Post }) {
  const profile = useProfile(post.author);
  const p = profile.data ?? {};
  const name = p.displayName || (p.username ? `@${p.username}` : short(post.author));

  return (
    <Link
      href={`/creator/${post.author}`}
      onClick={(e) => e.stopPropagation()}
      className="mt-2 block rounded-xl border border-[var(--hairline)] bg-[var(--color-bg-page)] p-3 transition-colors hover:border-[var(--hairline-strong)]"
    >
      <div className="flex items-center gap-1.5">
        <Avatar src={p.avatar} className="h-5 w-5" iconSize={11} />
        <span className="truncate font-sans text-[13px] font-semibold text-[var(--color-text-primary)]">{name}</span>
        <span className="text-[12px] text-[var(--color-text-subtle)]">·</span>
        <span className="font-mono text-[12px] text-[var(--color-text-subtle)]">{ago(post.createdAt)}</span>
      </div>
      {post.text && (
        <RichText
          text={post.text}
          className="mt-1 whitespace-pre-wrap break-words font-sans text-[13px] leading-5 text-[var(--color-text-secondary)]"
        />
      )}
      {post.image && (
        <div className="mt-2 w-fit">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={post.image}
            alt=""
            className="max-h-[220px] rounded-lg border border-[var(--hairline)] object-cover"
          />
        </div>
      )}
      {post.token && <TokenPreviewBanner address={post.token} size="sm" />}
    </Link>
  );
}

/* ---------------- reply panel ---------------- */

function ReplyPanel({
  post,
  wallet,
  onReplied,
}: {
  post: Post;
  wallet: Wallet;
  onReplied: () => Promise<void> | void;
}) {
  const replies = usePostReplies(post.id);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const trimmed = text.trim();
  const over = text.length > REPLY_MAX;

  async function send() {
    if (!wallet.address) {
      toast.error("Connect your wallet to reply.");
      return;
    }
    if (!trimmed || over) return;
    setBusy(true);
    try {
      await addPostReply(post.id, wallet.address, trimmed, wallet, post.onchainId);
      setText("");
      await onReplied();
    } catch (e) {
      toast.error("Could not reply", { description: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  const list = [...(replies.data ?? [])].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="ansem-fade-in mt-3 rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-page)] p-3">
      {wallet.address ? (
        <div className="flex gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Post your reply"
            rows={2}
            maxLength={REPLY_MAX}
            disabled={busy}
            aria-label="Compose a reply"
            className="min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-5 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)]"
          />
          <div className="flex flex-col items-end justify-between">
            <span
              className={`font-mono text-[10px] tabular-nums ${over ? "text-[var(--color-negative)]" : "text-[var(--color-text-subtle)]"}`}
            >
              {text.length}/{REPLY_MAX}
            </span>
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || !trimmed || over}
              className="h-7 rounded-md bg-[var(--color-accent-solid)] px-3 font-sans text-[12px] font-semibold text-[var(--color-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy ? "Signing…" : "Reply"}
            </button>
          </div>
        </div>
      ) : (
        <p className="font-sans text-[12px] text-[var(--color-text-muted)]">Connect your wallet to reply.</p>
      )}

      <div className="mt-3 space-y-3">
        {replies.isLoading ? (
          <p className="font-sans text-[12px] text-[var(--color-text-subtle)]">Loading replies…</p>
        ) : list.length === 0 ? (
          <p className="font-sans text-[12px] text-[var(--color-text-subtle)]">No replies yet.</p>
        ) : (
          list.map((r) => <ReplyRow key={r.id} reply={r} />)
        )}
      </div>
    </div>
  );
}

function ReplyRow({ reply }: { reply: Post }) {
  const profile = useProfile(reply.author);
  const p = profile.data ?? {};
  const name = p.displayName || (p.username ? `@${p.username}` : short(reply.author));
  return (
    <div className="ansem-fade-in flex gap-2.5">
      <Link href={`/creator/${reply.author}`} className="shrink-0">
        <Avatar src={p.avatar} className="h-7 w-7" iconSize={14} />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <Link
            href={`/creator/${reply.author}`}
            className="truncate font-sans text-[13px] font-semibold text-[var(--color-text-primary)] hover:underline"
          >
            {name}
          </Link>
          <span className="font-mono text-[11px] text-[var(--color-text-subtle)]">{ago(reply.createdAt)}</span>
        </div>
        <RichText
          text={reply.text}
          className="mt-0.5 whitespace-pre-wrap break-words font-sans text-[13px] leading-5 text-[var(--color-text-secondary)]"
        />
      </div>
    </div>
  );
}
