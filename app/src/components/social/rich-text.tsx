"use client";

import Link from "next/link";
import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";

/**
 * Render post text with clickable #hashtags and @mentions, leaving all other
 * text (and its whitespace / line breaks) exactly as-is. Hashtags link to the
 * Explore "Tags" surface; mentions resolve the handle to a wallet address and
 * link to that profile (falling back to muted, non-linked text while unresolved
 * or when the handle is unknown, so a bad @mention is never a broken link).
 *
 * The matcher is deliberately the same shape the indexer parses:
 *   #([a-z0-9_]{2,32})   @([a-z0-9_]{3,20})
 * so what is linkified here is exactly what trends / resolves server-side.
 */

const TOKEN_RE = /(#[A-Za-z0-9_]{2,32}|@[a-z0-9_]{3,20})/g;

export function RichText({ text, className }: { text: string; className?: string }) {
  return <p className={className}>{linkify(text)}</p>;
}

/** Split into plain strings + hashtag / mention nodes. Exported for reuse. */
export function linkify(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(<Fragment key={key++}>{text.slice(last, start)}</Fragment>);
    const tok = m[0];
    if (tok.startsWith("#")) {
      const tag = tok.slice(1).toLowerCase();
      out.push(
        <Link
          key={key++}
          href={`/explore?tab=tags&tag=${encodeURIComponent(tag)}`}
          onClick={(e) => e.stopPropagation()}
          className="text-[var(--color-accent-strong)] hover:underline"
        >
          {tok}
        </Link>,
      );
    } else {
      out.push(<Mention key={key++} handle={tok.slice(1)} raw={tok} />);
    }
    last = start + tok.length;
  }
  if (last < text.length) out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return out;
}

/** Resolve @handle -> address and link to the profile; muted text if unknown. */
function Mention({ handle, raw }: { handle: string; raw: string }) {
  const { data: address } = useQuery({
    queryKey: ["social", "resolve", handle],
    queryFn: async (): Promise<string | null> => {
      const r = await fetch(`/api/social/search?resolve=${encodeURIComponent(handle)}`);
      if (!r.ok) return null;
      return ((await r.json()) as { address?: string | null }).address ?? null;
    },
    staleTime: 5 * 60_000,
  });
  if (!address) {
    return <span className="text-[var(--color-text-secondary)]">{raw}</span>;
  }
  return (
    <Link
      href={`/creator/${address}`}
      onClick={(e) => e.stopPropagation()}
      className="text-[var(--color-accent-strong)] hover:underline"
    >
      {raw}
    </Link>
  );
}
