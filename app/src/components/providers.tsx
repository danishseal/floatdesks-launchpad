"use client";

import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Toaster } from "@/components/ui/sonner";
import { FloatWalletProvider } from "@/components/wallet/float-wallet-provider";
import { PrivyWalletProvider } from "@/components/wallet/privy-wallet-provider";
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
 * Wallet backend is chosen here, and only here.
 *
 * `injected` needs no service and talks to MetaMask or Rabby. `privy` swaps in
 * the embedded/email backend. Both fill the same context (wallet-context.ts),
 * so nothing downstream changes and no component branches on the mode.
 *
 * Read statically so Next inlines it into the client bundle; the comparison is
 * explicit rather than defaulting to whichever backend has credentials,
 * because a wallet layer that picks itself based on which env var happens to
 * be present is a wallet layer nobody can predict.
 */
const WALLET_BACKEND =
  process.env.NEXT_PUBLIC_WALLET_MODE === "privy" ? PrivyWalletProvider : FloatWalletProvider;

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
    <WALLET_BACKEND>
      <QueryClientProvider client={queryClient}>
        {children}
        <Toaster />
        <ReactQueryDevtools initialIsOpen={false} />
      </QueryClientProvider>
    </WALLET_BACKEND>
  );
}
