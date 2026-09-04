import { Skeleton } from "@/components/ui/skeleton";

export function TokenCardSkeleton() {
  return (
    <div className="rounded-[16px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] p-4">
      <div className="flex gap-5"><Skeleton className="h-[68px] w-[68px] rounded-full bg-[var(--color-bg-hover)]" /><div className="flex-1 space-y-2 pt-2"><Skeleton className="h-4 w-28 bg-[var(--color-bg-hover)]" /><Skeleton className="h-3 w-20 bg-[var(--color-bg-hover)]" /></div></div>
      <div className="mt-5 grid grid-cols-2 gap-3"><Skeleton className="h-8 bg-[var(--color-bg-hover)]" /><Skeleton className="h-8 bg-[var(--color-bg-hover)]" /></div>
      <Skeleton className="my-4 h-px bg-[var(--color-bg-hover)]" /><div className="flex justify-between"><Skeleton className="h-8 w-24 bg-[var(--color-bg-hover)]" /><Skeleton className="h-8 w-24 bg-[var(--color-bg-hover)]" /></div>
    </div>
  );
}
