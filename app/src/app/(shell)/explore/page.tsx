"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Scanner } from "@/components/utoken/scanner";
import { DiscoverTrending, DiscoverTags, WhoToFollow } from "@/components/social/discover";

/**
 * Explore is the discovery hub: the token Scanner (default) plus social
 * discovery — Trending posts, trending Tags (with a per-tag feed), and Who to
 * follow. The active tab is reflected in the URL (?tab=), and a ?tag= deep-links
 * straight into the Tags surface (used by #hashtag links + the feed strip).
 */

type Tab = "tokens" | "trending" | "tags" | "follow";

const TABS: { id: Tab; label: string }[] = [
  { id: "tokens", label: "Tokens" },
  { id: "trending", label: "Trending" },
  { id: "tags", label: "Tags" },
  { id: "follow", label: "Who to follow" },
];

function ExploreInner() {
  const sp = useSearchParams();
  const router = useRouter();

  const tag = sp.get("tag") ?? undefined;
  const tabParam = sp.get("tab") as Tab | null;
  const tab: Tab = tag ? "tags" : tabParam && TABS.some((t) => t.id === tabParam) ? tabParam : "tokens";

  function go(next: Tab) {
    router.push(next === "tokens" ? "/explore" : `/explore?tab=${next}`);
  }

  return (
    <div>
      <div className="mb-5 flex gap-5 border-b border-[var(--hairline)]">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => go(t.id)}
            className={`relative -mb-px h-11 font-sans text-[14px] font-medium transition-colors ${
              tab === t.id ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            }`}
          >
            {t.label}
            {tab === t.id && (
              <span className="absolute inset-x-0 bottom-0 mx-auto h-[3px] w-full rounded-full bg-[var(--color-accent-solid)]" />
            )}
          </button>
        ))}
      </div>

      {tab === "tokens" ? (
        <Scanner />
      ) : (
        <div key={tab} className="ansem-fade-in mx-auto w-full max-w-[620px]">
          {tab === "trending" && <DiscoverTrending />}
          {tab === "tags" && <DiscoverTags initialTag={tag} />}
          {tab === "follow" && <WhoToFollow title="Who to follow" />}
        </div>
      )}
    </div>
  );
}

export default function ExplorePage() {
  return (
    <Suspense fallback={null}>
      <ExploreInner />
    </Suspense>
  );
}
