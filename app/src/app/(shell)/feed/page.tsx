"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFloorWallet } from "@/components/wallet/solana-wallet-provider";
import { usePosts, useGraph, type Post } from "@/lib/social";
import { PostCard } from "@/components/social/post-card";
import { PostComposer } from "@/components/social/post-composer";
import { FeedShell } from "@/components/social/feed-rails";
import { TrendingTagsStrip } from "@/components/social/discover";

type Tab = "for-you" | "following";
type Wallet = ReturnType<typeof useFloorWallet>;

export default function FeedPage() {
  const wallet = useFloorWallet();
  const qc = useQueryClient();
  const posts = usePosts(wallet.address); // global timeline + viewer flags
  const [tab, setTab] = useState<Tab>("for-you");

  const all = useMemo(
    () => [...(posts.data ?? [])].sort((a, b) => b.createdAt - a.createdAt),
    [posts.data],
  );

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["social", "posts"] });
  }

  return (
    <FeedShell>
      <div className="mb-4">
        <h1 className="font-display text-[24px] font-semibold tracking-tight text-[var(--color-text-primary)]">Feed</h1>
        <p className="mt-0.5 font-sans text-[13px] text-[var(--color-text-muted)]">
          The global timeline of everyone on Floatdesk.
        </p>
      </div>

      <TrendingTagsStrip />

      <PostComposer wallet={wallet} onPosted={refresh} />

      <div className="flex border-b border-[var(--hairline)]">
        <TabButton active={tab === "for-you"} onClick={() => setTab("for-you")}>
          For you
        </TabButton>
        <TabButton active={tab === "following"} onClick={() => setTab("following")}>
          Following
        </TabButton>
      </div>

      <div key={tab} className="ansem-fade-in">
        {posts.isLoading ? (
          <Empty label="Loading the timeline…" />
        ) : tab === "for-you" ? (
          all.length === 0 ? (
            <Empty label="No posts yet." hint="Be the first to say something above." />
          ) : (
            <div>
              {all.map((p) => (
                <PostCard key={p.id} post={p} wallet={wallet} onChanged={refresh} />
              ))}
            </div>
          )
        ) : (
          <FollowingTimeline posts={all} wallet={wallet} onChanged={refresh} />
        )}
      </div>
    </FeedShell>
  );
}

/* ---------------- Following timeline ---------------- */

function FollowingTimeline({
  posts,
  wallet,
  onChanged,
}: {
  posts: Post[];
  wallet: Wallet;
  onChanged: () => Promise<void> | void;
}) {
  const viewer = wallet.address;
  const authors = useMemo(() => Array.from(new Set(posts.map((p) => p.author))), [posts]);
  const [followed, setFollowed] = useState<Record<string, boolean>>({});

  if (!viewer) {
    return (
      <Empty
        label="Connect your wallet to see who you follow."
        hint="Follow people from their profiles, then their posts land here."
      />
    );
  }

  const resolvedCount = authors.filter((a) => a in followed).length;
  const loading = authors.length > 0 && resolvedCount < authors.length;
  const visible = posts.filter((p) => followed[p.author]);

  return (
    <>
      {authors.map((a) => (
        <FollowProbe
          key={a}
          author={a}
          viewer={viewer}
          onResult={(f) => setFollowed((prev) => (prev[a] === f ? prev : { ...prev, [a]: f }))}
        />
      ))}

      {loading && visible.length === 0 ? (
        <Empty label="Checking who you follow…" />
      ) : visible.length === 0 ? (
        <Empty
          label="You're not following anyone with posts yet."
          hint="Find people on their profiles and hit Follow to fill this tab."
        />
      ) : (
        <div>
          {visible.map((p) => (
            <PostCard key={p.id} post={p} wallet={wallet} onChanged={onChanged} />
          ))}
        </div>
      )}
    </>
  );
}

function FollowProbe({
  author,
  viewer,
  onResult,
}: {
  author: string;
  viewer: string;
  onResult: (follows: boolean) => void;
}) {
  const graph = useGraph(author, viewer);
  const follows = graph.data?.viewerFollows;
  useEffect(() => {
    if (typeof follows === "boolean") onResult(follows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follows]);
  return null;
}

/* ---------------- bits ---------------- */

function TabButton({
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
      className={`relative -mb-px h-11 flex-1 font-sans text-[14px] font-medium transition-colors ${
        active ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      }`}
    >
      {children}
      {active && (
        <span className="absolute inset-x-0 bottom-0 mx-auto h-[3px] w-14 rounded-full bg-[var(--color-accent-solid)]" />
      )}
    </button>
  );
}

function Empty({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-16 text-center">
      <p className="font-sans text-[14px] text-[var(--color-text-secondary)]">{label}</p>
      {hint && <p className="font-sans text-[12px] text-[var(--color-text-subtle)]">{hint}</p>}
    </div>
  );
}
