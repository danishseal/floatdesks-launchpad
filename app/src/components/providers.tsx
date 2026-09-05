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
export function Providers({
  children,
  networkKey,
}: {
  children: React.ReactNode;
  /** The network the SERVER is on, handed down at render time. */
  networkKey?: string;
}) {
  // Adopt it BEFORE the first render rather than in an effect. NEXT_PUBLIC_* is
  // baked into the client bundle at build time, so without this the client
  // reads a different chain than the server serves. Doing it in an effect was
  // not enough: queries mount and fire first, so a token page could ask the
  // wrong chain, get nothing, and cache "Token not found" before the correction
  // landed.
  if (networkKey) setRuntimeNetwork(networkKey);

  const [queryClient] = useState(() => makeQueryClient());

  // Belt and braces for a client-side network switch.
  useEffect(() => {
    if (!networkKey) return;
    setRuntimeNetwork(networkKey);
    clearRegistryCache();
    resetClients();
  }, [networkKey]);

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
