"use client";

/**
 * The wallet contract every backend satisfies, and the one context they share.
 *
 * This lives apart from the backends on purpose. `useFloatWallet` is imported
 * from nine places; if each backend created its own context, switching
 * NEXT_PUBLIC_WALLET_MODE would leave every one of those consumers reading a
 * provider that is no longer mounted and throwing "must be used within
 * FloatWalletProvider" at runtime. One context object, two implementations.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Address } from "viem";
import { balanceOf, publicClient } from "@/lib/float/chain";
import { resolve } from "@/lib/float/registry";

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

export const WalletCtx = createContext<FloatWallet | null>(null);

export function useFloatWallet(): FloatWallet {
  const ctx = useContext(WalletCtx);
  if (!ctx) throw new Error("useFloatWallet must be used within a wallet provider");
  return ctx;
}

/**
 * Quote and gas balances for an address, shared by both backends.
 *
 * Held here rather than duplicated so the two backends cannot drift into
 * reporting balances differently. On a failed read it keeps the previous
 * values instead of flashing zeros, because a zero balance is a claim and a
 * refused RPC call is not evidence for it.
 */
export function useWalletBalances(address: Address | null) {
  const [balance, setBalance] = useState<number | null>(null);
  const [nativeBalance, setNativeBalance] = useState<number | null>(null);

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
      setBalance(Number(raw) / 1e6);
      setNativeBalance(Number(native) / 1e18);
    } catch {
      /* leave prior values rather than flashing zeros */
    }
  }, [address]);

  useEffect(() => { void refreshBalance(); }, [refreshBalance]);

  return { balance, nativeBalance, refreshBalance, setBalance, setNativeBalance };
}
