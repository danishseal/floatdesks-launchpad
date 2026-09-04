"use client";

import { Suspense } from "react";
import { Scanner } from "@/components/utoken/scanner";

/**
 * Explore is the token scanner. The social discovery tabs it used to carry
 * (trending posts, hashtags, who to follow) belonged to the ansem-1 SocialFi
 * stack and have no Float equivalent.
 */
export default function ExplorePage() {
  return (
    <Suspense fallback={<div className="px-1 py-6 text-[13px] text-[var(--color-text-subtle)]">Loading…</div>}>
      <Scanner />
    </Suspense>
  );
}
