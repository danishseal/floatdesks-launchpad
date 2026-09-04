"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Hash, TrendUp } from "@phosphor-icons/react";
import { useFloorWallet } from "@/components/wallet/solana-wallet-provider";
import { setFollow } from "@/lib/social";
import {
  useTrendingPosts,
  useTrendingHashtags,
  useHashtagPosts,
  useSuggestedFollows,
  TRENDING_WINDOWS,
  type TrendingWindow,
  type SuggestedProfile,
} from "@/lib/discovery";
import { PostCard } from "@/components/social/post-card";
import { Avatar, errMsg, resolveIdentity } from "@/components/social/shared";

type Wallet = ReturnType<typeof useFloorWallet>;

function Empty({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-16 text-center">
      <p className="font-sans text-[14px] text-[var(--color-text-secondary)]">{label}</p>
      {hint && <p className="font-sans text-[12px] text-[var(--color-text-subtle)]">{hint}</p>}
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return <p className="px-4 py-16 text-center font-sans text-[13px] text-[var(--color-text-subtle)]">{label}</p>;
}

/* ---------------- Follow button (reuses the signed follow action) ---------------- */

export function FollowButton({
  target,
  size = "md",
}: {
  target: string;
  size?: "md" | "sm";
}) {
  const wallet = useFloorWallet();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [following, setFollowing] = useState(false);

  async function onClick() {
    if (!wallet.address) {
      toast.error("Connect your wallet first.");
      return;
    }
    if (wallet.address === target) return;
    const next = !following;
    setBusy(true);
    try {
      await setFollow(wallet.address, target, next, wallet);
      setFollowing(next);
      await qc.invalidateQueries({ queryKey: ["social", "graph", target] });
      await qc.invalidateQueries({ queryKey: ["social", "suggested-follows"] });
    } catch (e) {
      toast.error("Could not update follow", { description: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  const pad = size === "sm" ? "h-7 px-3 text-[12px]" : "h-8 px-4 text-[13px]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || wallet.address === target}
      className={`shrink-0 rounded-full font-sans font-semibold transition-colors disabled:opacity-40 ${pad} ${
        following
          ? "border border-[var(--hairline)] bg-transparent text-[var(--color-text-secondary)] hover:border-[#a73520] hover:text-[var(--color-negative)]"
          : "bg-[var(--color-bg-surface)] text-[var(--color-on-accent)] hover:bg-[var(--color-bg-raised)]"
      }`}
    >
      {busy ? "…" : following ? "Following" : "Follow"}
    </button>
  );
}

/* ---------------- Who to follow ---------------- */

function SuggestedRow({ profile }: { profile: SuggestedProfile }) {
  const { name, handle, showHandle } = resolveIdentity(profile, profile.address);
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <Link href={`/creator/${profile.address}`} className="shrink-0">
        <Avatar src={profile.avatar} className="h-9 w-9" iconSize={18} />
      </Link>
      <Link href={`/creator/${profile.address}`} className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate font-sans text-[13px] font-semibold text-[var(--color-text-primary)] hover:underline">
            {name}
          </span>
          {profile.verified && (
            <span
              title="Verified"
              className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-solid)] font-mono text-[9px] font-bold leading-none text-[var(--color-on-accent)]"
            >
              ✓
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-[var(--color-text-muted)]">
          {showHandle && handle ? <span className="truncate">{handle}</span> : null}
          <span>
            {profile.followerCount} follower{profile.followerCount === 1 ? "" : "s"}
          </span>
          {profile.mutual > 0 && <span className="text-[var(--color-text-subtle)]">· {profile.mutual} in your circle</span>}
        </div>
      </Link>
      <FollowButton target={profile.address} size="sm" />
    </div>
  );
}

export function WhoToFollow({ limit = 12, title }: { limit?: number; title?: string }) {
  const wallet = useFloorWallet();
  const { data, isLoading } = useSuggestedFollows(wallet.address, limit);

  return (
    <div>
      {title && (
        <h2 className="mb-2 px-1 font-display text-[16px] font-semibold text-[var(--color-text-primary)]">{title}</h2>
      )}
      {isLoading ? (
        <Loading label="Finding people to follow…" />
      ) : !data || data.length === 0 ? (
        <Empty label="No suggestions yet." hint="Once people follow each other, they show up here." />
      ) : (
        <div className="divide-y divide-[var(--hairline)] overflow-hidden rounded-xl border border-[var(--hairline)] bg-[var(--color-bg-surface)]">
          {data.map((p) => (
            <SuggestedRow key={p.address} profile={p} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Trending posts ---------------- */

const WINDOW_LABELS: Record<TrendingWindow, string> = { "24h": "Today", "7d": "This week", "30d": "This month" };

export function DiscoverTrending() {
  const wallet = useFloorWallet();
  const qc = useQueryClient();
  const [window, setWindow] = useState<TrendingWindow>("24h");
  const { data: posts, isLoading } = useTrendingPosts(window, wallet.address);

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["social", "trending", "posts"] });
    await qc.invalidateQueries({ queryKey: ["social", "posts"] });
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5">
        {(Object.keys(TRENDING_WINDOWS) as TrendingWindow[]).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setWindow(w)}
            className={`rounded-full px-3 py-1 font-sans text-[12px] font-medium transition-colors ${
              window === w ? "bg-[var(--color-bg-raised)] text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            }`}
          >
            {WINDOW_LABELS[w]}
          </button>
        ))}
      </div>
      {isLoading ? (
        <Loading label="Loading what's trending…" />
      ) : !posts || posts.length === 0 ? (
        <Empty label="Nothing trending yet." hint="Posts with the most engagement will surface here." />
      ) : (
        <div className="ansem-fade-in">
          {posts.map((p) => (
            <PostCard key={p.id} post={p} wallet={wallet} onChanged={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Tags (trending hashtags + a tag feed) ---------------- */

export function DiscoverTags({ initialTag }: { initialTag?: string }) {
  const wallet = useFloorWallet();
  const qc = useQueryClient();
  const [active, setActive] = useState<string | null>(initialTag ? initialTag.toLowerCase() : null);

  if (active) {
    return <TagFeed tag={active} onBack={() => setActive(null)} wallet={wallet} onRefresh={() =>
      qc.invalidateQueries({ queryKey: ["social", "hashtag", active] })} />;
  }
  return <TagCloud onPick={setActive} />;
}

function TagCloud({ onPick }: { onPick: (tag: string) => void }) {
  const { data: tags, isLoading } = useTrendingHashtags(24);
  if (isLoading) return <Loading label="Loading trending tags…" />;
  if (!tags || tags.length === 0) {
    return <Empty label="No trending tags yet." hint="Add a #hashtag to a post to start one." />;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--hairline)] bg-[var(--color-bg-surface)]">
      {tags.map((t, i) => (
        <button
          key={t.tag}
          type="button"
          onClick={() => onPick(t.tag)}
          className="flex w-full items-center gap-3 border-b border-[var(--hairline)] px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-[var(--color-bg-raised)]"
        >
          <span className="w-5 shrink-0 text-center font-mono text-[12px] text-[var(--color-text-subtle)]">{i + 1}</span>
          <Hash size={16} weight="bold" className="shrink-0 text-[var(--color-accent-strong)]" />
          <span className="min-w-0 flex-1 truncate font-display text-[14px] font-semibold text-[var(--color-text-primary)]">
            #{t.tag}
          </span>
          <span className="shrink-0 font-mono text-[12px] text-[var(--color-text-muted)]">
            {t.posts24h} post{t.posts24h === 1 ? "" : "s"} today
          </span>
        </button>
      ))}
    </div>
  );
}

function TagFeed({
  tag,
  onBack,
  wallet,
  onRefresh,
}: {
  tag: string;
  onBack: () => void;
  wallet: Wallet;
  onRefresh: () => void | Promise<void>;
}) {
  const { data: posts, isLoading } = useHashtagPosts(tag, wallet.address);
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md px-2 py-1 font-sans text-[12px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-text-secondary)]"
        >
          ← Tags
        </button>
        <h2 className="font-display text-[18px] font-semibold text-[var(--color-text-primary)]">#{tag}</h2>
      </div>
      {isLoading ? (
        <Loading label={`Loading #${tag}…`} />
      ) : !posts || posts.length === 0 ? (
        <Empty label={`No posts with #${tag} yet.`} />
      ) : (
        <div className="ansem-fade-in">
          {posts.map((p) => (
            <PostCard key={p.id} post={p} wallet={wallet} onChanged={onRefresh} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Trending-tags strip (compact, for the feed page) ---------------- */

export function TrendingTagsStrip() {
  const { data: tags } = useTrendingHashtags(10);
  const list = useMemo(() => tags ?? [], [tags]);
  if (list.length === 0) return null;
  return (
    <div className="mb-4 flex items-center gap-2 overflow-x-auto rounded-xl border border-[var(--hairline)] bg-[var(--color-bg-surface)] px-3 py-2.5">
      <span className="flex shrink-0 items-center gap-1 font-sans text-[12px] font-semibold text-[var(--color-text-secondary)]">
        <TrendUp size={14} weight="bold" className="text-[var(--color-accent-strong)]" /> Trending
      </span>
      {list.map((t) => (
        <Link
          key={t.tag}
          href={`/explore?tab=tags&tag=${encodeURIComponent(t.tag)}`}
          className="shrink-0 rounded-full border border-[var(--hairline)] px-2.5 py-1 font-mono text-[12px] text-[var(--color-accent-strong)] transition-colors hover:bg-[var(--color-bg-raised)]"
        >
          #{t.tag}
        </Link>
      ))}
      <Link
        href="/explore?tab=tags"
        className="ml-auto shrink-0 font-sans text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      >
        See all
      </Link>
    </div>
  );
}
