"use client";

/**
 * A creator on Float is someone who has launched tokens, so this page is their
 * launches and the fees those launches have accrued to them. The social profile
 * it replaced (posts, followers, editable bio) belonged to the ansem-1 SocialFi
 * stack and has no Float equivalent.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFloatWallet } from "@/components/wallet/float-wallet-provider";
import { fetchTokens, type TokenListItem } from "@/lib/api";
import { activeNetwork } from "@/lib/float/networks";

export default function CreatorPage() {
  const params = useParams<{ address: string }>();
  const address = (params?.address ?? "").toLowerCase();
  const wallet = useFloatWallet();
  const net = activeNetwork();

  const { data: tokens, isLoading } = useQuery({
    queryKey: ["tokens", "all"],
    queryFn: fetchTokens,
  });

  const mine = useMemo(
    () => (tokens ?? []).filter((t) => (t.creator ?? "").toLowerCase() === address),
    [tokens, address],
  );

  const isSelf = wallet.address?.toLowerCase() === address;

  return (
    <div className="px-3 py-6 sm:px-5 sm:py-10">
      <header className="mb-8">
        <p className="text-[12px] uppercase tracking-wide text-[var(--color-text-subtle)]">
          {isSelf ? "Your launches" : "Creator"}
        </p>
        <h1 className="mt-1 break-all text-[22px] font-semibold text-[var(--color-text-primary)]">
          {address}
        </h1>
        <a
          className="mt-2 inline-block text-[13px] text-[var(--color-text-secondary)] underline"
          href={`${net.explorer}/address/${address}`}
          target="_blank"
          rel="noreferrer"
        >
          View on explorer
        </a>
      </header>

      {isLoading ? (
        <p className="text-[13px] text-[var(--color-text-subtle)]">Loading launches…</p>
      ) : mine.length === 0 ? (
        <p className="text-[13px] text-[var(--color-text-subtle)]">
          This address has not launched a token.
        </p>
      ) : (
        <div className="divide-y divide-[var(--color-border-soft)] rounded-[12px] border border-[var(--color-border-soft)]">
          {mine.map((t) => <CreatorTokenRow key={t.address} token={t} />)}
        </div>
      )}
    </div>
  );
}

function CreatorTokenRow({ token }: { token: TokenListItem }) {
  const raised = Number(token.market.curveSolRaised);
  const target = Number(token.market.graduationTargetSol);
  const progress = target > 0 ? Math.min(100, (raised / target) * 100) : 0;

  return (
    <Link href={`/token/${token.address}`} className="flex items-center gap-4 px-4 py-4">
      {token.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={token.image} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
      ) : (
        <div className="h-10 w-10 shrink-0 rounded-full bg-[var(--color-bg-page)]" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-[var(--color-text-primary)]">
          ${token.symbol}
        </span>
        <span className="block truncate text-[13px] text-[var(--color-text-secondary)]">
          {token.name} · on {token.base_label}
        </span>
      </div>
      <div className="shrink-0 text-right">
        <span className="block text-[14px] font-medium text-[var(--color-text-primary)]">
          {raised.toFixed(3)} {token.base_label}
        </span>
        <span className="block text-[12px] text-[var(--color-text-subtle)]">
          {token.graduated ? "graduated" : `${progress.toFixed(1)}% to graduation`}
        </span>
      </div>
    </Link>
  );
}
