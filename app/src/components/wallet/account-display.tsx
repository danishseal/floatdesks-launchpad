"use client";

import { useCallback, useState } from "react";
import { Check, CopySimple, SignOut, Wallet } from "@phosphor-icons/react";
import { useFloorWallet } from "@/components/wallet/float-wallet-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { activeNetwork } from "@/lib/float/networks";
import { floatChain } from "@/lib/float/chain";

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 5)}...${address.slice(-4)}`;
}

/**
 * What the two balances are called.
 *
 * They were labelled CHANSE and "Floatdesk", which are ansem-1's token and this
 * app's own name: the wallet reads a USDG balance and a native gas balance and
 * announced neither. Both come from the active network now, because a ticker
 * typed in as a literal is how the previous pair survived a chain migration.
 */
function quoteTicker(): string {
  return activeNetwork().quoteSymbol;
}

function nativeTicker(): string {
  return floatChain().nativeCurrency.symbol;
}

function formatSol(balance: number): string {
  if (balance > 0 && balance < 0.0001) return "<0.0001";
  return balance.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}

export function AccountDisplay({
  className,
  compact = false,
  balanceOnly = false,
}: {
  className?: string;
  compact?: boolean;
  balanceOnly?: boolean;
} = {}) {
  const { address, balance, nativeBalance, walletName, disconnect } = useFloorWallet();
  const [copied, setCopied] = useState(false);

  const handleCopyAddress = useCallback(async () => {
    if (address) {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    }
  }, [address]);

  if (!address) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          aria-label={`Wallet ${truncateAddress(address)}`}
          className={cn(
            "min-w-0 max-w-full overflow-hidden border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] text-[var(--color-text-primary)] hover:border-[#3f3f46] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]",
            compact ? "size-10 px-0" : "w-full px-3 font-mono text-sm",
            className,
          )}
        >
          {compact ? (
            <Wallet size={17} weight="fill" />
          ) : balanceOnly ? (
            <>
              <Wallet size={17} weight="fill" className="shrink-0 text-[var(--color-text-secondary)]" />
              <span className="flex min-w-0 flex-col items-start font-sans text-[12px] font-semibold leading-tight">
                <span className="truncate">{balance === null ? "-" : formatSol(balance)} {quoteTicker()}</span>
                <span className="truncate text-[var(--color-text-secondary)]">{nativeBalance ? formatSol(nativeBalance) : "0"} {nativeTicker()}</span>
              </span>
            </>
          ) : (
            <>
              <span className="min-w-0 truncate">{truncateAddress(address)}</span>
              {balance !== null && (
                <>
                  <span className="shrink-0 text-[var(--color-text-subtle)]">|</span>
                  <span className="shrink-0">
                    {formatSol(balance)} {quoteTicker()}
                    {nativeBalance ? ` · ${formatSol(nativeBalance)} ${nativeTicker()}` : ""}
                  </span>
                </>
              )}
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-60 rounded-xl border-[var(--color-border-soft)] bg-[var(--color-bg-page)] p-2 text-[var(--color-text-primary)] shadow-2xl shadow-black/50"
      >
        <div className="px-2 pb-2 pt-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-subtle)]">
            Connected wallet
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-[var(--color-text-secondary)]">
              <Wallet size={16} weight="fill" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-mono text-xs font-semibold text-[var(--color-text-primary)]">
                {truncateAddress(address)}
              </p>
              <p className="mt-0.5 text-[10px] text-[var(--color-text-subtle)]">via {walletName}</p>
            </div>
          </div>
        </div>
        <div className="mb-1 space-y-1.5 rounded-lg bg-[var(--color-bg-raised)] px-3 py-2.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-[var(--color-text-muted)]">{quoteTicker()} balance</span>
            <span className="font-semibold text-[var(--color-text-primary)]">
              {balance === null ? "-" : `${formatSol(balance)} ${quoteTicker()}`}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[var(--color-text-muted)]">{nativeTicker()} balance</span>
            <span className="font-semibold text-[var(--color-text-primary)]">
              {nativeBalance ? `${formatSol(nativeBalance)} ${nativeTicker()}` : `0 ${nativeTicker()}`}
            </span>
          </div>
        </div>
        <DropdownMenuItem
          onClick={handleCopyAddress}
          className="h-10 cursor-pointer gap-2 rounded-lg px-3 text-xs text-[var(--color-text-secondary)] focus:bg-[var(--color-bg-raised)] focus:text-[var(--color-text-primary)]"
        >
          {copied ? <Check size={15} className="text-emerald-400" /> : <CopySimple size={15} />}
          {copied ? "Address copied" : "Copy address"}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => disconnect()}
          className="h-10 cursor-pointer gap-2 rounded-lg px-3 text-xs text-red-400 focus:bg-red-950/60 focus:text-red-300"
        >
          <SignOut size={15} />
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
