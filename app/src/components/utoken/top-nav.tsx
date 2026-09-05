"use client";

import Link from "next/link";
import { ConnectButton } from "@/components/wallet/connect-button";
import { ScrambleLabel } from "@/components/utoken/scramble-label";

/**
 * The centre of the header. Two destinations, one internal and one not, so
 * each row carries whether it leaves the app rather than the render guessing
 * from the shape of the href.
 */
const NAV_ITEMS = [
  { label: "Liquidity", href: "/liquidity", badge: "Q", badgeClass: "bg-[#a6b4a3]", external: false },
  {
    label: "Docs",
    href: "https://github.com/cocainebit/float-docs",
    badge: "D",
    badgeClass: "bg-[#7f9acf]",
    external: true,
  },
] as const;

/** Floatdesk primary application header. */
export function TopNav({ squareCorners = false }: { squareCorners?: boolean }) {
  return (
    <header
      className="app-shell-header sticky top-0 z-30 h-12 bg-[var(--color-bg-surface)]"
      style={squareCorners ? { borderRadius: 0 } : undefined}
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-50 border border-[var(--color-border)]" />
      <div className="flex h-full w-full items-stretch bg-[var(--color-bg-surface)]">
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
          {NAV_ITEMS.map((item) => {
            const badge = (
              <>
                <span
                  aria-hidden="true"
                  className={`flex h-5 w-5 items-center justify-center text-[11px] font-medium ${item.badgeClass}`}
                >
                  {item.badge}
                </span>
                <ScrambleLabel>{item.label}</ScrambleLabel>
              </>
            );
            const className =
              "flex shrink-0 items-center gap-3 whitespace-nowrap";

            return item.external ? (
              <a key={item.href} href={item.href} target="_blank" rel="noreferrer" className={className}>
                {badge}
              </a>
            ) : (
              <Link key={item.href} href={item.href} className={className}>
                {badge}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center pl-3">
          <ConnectButton
            label="Connect"
            balanceOnly
            className="h-full shrink-0 bg-[#ddb8cc] px-4 font-mono text-[12px] font-medium text-[var(--color-text-primary)] transition-[box-shadow,opacity] duration-200 hover:opacity-90"
            connectedClassName="h-full w-auto px-4 font-mono"
          />
        </div>

      </div>

    </header>
  );
}
