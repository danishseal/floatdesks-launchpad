import { Suspense } from "react";
import { ClaimUsername } from "@/components/social/claim";

export const dynamic = "force-dynamic";

export default function ClaimPage() {
  return (
    <div className="px-3 py-6 sm:px-5 sm:py-10">
      <Suspense fallback={<div className="px-1 text-[13px] text-[var(--color-text-subtle)]">Loading…</div>}>
        <ClaimUsername />
      </Suspense>
    </div>
  );
}
