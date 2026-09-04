"use client";

import { ActivityFeed } from "@/components/utoken/activity";

export default function ActivityPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-5 font-sans">
      <div>
        <h1 className="font-display text-[24px] font-semibold tracking-tight text-[var(--color-text-primary)]">Activity</h1>
        <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">Live launches, buys and sells across Floatdesk.</p>
      </div>
      <div className="rounded-xl border border-[var(--hairline)] bg-[var(--color-bg-surface)] px-4">
        <ActivityFeed />
      </div>
    </div>
  );
}
