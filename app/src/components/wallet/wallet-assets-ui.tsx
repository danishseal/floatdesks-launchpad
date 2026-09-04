"use client";

import type { ReactNode } from "react";
import { Coins, SpinnerGap } from "@phosphor-icons/react";
import { ConnectButton } from "@/components/wallet/connect-button";

export function PageHeader({ title, description, count }: { title: string; description: string; count?: number }) {
  return <header className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] p-7"><div className="flex items-end justify-between gap-4"><div><h1 className="text-3xl font-semibold tracking-[-0.03em]">{title}</h1><p className="mt-2 text-sm text-[var(--color-text-secondary)]">{description}</p></div>{count !== undefined && <span className="text-sm text-[var(--color-text-muted)]">{count} {count === 1 ? "asset" : "assets"}</span>}</div></header>;
}

export function ConnectState({ title, description }: { title: string; description: string }) {
  return <div className="mx-auto flex min-h-[55vh] max-w-xl flex-col items-center justify-center text-center"><span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-bg-raised)] text-[var(--color-accent-strong)]"><Coins size={26} /></span><h1 className="mt-5 text-2xl">{title}</h1><p className="mt-2 text-sm text-[var(--color-text-muted)]">{description}</p><ConnectButton className="mt-6 h-10 rounded-lg bg-[var(--color-accent-solid)] px-5 text-[var(--color-on-accent)] hover:bg-[var(--color-accent-strong)]" /></div>;
}

export function LoadingState({ label }: { label: string }) { return <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]"><SpinnerGap size={20} className="animate-spin" />{label}</div>; }
export function ErrorState({ message }: { message: string }) { return <div className="rounded-xl border border-red-900/60 bg-red-950/30 p-5 text-center text-sm text-red-300">{message}</div>; }
export function EmptyState({ icon, title, description }: { icon: ReactNode; title: string; description: string }) { return <div className="flex min-h-64 flex-col items-center justify-center rounded-[16px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)]/80 px-6 text-center"><span className="text-[var(--color-text-subtle)]">{icon}</span><h2 className="mt-3 text-base">{title}</h2><p className="mt-2 text-sm text-[var(--color-text-muted)]">{description}</p></div>; }
export function AssetImage({ image, name, fallback }: { image: string | null; name: string; fallback: string }) { return image ? <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)]"><img src={image} alt={name} className="h-full w-full object-cover" /></div> : <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]">{fallback}</span>; }
