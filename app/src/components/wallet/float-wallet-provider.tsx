"use client";

/**
 * Wallet layer for Robinhood Chain: the injected backend.
 *
 * Two backends satisfy the same context, so switching is a config change and
 * not a refactor:
 *   NEXT_PUBLIC_WALLET_MODE=injected   MetaMask / Rabby, no service (default)
 *   NEXT_PUBLIC_WALLET_MODE=privy      Privy embedded wallets + email login
 * The Privy backend is privy-wallet-provider.tsx; the shared contract and the
 * one context both of them fill are in wallet-context.ts, and the choice is
 * made in providers.tsx. Anything that needs to sign takes `getAccount()` and
 * calls the builders in lib/float/chain.ts, so no component knows which
 * backend is live.
 */

import {
  useCallback, useEffect, useMemo, useState, type ReactNode,
} from "react";
import type { Address } from "viem";
import { activeNetwork } from "@/lib/float/networks";
import { resetClients, setWalletClientFactory } from "@/lib/float/chain";
import { clearRegistryCache } from "@/lib/float/registry";
import {
  WalletCtx, useFloatWallet, useWalletBalances, type FloatWallet,
} from "./wallet-context";

const STORAGE_KEY = "float-wallet-connected";

interface Eip1193 {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: never[]) => void) => void;
  removeListener?: (event: string, handler: (...args: never[]) => void) => void;
}

function injected(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  return ((window as { ethereum?: Eip1193 }).ethereum) ?? null;
}

export function FloatWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [chainId, setChainId] = useState<number | null>(null);

  const net = activeNetwork();
  const { balance, nativeBalance, refreshBalance, setBalance, setNativeBalance } =
    useWalletBalances(address);

  // This backend signs through window.ethereum, which is what walletClient()
  // reaches for when no factory is registered. Clear any factory a previously
  // mounted backend left behind rather than inheriting its signer.
  useEffect(() => {
    setWalletClientFactory(null);
  }, []);

  const readChain = useCallback(async () => {
    const eth = injected();
    if (!eth) return;
    try {
      const id = (await eth.request({ method: "eth_chainId" })) as string;
      setChainId(Number.parseInt(id, 16));
    } catch {
      /* ignore */
    }
  }, []);

  const switchChain = useCallback(async () => {
    const eth = injected();
    if (!eth) throw new Error("No wallet found.");
    const hexId = `0x${net.chainId.toString(16)}`;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (e) {
      // 4902: chain unknown to the wallet, add it then retry.
      const code = (e as { code?: number }).code;
      if (code !== 4902) throw e;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hexId,
          chainName: net.label,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [net.rpc],
          blockExplorerUrls: [net.explorer],
        }],
      });
    }
    await readChain();
  }, [net, readChain]);

  const connect = useCallback(async () => {
    const eth = injected();
    if (!eth) throw new Error("No wallet found. Install MetaMask or Rabby.");
    setConnecting(true);
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      if (!accounts?.length) throw new Error("Wallet returned no accounts.");
      setAddress(accounts[0] as Address);
      await readChain();
      try { window.localStorage.setItem(STORAGE_KEY, "1"); } catch { /* private mode */ }
    } finally {
      setConnecting(false);
    }
  }, [readChain]);

  /**
   * Disconnect, and actually mean it.
   *
   * Clearing our own state is only half of it. The SITE stays authorised in
   * the wallet, so eth_requestAccounts returns the same account immediately
   * and without a prompt: pressing Disconnect then Connect reconnects you to
   * the wallet you were trying to leave, which reads as a broken button.
   *
   * wallet_revokePermissions drops that authorisation, so the next connect
   * shows the account picker. It is MetaMask 11.11+ and not in EIP-1193, so a
   * wallet without it throws and we fall through: state is still cleared,
   * which is the old behaviour rather than a regression.
   */
  const disconnect = useCallback(async () => {
    const eth = injected();
    setAddress(null);
    setBalance(null);
    setNativeBalance(null);
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
    if (!eth) return;
    try {
      await eth.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch { /* wallet does not support it; local state is already cleared */ }
  }, [setBalance, setNativeBalance]);

  const getAccount = useCallback((): Address => {
    if (!address) throw new Error("Connect a wallet first.");
    return address;
  }, [address]);

  // Reconnect silently when the wallet is still authorised.
  useEffect(() => {
    const eth = injected();
    if (!eth) return;
    let remembered = false;
    try { remembered = window.localStorage.getItem(STORAGE_KEY) === "1"; } catch { /* ignore */ }
    if (!remembered) return;
    void (async () => {
      const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
      if (accounts?.length) {
        setAddress(accounts[0] as Address);
        await readChain();
      }
    })();
  }, [readChain]);

  useEffect(() => {
    const eth = injected();
    if (!eth?.on) return;
    const onAccounts = (...args: never[]) => {
      const accounts = args[0] as unknown as string[];
      setAddress(accounts?.length ? (accounts[0] as Address) : null);
    };
    const onChain = (...args: never[]) => {
      const id = args[0] as unknown as string;
      setChainId(Number.parseInt(id, 16));
      // A chain switch invalidates every resolved address.
      clearRegistryCache();
      resetClients();
    };
    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const value = useMemo<FloatWallet>(() => ({
    connected: Boolean(address),
    connecting,
    address,
    balance,
    nativeBalance,
    walletName: "Injected wallet",
    wrongChain: Boolean(address) && chainId !== null && chainId !== net.chainId,
    connect,
    disconnect,
    switchChain,
    refreshBalance,
    getAccount,
  }), [address, connecting, balance, nativeBalance, chainId, net.chainId,
       connect, disconnect, switchChain, refreshBalance, getAccount]);

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

/** Re-exported so the nine existing consumers keep their import path. */
export { useFloatWallet };
export type { FloatWallet };

/** Back-compat aliases so components migrated from the ansem build still resolve. */
export const SolanaWalletProvider = FloatWalletProvider;
export const useFloorWallet = useFloatWallet;
