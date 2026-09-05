"use client";

/**
 * Wallet layer for Robinhood Chain.
 *
 * Exports `FloatWalletProvider` and `useFloatWallet`. Two backends satisfy the
 * same context so switching is a config change, not a refactor:
 *   NEXT_PUBLIC_WALLET_MODE=injected   MetaMask / Rabby (default, no service)
 *   NEXT_PUBLIC_WALLET_MODE=privy      Privy embedded + email login
 * The Privy backend lives in privy-wallet-provider.tsx and is selected in
 * providers.tsx. Anything that needs to sign takes `getAccount()` and calls the
 * builders in lib/float/chain.ts, so no component knows which backend is live.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from "react";
import type { Address } from "viem";
import { activeNetwork } from "@/lib/float/networks";
import { balanceOf, publicClient, resetClients } from "@/lib/float/chain";
import { resolve, clearRegistryCache } from "@/lib/float/registry";

export interface FloatWallet {
  connected: boolean;
  connecting: boolean;
  address: Address | null;
  /** Quote-asset (USDG) balance in whole units, null until read. */
  balance: number | null;
  /** Native gas balance in whole units. */
  nativeBalance: number | null;
  walletName: string;
  /** True when the wallet is on a different chain than the active network. */
  wrongChain: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  switchChain: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  /** Throws with a readable message when not connected. */
  getAccount: () => Address;
}

const Ctx = createContext<FloatWallet | null>(null);
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
  const [balance, setBalance] = useState<number | null>(null);
  const [nativeBalance, setNativeBalance] = useState<number | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);

  const net = activeNetwork();

  const refreshBalance = useCallback(async () => {
    if (!address) {
      setBalance(null);
      setNativeBalance(null);
      return;
    }
    try {
      const [usdgAddr, native] = await Promise.all([
        resolve("USDG"),
        publicClient().getBalance({ address }),
      ]);
      const raw = await balanceOf(usdgAddr, address);
      // USDG is 6dp on every Robinhood Chain deployment, but read it rather
      // than assume: a mock on a fork could differ.
      setBalance(Number(raw) / 1e6);
      setNativeBalance(Number(native) / 1e18);
    } catch {
      /* leave prior values rather than flashing zeros */
    }
  }, [address]);

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
  }, []);

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

  useEffect(() => { void refreshBalance(); }, [refreshBalance]);

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

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFloatWallet(): FloatWallet {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFloatWallet must be used within FloatWalletProvider");
  return ctx;
}

/** Back-compat aliases so components migrated from the ansem build still resolve. */
export const SolanaWalletProvider = FloatWalletProvider;
export const useFloorWallet = useFloatWallet;
