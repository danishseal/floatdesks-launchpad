"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@/components/wallet/connect-button";
import { useSidebar } from "@/components/layout/sidebar-context";

const navItems = [
  { label: "board", href: "/" },
  { label: "create-token", href: "/create" },
];

export function Header() {
  const pathname = usePathname();
  const { isCollapsed } = useSidebar();

  return (
    <header className="fixed top-0 right-0 left-0 z-40 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-surface)]/95 backdrop-blur-xl">
      <div
        className={`transition-[padding-left] duration-300 ease-in-out ${
          isCollapsed ? "lg:pl-20" : "lg:pl-64"
        }`}
      >
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-6">
            <Link href="/" aria-label="Floatdesk home" className="flex items-center gap-2">
              <Image
                src="/sailboat.png"
                alt="Floatdesk logo"
                width={48}
                height={48}
                className="h-12 w-12 rounded-full object-cover"
                priority
              />
              <span className="text-lg font-semibold tracking-[0.12em]">Floatdesk</span>
            </Link>
            <nav className="flex items-center gap-1">
              {navItems.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`px-2 py-1 text-sm font-mono transition-colors ${
                      isActive
                        ? "text-primary"
                        : "text-[var(--color-text-muted)] hover:text-zinc-900"
                    }`}
                  >
                    [{item.label}]
                  </Link>
                );
              })}
            </nav>
          </div>
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
