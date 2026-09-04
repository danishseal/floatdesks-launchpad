import { Skeleton } from "@/components/ui/skeleton";

export function TradingChartSkeleton({ terminal = false }: { terminal?: boolean }) {
  return (
    <div className={terminal ? "h-full min-h-[360px] py-2" : "space-y-4"}>
      {!terminal && <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-9 w-48" />
      </div>}
      <Skeleton className={terminal ? "h-full min-h-[360px] w-full rounded-none bg-[var(--color-bg-page)]" : "h-[400px] w-full rounded-2xl"} />
    </div>
  );
}
