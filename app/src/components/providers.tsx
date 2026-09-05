"use client";

import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Toaster } from "@/components/ui/sonner";
import { FloatWalletProvider } from "@/components/wallet/float-wallet-provider";
import { setRuntimeNetwork } from "@/lib/float/networks";
import { resetClients } from "@/lib/float/chain";
import { clearRegistryCache } from "@/lib/float/registry";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30 * 1000, refetchOnWindowFocus: true, retry: 2 },
    },
  });
}

/**
 * Wallet backend is chosen here. `injected` is the default and needs no
 * service; `privy` swaps in the embedded/email backend, which satisfies the
 * same context, so nothing downstream changes. See float-wallet-provider.tsx.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => makeQueryClient());

  // Adopt the server's network before doing any chain reads. Without this the
  // client uses whatever NEXT_PUBLIC_FLOAT_NETWORK was baked into its bundle,
  // which is not necessarily what the server is serving.
  useEffect(() => {
    let live = true;
    fetch("/api/float/config", { cache: "no-store" })
      .then((r) => r.json())
      .then((cfg: { key?: string }) => {
        if (!live || !cfg?.key) return;
        setRuntimeNetwork(cfg.key);
        clearRegistryCache();
        resetClients();
        void queryClient.invalidateQueries();
      })
      .catch(() => { /* keep the bundle's own value */ });
    return () => { live = false; };
  }, [queryClient]);

  return (
    <FloatWalletProvider>
      <QueryClientProvider client={queryClient}>
        {children}
        <Toaster />
        <ReactQueryDevtools initialIsOpen={false} />
      </QueryClientProvider>
    </FloatWalletProvider>
  );
}
