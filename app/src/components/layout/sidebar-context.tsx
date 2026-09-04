"use client";

import { createContext, useContext, useState } from "react";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

interface SidebarContextValue {
  isCollapsed: boolean;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarContextValue>({
  isCollapsed: false,
  toggle: () => {},
});

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(() => pathname.startsWith("/token/"));

  useEffect(() => {
    setIsCollapsed(pathname.startsWith("/token/"));
  }, [pathname]);
  return (
    <SidebarContext.Provider
      value={{ isCollapsed, toggle: () => setIsCollapsed((p) => !p) }}
    >
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  return useContext(SidebarContext);
}
