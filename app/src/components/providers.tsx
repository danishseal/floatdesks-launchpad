"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Toaster } from "@/components/ui/sonner";
import { FloatWalletProvider } from "@/components/wallet/float-wallet-provider";

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
