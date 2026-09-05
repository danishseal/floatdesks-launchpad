"use client";

import Link from "next/link";
import { Plus, XLogo, BookOpen } from "@phosphor-icons/react";
import { ConnectButton } from "@/components/wallet/connect-button";

const NAV_ITEMS = [
  { label: "Scanner", href: "/explore", badge: "S", badgeClass: "bg-[#c49a32]" },
  { label: "Portfolio", href: "/your-tokens", badge: "P", badgeClass: "bg-[#91a9d6]" },
  { label: "Analytics", href: "/analytics", badge: "A", badgeClass: "bg-[#0d4b2d] text-white" },
  { label: "Liquidity", href: "/liquidity", badge: "Q", badgeClass: "bg-[#a6b4a3]" },
  { label: "Leaderboard", href: "/leaderboard", badge: "L", badgeClass: "bg-[#ddb8cc]" },
] as const;

/** Floatdesk primary application header. */
export function TopNav({ squareCorners = false }: { squareCorners?: boolean }) {
  return (
    <header
      className="app-shell-header sticky top-0 z-30 h-12 bg-[var(--color-bg-surface)]"
      style={squareCorners ? { borderRadius: 0 } : undefined}
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-50 border border-[var(--color-border)]" />
      <div className="flex h-full w-full items-stretch bg-[var(--color-bg-surface)] pr-5">
        <Link href="/" aria-label="Floatdesk home" className="flex w-[132px] shrink-0 items-stretch">
          <span className="app-shell-logo-tile flex w-12 items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/sailboat-white.png"
              alt=""
              className="h-10 w-10 object-contain"
            />
          </span>
          <span className="flex min-w-0 flex-1 items-center pl-3 pr-2 font-mono text-[14px] font-semibold uppercase leading-none tracking-[-0.04em] text-[var(--color-text-primary)]">
            Floatdesk
          </span>
        </Link>

        <nav aria-label="Primary navigation" className="absolute left-1/2 top-1/2 hidden h-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-10 font-mono text-[12px] text-[var(--color-text-primary)] lg:flex">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="group flex shrink-0 items-center gap-3 whitespace-nowrap transition-[transform,opacity] duration-200 ease-out hover:-translate-y-px hover:opacity-70"
            >
              <span
                aria-hidden="true"
                className={`flex h-5 w-5 items-center justify-center text-[11px] font-medium transition-transform duration-200 ease-out group-hover:-rotate-3 group-hover:scale-105 ${item.badgeClass}`}
              >
                {item.badge}
              </span>
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2 pl-3">
          <a
            href="https://docs.ansemchain.fun"
            target="_blank"
            rel="noreferrer"
            aria-label="Floatdesk docs"
            title="Docs"
            className="hidden h-8 w-8 shrink-0 items-center justify-center text-[var(--color-text-secondary)] transition-[transform,color] duration-200 hover:-translate-y-px hover:text-[var(--color-accent-strong)] md:flex"
          >
            <BookOpen size={17} weight="bold" />
          </a>

          <a
            href="https://x.com/ansemchainfun/"
            target="_blank"
            rel="noreferrer"
            aria-label="Floatdesk on X"
            title="Floatdesk on X"
            className="hidden h-8 w-8 shrink-0 items-center justify-center text-[var(--color-text-secondary)] transition-[transform,color] duration-200 hover:-translate-y-px hover:text-[var(--color-accent-strong)] md:flex"
          >
            <XLogo size={17} weight="bold" />
          </a>

          <Link
            href="/create"
            className="hidden h-8 shrink-0 items-center gap-1.5 px-2 font-mono text-[12px] font-medium text-[var(--color-text-primary)] transition-[transform,opacity] duration-200 hover:-translate-y-px hover:opacity-70 sm:flex"
          >
            <Plus size={15} weight="bold" /> Launch
          </Link>

          <ConnectButton
            label="Connect"
            balanceOnly
            className="h-8 shrink-0 bg-[#ddb8cc] px-3.5 font-mono text-[12px] font-medium text-[var(--color-text-primary)] transition-[transform,box-shadow,opacity] duration-200 hover:-translate-y-px hover:shadow-[2px_2px_0_var(--color-border)] hover:opacity-90"
            connectedClassName="h-8 w-auto px-3 font-mono"
          />
        </div>
      </div>

    </header>
  );
}
