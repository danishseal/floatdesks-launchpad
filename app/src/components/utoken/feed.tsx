"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useFloorWallet } from "@/components/wallet/solana-wallet-provider";
import { usePosts, useComments, addComment, type Post } from "@/lib/social";
import { PostCard } from "@/components/social/post-card";
import { PostComposer } from "@/components/social/post-composer";

const MAX = 480;

/* ---------------- Composer ---------------- */

function Composer({
  placeholder,
  submitLabel,
  onSubmit,
}: {
  placeholder: string;
  submitLabel: string;
  onSubmit: (text: string) => Promise<void>;
}) {
  const wallet = useFloorWallet();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function go() {
    if (!wallet.address) {
      await wallet.connect();
      return;
    }
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      await onSubmit(t);
      setText("");
    } catch (e) {
      toast.error("Failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-[var(--hairline)] bg-[var(--color-bg-surface)] p-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, MAX))}
        placeholder={wallet.address ? placeholder : "Connect a wallet to post"}
        rows={2}
        disabled={busy}
        className="w-full resize-none bg-transparent text-[14px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)]"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="font-mono text-[11px] text-[var(--color-text-subtle)]">{text.length}/{MAX}</span>
        <button
          type="button"
          onClick={go}
          disabled={busy || (Boolean(wallet.address) && !text.trim())}
          className="h-8 rounded-lg bg-[var(--color-accent-solid)] px-4 text-[13px] font-semibold text-[var(--color-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "Signing…" : !wallet.address ? "Connect" : submitLabel}
        </button>
      </div>
    </div>
  );
}

/* ---------------- Post row ---------------- */

function PostRow({ post }: { post: Post }) {
  return (
    <div className="flex gap-3 py-3">
      <Link href={`/creator/${post.author}`} className="mt-0.5 h-9 w-9 shrink-0 rounded-full bg-[var(--color-bg-raised)] ring-1 ring-inset ring-white/10" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link href={`/creator/${post.author}`} className="font-mono text-[13px] font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-accent-strong)]">
            {short(post.author)}
          </Link>
          <span className="font-mono text-[11px] text-[var(--color-text-subtle)]">{ago(post.createdAt)}</span>
        </div>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-[14px] leading-5 text-[var(--color-text-primary)]">{post.text}</p>
      </div>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="py-10 text-center text-[13px] text-[var(--color-text-muted)]">{label}</p>;
}

/* ---------------- Profile posts ("tweets") ---------------- */

type SubTab = "posts" | "reposts" | "media";

export function ProfilePosts({ address }: { address: string }) {
  const wallet = useFloorWallet();
  const qc = useQueryClient();
  // Author timeline (this person's posts) + the global timeline as *this* person's
  // viewer, which surfaces the posts they've reposted.
  const authored = usePosts(address, address); // viewer=address, author=address
  const global = usePosts(address); // viewer=address, all authors
  const isOwn = Boolean(wallet.address && wallet.address === address);
  const [sub, setSub] = useState<SubTab>("posts");

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["social", "posts"] });
  }

  const authoredList = useMemo(
    () => [...(authored.data ?? [])].sort((a, b) => b.createdAt - a.createdAt),
    [authored.data],
  );
  const reposts = useMemo(
    () =>
      [...(global.data ?? [])]
        .filter((p) => p.viewerReposted)
        .sort((a, b) => b.createdAt - a.createdAt),
    [global.data],
  );
  const media = useMemo(() => authoredList.filter((p) => p.image), [authoredList]);

  const list = sub === "reposts" ? reposts : sub === "media" ? media : authoredList;
  const loading = sub === "reposts" ? global.isLoading : authored.isLoading;

  const emptyLabel =
    sub === "reposts"
      ? "No reposts yet."
      : sub === "media"
        ? "No posts with images yet."
        : isOwn
          ? "No posts yet. Say something."
          : "No posts yet.";

  return (
    <div>
      {isOwn && <PostComposer wallet={wallet} onPosted={refresh} />}

      {/* Sub-tabs (Twitter-style) */}
      <div className="mb-1 flex gap-1 border-b border-[var(--hairline)]">
        <SubTabButton active={sub === "posts"} onClick={() => setSub("posts")}>
          Posts
        </SubTabButton>
        <SubTabButton active={sub === "reposts"} onClick={() => setSub("reposts")}>
          Reposts
        </SubTabButton>
        <SubTabButton active={sub === "media"} onClick={() => setSub("media")}>
          Media
        </SubTabButton>
      </div>

      <div key={sub} className="ansem-fade-in">
        {loading ? (
          <Empty label="Loading posts…" />
        ) : list.length === 0 ? (
          <Empty label={emptyLabel} />
        ) : (
          list.map((p) => <PostCard key={p.id} post={p} wallet={wallet} onChanged={refresh} />)
        )}
      </div>
    </div>
  );
}

function SubTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative -mb-px h-10 px-3 font-sans text-[13px] font-medium transition-colors ${
        active ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      }`}
    >
      {children}
      {active && (
        <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-[var(--color-accent-solid)]" />
      )}
    </button>
  );
}

/* ---------------- Token comments ---------------- */

export function TokenComments({ token }: { token: string }) {
  const wallet = useFloorWallet();
  const qc = useQueryClient();
  const comments = useComments(token);

  return (
    <div className="space-y-2">
      <Composer
        placeholder="Add a comment…"
        submitLabel="Comment"
        onSubmit={async (t) => {
          await addComment(token, wallet.address!, t, wallet);
          await qc.invalidateQueries({ queryKey: ["social", "comments", token] });
        }}
      />
      <div className="divide-y divide-[var(--hairline)]">
        {comments.isLoading ? (
          <Empty label="Loading comments…" />
        ) : (comments.data ?? []).length === 0 ? (
          <Empty label="No comments yet. Be the first." />
        ) : (
          (comments.data ?? []).map((c) => <PostRow key={c.id} post={c} />)
        )}
      </div>
    </div>
  );
}

function short(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a;
}
function ago(ts: number): string {
  return formatDistanceToNow(new Date(ts), { addSuffix: true });
}
