"use client";

/**
 * Fetches the LP board and mounts LpPoolsSection.
 *
 * This exists because the section was built, styled, tested and never IMPORTED
 * anywhere, so the pools it lists were reachable only by typing a 64 character
 * pool id into the URL. Every part worked and the feature did not, which is the
 * one failure this codebase keeps meeting: each piece correct, nothing checking
 * that they were connected. A component with no import site is the frontend
 * version of a registered address with no code behind it.
 *
 * It is a separate file rather than a fetch inside liquidity-market.tsx so that
 * mounting it costs that file one import and one line. The board belongs to
 * another session and the less of it this touches, the better.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LpPoolsSection, type LpPoolRow } from "./lp-pools-section";

interface Payload {
  pools: LpPoolRow[];
  unreadable: Array<{ poolId: string; reason: string }>;
  error?: string;
}

export function LpPoolsPanel() {
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/float/lp-pools", { cache: "no-store" });
        const body = (await res.json()) as Payload;
        if (!live) return;
        // A 502 from this route still carries empty arrays, so rendering the
        // body regardless would show "no pools" for "we could not ask". Those
        // are different sentences and only one of them is a measurement.
        if (!res.ok) setFailed(body.error ?? `the pool list failed to load (${res.status})`);
        else setData(body);
      } catch (e) {
        if (live) setFailed(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // The forms live on the pool page, so both actions go there. Add lands on a
  // quote hop only, which the section already enforces by not offering it
  // anywhere else.
  const open = useCallback((p: LpPoolRow) => router.push(`/liquidity/${p.poolId}`), [router]);

  if (failed) {
    return (
      <p className="mx-1 mb-3 rounded border border-[var(--color-border-soft)] px-4 py-3 text-[13px] text-[var(--color-text-muted)]">
        The liquidity pools could not be read just now, so they are unlisted
        rather than absent: {failed}
      </p>
    );
  }
  // Not `return null`. This route takes seconds against a public RPC, and
  // rendering nothing meanwhile makes a loading board and a board with no
  // pools look identical, which is the silence this whole section keeps
  // relearning. Say it is reading.
  if (!data) {
    return (
      <p
        className="mx-1 mb-3 rounded border border-[var(--color-border-soft)] px-4 py-3 text-[13px] text-[var(--color-text-muted)]"
        aria-live="polite"
      >
        Reading the liquidity pools from chain...
      </p>
    );
  }

  return (
    <LpPoolsSection
      pools={data.pools}
      unreadable={data.unreadable}
      onAdd={open}
      onRemove={open}
    />
  );
}
