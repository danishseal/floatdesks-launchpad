"use client";

import { useQuery } from "@tanstack/react-query";
import type { Post, Profile } from "@/lib/social";

/**
 * Discovery client — trending posts, trending hashtags, a hashtag feed, and
 * suggested follows. All reads are PUBLIC (no signature): trending/discovery is
 * public data. Talks to the same /api/social/* proxy the rest of the SocialFi
 * client uses, which forwards to the indexer's public GET routes.
 */

/** A trending hashtag: the tag (no leading #) + its post counts. */
export type TrendingHashtag = { tag: string; count: number; posts24h: number };

/** A suggested profile to follow, with its follower count + neighbourhood overlap. */
export type SuggestedProfile = { address: string } & Profile & {
  followerCount: number;
  mutual: number;
};

/** Named trending windows (hours). */
export const TRENDING_WINDOWS = { "24h": 24, "7d": 168, "30d": 720 } as const;
export type TrendingWindow = keyof typeof TRENDING_WINDOWS;

/**
 * Trending main-feed posts over a window ("24h" | "7d" | "30d"). Pass a viewer
 * address to get the like/repost flags for the connected wallet.
 */
export function useTrendingPosts(window: TrendingWindow = "24h", viewer?: string | null) {
  const hours = TRENDING_WINDOWS[window];
  return useQuery({
    queryKey: ["social", "trending", "posts", window, viewer ?? ""],
    queryFn: async (): Promise<Post[]> => {
      const params = new URLSearchParams({ window: String(hours) });
      if (viewer) params.set("viewer", viewer);
      const r = await fetch(`/api/social/trending/posts?${params.toString()}`);
      if (!r.ok) return [];
      return ((await r.json()) as { posts: Post[] }).posts ?? [];
    },
    staleTime: 30_000,
  });
}

/** Trending hashtags (ranked by distinct posts in the last 24h). */
export function useTrendingHashtags(limit = 12) {
  return useQuery({
    queryKey: ["social", "trending", "hashtags", limit],
    queryFn: async (): Promise<TrendingHashtag[]> => {
      const r = await fetch(`/api/social/hashtags?limit=${limit}`);
      if (!r.ok) return [];
      return ((await r.json()) as { tags: TrendingHashtag[] }).tags ?? [];
    },
    staleTime: 60_000,
  });
}

/** Recent main-feed posts containing #<tag>. */
export function useHashtagPosts(tag: string, viewer?: string | null) {
  const clean = tag.replace(/^#/, "").toLowerCase();
  return useQuery({
    queryKey: ["social", "hashtag", clean, viewer ?? ""],
    queryFn: async (): Promise<Post[]> => {
      const qs = viewer ? `?viewer=${encodeURIComponent(viewer)}` : "";
      const r = await fetch(`/api/social/hashtag/${encodeURIComponent(clean)}${qs}`);
      if (!r.ok) return [];
      return ((await r.json()) as { posts: Post[] }).posts ?? [];
    },
    enabled: Boolean(clean),
    staleTime: 30_000,
  });
}

/**
 * Suggested follows — people `me` doesn't already follow. Personalized by the
 * viewer's follow graph when `me` is given (public data, so no auth needed).
 */
export function useSuggestedFollows(me?: string | null, limit = 8) {
  return useQuery({
    queryKey: ["social", "suggested-follows", me ?? "", limit],
    queryFn: async (): Promise<SuggestedProfile[]> => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (me) params.set("me", me);
      const r = await fetch(`/api/social/suggested-follows?${params.toString()}`);
      if (!r.ok) return [];
      return ((await r.json()) as { profiles: SuggestedProfile[] }).profiles ?? [];
    },
    staleTime: 60_000,
  });
}
