"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import type { ReactNode } from "react";

const solanaConnectors = toSolanaWalletConnectors();

// Solana RPC config Privy's standard wallet flow (Solflare/Phantom
// connect + sign-in) needs to operate against a cluster.
const solanaRpcs = {
  "solana:mainnet": {
    rpc: createSolanaRpc("https://api.mainnet-beta.solana.com"),
    rpcSubscriptions: createSolanaRpcSubscriptions(
      "wss://api.mainnet-beta.solana.com"
    ),
  },
};

export function Providers({ children }: { children: ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) return <>{children}</>;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#3b82f6",
          walletChainType: "solana-only",
          walletList: ["phantom", "solflare", "detected_solana_wallets"],
        },
        loginMethods: ["wallet", "email"],
        externalWallets: { solana: { connectors: solanaConnectors } },
        solana: { rpcs: solanaRpcs },
        embeddedWallets: {
          solana: { createOnLogin: "users-without-wallets" },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
