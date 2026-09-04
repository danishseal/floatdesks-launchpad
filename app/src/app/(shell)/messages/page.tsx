import { Suspense } from "react";
import { Messages } from "@/components/social/messages";

export const dynamic = "force-dynamic";

export default function MessagesPage() {
  return (
    <div className="px-3 py-4 sm:px-5 sm:py-6">
      <Suspense fallback={<div className="px-1 text-[13px] text-[var(--color-text-subtle)]">Loading…</div>}>
        <Messages />
      </Suspense>
    </div>
  );
}
