"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { TopNav } from "@/components/utoken/top-nav";
import { CommandSearchProvider } from "@/components/utoken/command-search";
import { Footer } from "@/components/layout/footer";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const scrollbarThumbRef = useRef<HTMLDivElement>(null);
  const isTerminal = pathname.startsWith("/token/");
  const isCreate = pathname.startsWith("/create");
  // These routes manage their own full-bleed layout (no max-width container, no
  // extra padding) and hide the footer, so the create wizard never scrolls.
  const bare = isTerminal || isCreate;
  const hideFooter = bare;

  useEffect(() => {
    const scrollWindow = bodyScrollRef.current;
    const scrollbar = scrollbarRef.current;
    const thumb = scrollbarThumbRef.current;
    if (!scrollWindow || !scrollbar || !thumb) return;

    const syncScrollbar = () => {
      const maxScroll = scrollWindow.scrollHeight - scrollWindow.clientHeight;
      const travel = scrollbar.clientHeight - thumb.offsetHeight;
      const progress = maxScroll > 0 ? scrollWindow.scrollTop / maxScroll : 0;
      scrollbar.hidden = maxScroll <= 0;
      thumb.style.transform = `translateY(${Math.max(0, progress * travel)}px)`;
    };

    let dragOffset = 0;
    let dragging = false;

    const scrollFromPointer = (event: PointerEvent) => {
      const track = scrollbar.getBoundingClientRect();
      const maxScroll = scrollWindow.scrollHeight - scrollWindow.clientHeight;
      const travel = scrollbar.clientHeight - thumb.offsetHeight;
      if (travel <= 0 || maxScroll <= 0) return;
      const thumbTop = Math.max(0, Math.min(travel, event.clientY - track.top - 1 - dragOffset));
      scrollWindow.scrollTop = (thumbTop / travel) * maxScroll;
    };

    const onPointerDown = (event: PointerEvent) => {
      const thumbBounds = thumb.getBoundingClientRect();
      const onThumb = event.clientY >= thumbBounds.top && event.clientY <= thumbBounds.bottom;
      dragOffset = onThumb ? event.clientY - thumbBounds.top : thumb.offsetHeight / 2;
      dragging = true;
      scrollbar.setPointerCapture(event.pointerId);
      scrollFromPointer(event);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (dragging) scrollFromPointer(event);
    };

    const onPointerUp = (event: PointerEvent) => {
      dragging = false;
      if (scrollbar.hasPointerCapture(event.pointerId)) {
        scrollbar.releasePointerCapture(event.pointerId);
      }
    };

    const resizeObserver = new ResizeObserver(syncScrollbar);
    resizeObserver.observe(scrollWindow);
    for (const child of scrollWindow.children) resizeObserver.observe(child);
    const mutationObserver = new MutationObserver(syncScrollbar);
    mutationObserver.observe(scrollWindow, { childList: true, subtree: true });
    scrollWindow.addEventListener("scroll", syncScrollbar, { passive: true });
    scrollbar.addEventListener("pointerdown", onPointerDown);
    scrollbar.addEventListener("pointermove", onPointerMove);
    scrollbar.addEventListener("pointerup", onPointerUp);
    scrollbar.addEventListener("pointercancel", onPointerUp);
    syncScrollbar();

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      scrollWindow.removeEventListener("scroll", syncScrollbar);
      scrollbar.removeEventListener("pointerdown", onPointerDown);
      scrollbar.removeEventListener("pointermove", onPointerMove);
      scrollbar.removeEventListener("pointerup", onPointerUp);
      scrollbar.removeEventListener("pointercancel", onPointerUp);
    };
  }, [pathname]);

  return (
    <CommandSearchProvider>
      <div className="app-shell-layout text-[var(--color-text-primary)]">
        <TopNav squareCorners={isCreate} />
        <div className="app-shell-body-frame">
          <div ref={bodyScrollRef} className="app-shell-body-scroll">
            <main className={`flex-1 ${bare ? "bg-[var(--color-bg-page)]" : ""}`}>
              {bare ? (
                children
              ) : (
                <div className="w-full px-4 py-8 sm:px-6">{children}</div>
              )}
            </main>
            {!hideFooter && <Footer />}
          </div>
          <div ref={scrollbarRef} className="pixel-frame__scrollbar" aria-hidden="true">
            <div ref={scrollbarThumbRef} className="pixel-frame__scrollbar-thumb" />
          </div>
        </div>
      </div>
    </CommandSearchProvider>
  );
}
