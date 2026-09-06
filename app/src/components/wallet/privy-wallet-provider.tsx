"use client";

/**
 * Wallet layer for Robinhood Chain: the Privy backend.
 *
 * Selected with NEXT_PUBLIC_WALLET_MODE=privy in providers.tsx. It fills the
 * same context as the injected backend (wallet-context.ts), so no consumer
 * knows which one is mounted.
 *
 * The part that makes this work at all is `setWalletClientFactory`. A Privy
 * embedded wallet is NOT window.ethereum, so the default signer path in
 * lib/float/chain.ts could never have signed for one. This registers a factory
 * that builds the wallet client from Privy's own EIP-1193 provider instead.
 */

import { PrivyProvider, useLogin, usePrivy, useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createWalletClient, custom, type Address } from "viem";
import { activeNetwork } from "@/lib/float/networks";
import { floatChain, resetClients, setWalletClientFactory } from "@/lib/float/chain";
import { clearRegistryCache } from "@/lib/float/registry";
import { WalletCtx, useWalletBalances, type FloatWallet } from "./wallet-context";

/**
 * Read statically so Next inlines it. An indirect lookup
 * (`process.env[name]`) is NOT replaced at build time and reads undefined in
 * the browser, which would look exactly like a missing app id.
 */
const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

/** Privy reports CAIP-2 ("eip155:4663"); the rest of the app thinks in numbers. */
function caip2ChainId(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.split(":").pop());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Privy reports a machine name ("rabby_wallet"), and it was reaching the
 * header as "via rabby_wallet". Known wallets get the capitalisation their
 * makers use; anything unrecognised is de-slugged rather than guessed at, so a
 * wallet we have never heard of still reads as a name.
 */
const WALLET_NAMES: Record<string, string> = {
  metamask: "MetaMask",
  rabby_wallet: "Rabby",
  coinbase_wallet: "Coinbase Wallet",
  wallet_connect: "WalletConnect",
  phantom: "Phantom",
  rainbow: "Rainbow",
  zerion: "Zerion",
  okx_wallet: "OKX Wallet",
};

function prettyWalletName(type: string): string {
  const known = WALLET_NAMES[type];
  if (known) return known;
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function PrivyWalletProvider({ children }: { children: ReactNode }) {
  // No app id means Privy cannot mount at all. Rendering PrivyProvider anyway
  // throws and takes the whole site down, so the app stays readable and the
  // failure surfaces where it belongs: on the button that needs it.
  if (!APP_ID) return <MisconfiguredWallet>{children}</MisconfiguredWallet>;

  const chain = floatChain();
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        // Robinhood Chain is not in Privy's built-in chain list, so it has to
        // be declared or every embedded wallet lands on mainnet Ethereum.
        defaultChain: chain,
        supportedChains: [chain],
        loginMethods: ["email", "wallet", "google"],
        // v3 nests this per chain type; a flat createOnLogin is silently the
        // wrong shape and no embedded wallet ever gets made.
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        appearance: { theme: "light", accentColor: "#1c1917" },
      }}
    >
      <PrivyBridge>{children}</PrivyBridge>
    </PrivyProvider>
  );
}

