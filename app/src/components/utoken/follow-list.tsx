"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { useProfile } from "@/lib/social";
import { Avatar, resolveIdentity, short } from "@/components/social/shared";

export type FollowTab = "followers" | "following";

/**
 * Twitter-style followers / following list. The address lists come straight from
 * the graph endpoint (already loaded on the profile), so this only resolves each
 * row's identity. Read-only: it lists users and links to their profile.
 */
export function FollowListModal({
  tab,
  followers,
  following,
  onTab,
  onClose,
}: {
  tab: FollowTab;
  followers: string[];
  following: string[];
  onTab: (t: FollowTab) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const base = tab === "followers" ? followers : following;
  const q = query.trim().toLowerCase();
  const list = useMemo(
    () => (q ? base.filter((a) => a.toLowerCase().includes(q)) : base),
    [base, q],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-[var(--hairline-strong)] bg-[var(--color-bg-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--hairline)] px-5 py-3.5">
          <h2 className="font-display text-[15px] font-semibold text-[var(--color-text-primary)]">Connections</h2>
          <button type="button" onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
            <X size={16} weight="bold" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center border-b border-[var(--hairline)] px-2">
          {(["followers", "following"] as FollowTab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onTab(t)}
              className={`relative -mb-px h-11 flex-1 text-[14px] font-semibold capitalize transition-colors ${
                tab === t ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              }`}
            >
              {t === "followers" ? "Followers" : "Following"}
              <span className="ml-1.5 font-mono text-[12px] text-[var(--color-text-subtle)]">
                {t === "followers" ? followers.length : following.length}
              </span>
              {tab === t && (
                <span className="absolute inset-x-6 bottom-0 h-[3px] rounded-full bg-[var(--color-accent-solid)]" />
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="border-b border-[var(--hairline)] px-4 py-2.5">
          <div className="flex h-9 items-center gap-2 rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-page)] px-3 focus-within:border-[var(--hairline-strong)]">
            <MagnifyingGlass size={14} className="shrink-0 text-[var(--color-text-muted)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by address"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)]"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="shrink-0 text-[var(--color-text-subtle)] hover:text-[var(--color-text-secondary)]"
              >
                <X size={13} weight="bold" />
              </button>
            )}
          </div>
        </div>

        {/* List (fades on tab / query change) */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div key={`${tab}-${q ? "q" : "all"}`} className="ansem-fade-in">
            {list.length ? (
              <div className="divide-y divide-[var(--hairline)]">
                {list.map((addr) => (
                  <FollowRow key={addr} address={addr} onNavigate={onClose} />
                ))}
              </div>
            ) : base.length ? (
              <div className="flex flex-col items-center justify-center gap-1 px-6 py-16 text-center">
                <p className="font-display text-[14px] font-semibold text-[var(--color-text-primary)]">No matches</p>
                <p className="text-[12px] text-[var(--color-text-muted)]">No address here matches &quot;{query}&quot;.</p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-1 px-6 py-16 text-center">
                <p className="font-display text-[15px] font-semibold text-[var(--color-text-primary)]">
                  {tab === "followers" ? "No followers yet" : "Not following anyone yet"}
                </p>
                <p className="max-w-xs text-[12px] text-[var(--color-text-muted)]">
                  {tab === "followers"
                    ? "When someone follows this profile, they will show here."
                    : "Profiles this account follows will show here."}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One user row: avatar + two-line identity (name / @username), linking out. */
function FollowRow({ address, onNavigate }: { address: string; onNavigate: () => void }) {
  const { data: profile, isLoading } = useProfile(address);
  const identity = resolveIdentity(profile ?? {}, address);

  return (
    <Link
      href={`/creator/${address}`}
      onClick={onNavigate}
      className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-[var(--color-bg-surface)]/[0.03]"
    >
      <Avatar src={profile?.avatar} className="h-10 w-10" iconSize={20} />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-[14px] font-semibold text-[var(--color-text-primary)]">
          {isLoading ? short(address) : identity.name}
        </p>
        <p className="truncate font-mono text-[12px] text-[var(--color-text-muted)]">
          {identity.showHandle && identity.handle ? identity.handle : short(address)}
        </p>
      </div>
    </Link>
  );
}
