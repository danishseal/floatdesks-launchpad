"use client";

import { useFloorWallet } from "@/components/wallet/solana-wallet-provider";
import { Wallet } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { AccountDisplay } from "@/components/wallet/account-display";

export function ConnectButton({
  label,
  className,
  connectedClassName,
  compact = false,
  balanceOnly = false,
}: {
  label?: string;
  className?: string;
  connectedClassName?: string;
  compact?: boolean;
  balanceOnly?: boolean;
} = {}) {
  const { address, connecting, connect } = useFloorWallet();

  if (address) {
    return (
      <AccountDisplay className={connectedClassName} compact={compact} balanceOnly={balanceOnly} />
    );
  }

  return <Button aria-label="Connect wallet" onClick={() => connect()} disabled={connecting} className={`font-semibold ${className ?? ""}`}>
    {compact ? <Wallet size={18} weight="fill" /> : connecting ? "Connecting..." : label ?? "Connect Wallet"}
  </Button>;
}