function PrivyBridge({ children }: { children: ReactNode }) {
  const net = activeNetwork();
  const { ready, authenticated, logout, connectWallet } = usePrivy();
  const { wallets } = useWallets();
  const [connecting, setConnecting] = useState(false);
  const { login } = useLogin({
    onComplete: () => setConnecting(false),
    onError: () => setConnecting(false),
  });

  /**
   * Disconnect is app state, not only Privy state.
   *
   * `logout()` ends a Privy SESSION. It does not remove an external wallet
   * from `useWallets()`, and a visitor who connected Rabby without ever
   * logging in has no session to end, so pressing Disconnect cleared the
   * balances and left the account chip sitting there still connected. This
   * flag is what the button actually moves; `connect()` clears it.
   */
  const [dismissed, setDismissed] = useState(false);
  const wallet = dismissed ? null : (wallets[0] ?? null);
  const address = wallet ? (wallet.address as Address) : null;
  const chainId = caip2ChainId(wallet?.chainId);

  const { balance, nativeBalance, refreshBalance, setBalance, setNativeBalance } =
    useWalletBalances(address);

  /**
   * Hand lib/float/chain.ts a signer built on Privy's provider.
   *
   * The provider is re-requested on every signature rather than captured once.
   * Privy's own type docs say switchChain does not update provider instances
   * already handed out, so a cached one keeps signing against whichever chain
   * the wallet was on when we first asked, silently and with a valid
   * signature.
   */
  useEffect(() => {
    if (!wallet) {
      setWalletClientFactory(null);
      return;
    }
    setWalletClientFactory(async () => {
      const provider = await wallet.getEthereumProvider();
      return createWalletClient({
        account: wallet.address as Address,
        chain: floatChain(),
        transport: custom(provider),
      });
    });
    return () => setWalletClientFactory(null);
  }, [wallet]);

  const connect = useCallback(async () => {
    setDismissed(false);
    // Already signed in but no wallet attached: the thing missing is a wallet,
    // not a login, and sending them back through login() would do nothing.
    if (authenticated) {
      connectWallet();
      return;
    }
    setConnecting(true);
    try {
      login();
    } catch (e) {
      setConnecting(false);
      throw e;
    }
  }, [authenticated, connectWallet, login]);

  const disconnect = useCallback(async () => {
    // Read the wallet before dismissing, since `wallet` is null once we do.
    const live = wallets[0] ?? null;
    setDismissed(true);
    setBalance(null);
    setNativeBalance(null);

    // Drop the site's authorisation at the wallet itself, the same thing the
    // injected backend does. Without it the wallet stays authorised, Privy
    // keeps listing it, and pressing Connect silently re-attaches the account
    // the user was trying to leave. Embedded wallets and older externals do
    // not implement the method; the flag above has already done the visible
    // work, so failing here is not a regression.
    if (live) {
      try {
        const provider = await live.getEthereumProvider();
        await provider.request({
          method: "wallet_revokePermissions",
          params: [{ eth_accounts: {} }],
        } as never);
      } catch { /* wallet does not support it */ }
    }

    // Only when there IS a session. Calling logout without one is a no-op at
    // best and an error at worst, and it must not mask the work above.
    if (authenticated) {
      try { await logout(); } catch { /* already gone */ }
    }
  }, [wallets, authenticated, logout, setBalance, setNativeBalance]);

  const switchChain = useCallback(async () => {
    if (!wallet) throw new Error("Connect a wallet first.");
    await wallet.switchChain(net.chainId);
    // A chain switch invalidates every resolved address.
    clearRegistryCache();
    resetClients();
  }, [wallet, net.chainId]);

  const getAccount = useCallback((): Address => {
    if (!address) throw new Error("Connect a wallet first.");
    return address;
  }, [address]);

  const walletName = !wallet
    ? "Privy"
    : wallet.walletClientType === "privy"
      ? "Float account"
      : prettyWalletName(wallet.walletClientType);

  const value = useMemo<FloatWallet>(() => ({
    connected: Boolean(address),
    // `ready` is Privy restoring an existing session. Reporting "not
    // connecting" through that window makes a returning user's wallet look
    // disconnected for a beat before it reappears.
    connecting: connecting || !ready,
    address,
    balance,
    nativeBalance,
    walletName,
    wrongChain: Boolean(address) && chainId !== null && chainId !== net.chainId,
    connect,
    disconnect,
    switchChain,
    refreshBalance,
    getAccount,
  }), [address, connecting, ready, balance, nativeBalance, walletName, chainId,
       net.chainId, connect, disconnect, switchChain, refreshBalance, getAccount]);

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

/**
 * The backend is Privy but no app id was built in. Everything that only reads
 * the chain still works; anything needing a signature says exactly what is
 * missing rather than failing as "no wallet found".
 */
function MisconfiguredWallet({ children }: { children: ReactNode }) {
  const net = activeNetwork();
  const value = useMemo<FloatWallet>(() => {
    const fail = async () => {
      throw new Error(
        "Wallet mode is privy but NEXT_PUBLIC_PRIVY_APP_ID is not set in this build.",
      );
    };
    return {
      connected: false,
      connecting: false,
      address: null,
      balance: null,
      nativeBalance: null,
      walletName: "Privy (not configured)",
      wrongChain: false,
      connect: fail,
      disconnect: async () => {},
      switchChain: fail,
      refreshBalance: async () => {},
      getAccount: () => {
        throw new Error(
          "Wallet mode is privy but NEXT_PUBLIC_PRIVY_APP_ID is not set in this build.",
        );
      },
    };
  }, [net.chainId]);
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}
