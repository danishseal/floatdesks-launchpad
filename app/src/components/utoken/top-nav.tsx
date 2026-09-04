"use client";

import Link from "next/link";
import { Plus, XLogo, BookOpen } from "@phosphor-icons/react";
import { ConnectButton } from "@/components/wallet/connect-button";

const NAV_ITEMS = [
  { label: "Scanner", href: "/explore", badge: "S", badgeClass: "bg-[#c49a32]" },
  { label: "Feed", href: "/feed", badge: "F", badgeClass: "bg-[#91a9d6]" },
  { label: "Analytics", href: "/analytics", badge: "A", badgeClass: "bg-[#0d4b2d] text-white" },
  { label: "Leaderboard", href: "/leaderboard", badge: "L", badgeClass: "bg-[#ddb8cc]" },
] as const;

/** Floatdesk primary application header. */
export function TopNav({ squareCorners = false }: { squareCorners?: boolean }) {
  return (
    <header
      className="app-shell-header sticky top-0 z-30 bg-[var(--color-bg-page)]/95 backdrop-blur-md"
      style={squareCorners ? { borderRadius: 0 } : undefined}
    >
      {/* Main header */}
      <div className="flex h-16 w-full items-stretch bg-[var(--color-bg-surface)]">
        <Link href="/" aria-label="Floatdesk home" className="flex shrink-0 items-stretch">
          <span className="app-shell-logo-tile flex w-16 items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/sailboat-white.png"
              alt=""
              className="h-12 w-12 object-contain"
            />
          </span>
          <span className="hidden items-center px-4 font-mono text-[20px] font-semibold tracking-[-0.03em] text-[var(--color-text-primary)] sm:flex">
            Floatdesk
          </span>
        </Link>

        <nav aria-label="Primary navigation" className="hidden min-w-0 flex-1 items-center justify-center gap-7 px-6 font-mono text-sm text-[var(--color-text-primary)] lg:flex xl:gap-11">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex shrink-0 items-center gap-3 whitespace-nowrap transition-opacity hover:opacity-65"
            >
              <span
                aria-hidden="true"
                className={`flex h-7 w-7 items-center justify-center text-[13px] font-medium ${item.badgeClass}`}
              >
                {item.badge}
              </span>
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2 px-3">
          <a
            href="https://docs.ansemchain.fun"
            target="_blank"
            rel="noreferrer"
            aria-label="Floatdesk docs"
            title="Docs"
            className="hidden h-9 w-9 shrink-0 items-center justify-center text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-accent-strong)] md:flex"
          >
            <BookOpen size={17} weight="bold" />
          </a>

          <a
            href="https://x.com/ansemchainfun/"
            target="_blank"
            rel="noreferrer"
            aria-label="Floatdesk on X"
            title="Floatdesk on X"
            className="hidden h-9 w-9 shrink-0 items-center justify-center text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-accent-strong)] md:flex"
          >
            <XLogo size={17} weight="bold" />
          </a>

          <Link
            href="/create"
            className="hidden h-9 shrink-0 items-center gap-1.5 px-2 font-mono text-[13px] font-medium text-[var(--color-text-primary)] transition-opacity hover:opacity-65 sm:flex"
          >
            <Plus size={15} weight="bold" /> Launch
          </Link>

          <ConnectButton
            label="Connect"
            balanceOnly
            className="h-9 shrink-0 bg-[#ddb8cc] px-3.5 font-mono text-[13px] font-medium text-[var(--color-text-primary)] transition-opacity hover:opacity-80"
            connectedClassName="h-9 w-auto px-3 font-mono"
          />
        </div>
      </div>

    </header>
  );
}
