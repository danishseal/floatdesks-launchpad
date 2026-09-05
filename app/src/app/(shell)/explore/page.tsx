"use client";

import { Scanner } from "@/components/utoken/scanner";

/**
 * Explore is the token scanner. The social discovery tabs it used to carry
 * (trending posts, hashtags, who to follow) belonged to the ansem-1 SocialFi
 * stack and have no Float equivalent.
 *
 * No Suspense boundary here. The original needed one because its inner
 * component read useSearchParams; when that went, I left the wrapper behind and
 * an empty boundary around a client component pinned the scanner in its loading
 * state permanently: "Loading scanner..." and "- coins" forever, with the data
 * fetched and sitting there. Nothing here suspends, so nothing should wrap it.
 */
export default function ExplorePage() {
  return <Scanner />;
}
