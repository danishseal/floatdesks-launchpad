"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { CaretDown, Plus, SidebarSimple } from "@phosphor-icons/react";

type NavItem = {
  label: string;
  href: string;
  activeWhen?: (pathname: string) => boolean;
};

// Text-only nav (no icons), sentence case.
const navItems: NavItem[] = [
  {
    label: "Home",
    href: "/",
    activeWhen: (p) => p === "/" || p.startsWith("/token/"),
  },
  { label: "Explore", href: "/explore" },
  { label: "Messages", href: "/messages" },
  { label: "Horns", href: "/horns" },
  { label: "Horn Vault", href: "/your-tokens" },
  { label: "Stats", href: "/explore" },
];

interface SidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ isCollapsed, onToggle }: SidebarProps) {
  const pathname = usePathname();
  const widthClass = isCollapsed ? "w-[64px]" : "w-[212px]";

  return (
    <aside
      className={
        "fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-[var(--color-border-soft)] bg-[var(--color-bg-page)] text-[var(--color-text-primary)] transition-[width] duration-200 md:flex " +
        widthClass
      }
    >
      {/* Wordmark */}
      <div
        className={
          "flex h-14 shrink-0 items-center " +
          (isCollapsed ? "justify-center px-2" : "justify-between px-4")
        }
      >
        {!isCollapsed ? (
          <Link
            href="/"
            aria-label="Floatdesk home"
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <Image
              src="/sailboat.png"
              alt="Floatdesk"
              width={30}
              height={30}
              className="h-[30px] w-[30px] shrink-0 rounded-[5px] object-cover"
              priority
            />
            <span className="truncate font-display text-[15px] font-semibold tracking-tight text-[var(--color-text-primary)]">
              Floatdesk
            </span>
          </Link>
        ) : (
          <Image
            src="/sailboat.png"
            alt="Floatdesk"
            width={30}
            height={30}
            className="h-[30px] w-[30px] rounded-[5px] object-cover"
            priority
          />
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--color-text-subtle)] transition-colors hover:text-[var(--color-text-primary)]"
        >
          <SidebarSimple size={18} weight="regular" />
        </button>
      </div>

      {/* Nav */}
      <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-1">
        <div className="flex flex-col gap-0.5">
          {navItems.map((item) => (
            <NavRow
              key={item.label}
              item={item}
              pathname={pathname}
              collapsed={isCollapsed}
            />
          ))}
        </div>

        {/* CREATE box: pew's bordered create control */}
        <Link
          href="/create"
          className={
            "mt-4 flex items-center justify-center gap-1.5 rounded-[4px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] font-display text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-border)] hover:text-[var(--color-text-primary)] " +
            (isCollapsed ? "h-9 px-0" : "h-9 px-3")
          }
          title="Create"
        >
          <Plus size={14} weight="bold" />
          {!isCollapsed && <span>Create</span>}
          {!isCollapsed && (
            <CaretDown size={11} weight="bold" className="text-[var(--color-text-subtle)]" />
          )}
        </Link>
      </nav>

      {/* Footer: chain ticker (pew keeps an eth/block ticker here). Wallet lives
          in the top bar so it isn't duplicated. */}
      {!isCollapsed && (
        <div className="shrink-0 border-t border-[var(--color-border-soft)] px-3 pb-3 pt-3">
          <ChainTicker />
        </div>
      )}
    </aside>
  );
}

function ChainTicker() {
  return (
    <div className="mt-3 space-y-1 px-1 font-mono text-[10px] text-[var(--color-text-subtle)]">
      <div className="flex items-center justify-between">
        <span>chanse</span>
        <span className="tnum text-[var(--color-text-muted)]">$0.0182</span>
      </div>
      <div className="flex items-center justify-between">
        <span>block</span>
        <span className="tnum text-[var(--color-text-muted)]">1,284,930</span>
      </div>
      <div className="flex items-center gap-1.5 pt-0.5">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent-solid)]" />
        <span className="uppercase tracking-[0.14em] text-[var(--color-text-subtle)]">
          Floatdesk
        </span>
      </div>
    </div>
  );
}

function NavRow({
  item,
  pathname,
  collapsed,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
}) {
  const active = item.activeWhen
    ? item.activeWhen(pathname)
    : pathname === item.href ||
      (item.href !== "/" && pathname.startsWith(`${item.href}/`));

  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      className={
        "group relative flex h-9 items-center rounded-[4px] font-display text-[13px] font-medium transition-colors " +
        (collapsed ? "justify-center px-0 " : "px-2.5 ") +
        (active ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]")
      }
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-[var(--color-accent-solid)]" />
      )}
      {collapsed ? (
        <span className="text-[13px] font-semibold">{item.label.slice(0, 1)}</span>
      ) : (
        <span className="truncate">{item.label}</span>
      )}
    </Link>
  );
}
