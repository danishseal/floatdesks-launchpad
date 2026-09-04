"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "hodl-launchpad-welcome-seen";

export function WelcomeModal() {
  const [open, setOpen] = useState(
    () => typeof window !== "undefined" && !localStorage.getItem(STORAGE_KEY),
  );

  function handleClose() {
    localStorage.setItem(STORAGE_KEY, "1");
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="max-w-md gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        {/* Header band */}
        <div className="bg-primary/10 border-b border-primary/20 px-6 pt-6 pb-4">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold text-zinc-900">
              Welcome to Floorlaunch
            </DialogTitle>
            <p className="mt-1 text-sm text-[var(--color-text-subtle)]">
              A fair-launch platform designed to reward builders and long-term holders.
            </p>
          </DialogHeader>
        </div>

        {/* Body */}
        <div className="space-y-4 px-6 py-5 text-sm text-zinc-700">
          <div>
            <h3 className="mb-1 font-semibold text-zinc-900">How it works</h3>
            <p>
              Every token launches on a bonding curve: price starts low and rises as people buy.
              Once the reserve hits the graduation threshold, liquidity auto-migrates to the AMM
              pool for open trading.
            </p>
          </div>

          <div>
            <h3 className="mb-1 font-semibold text-zinc-900">Non-extractive by design</h3>
            <p className="mb-2">
              The fee structure is intentionally asymmetric to discourage quick dumps and reward conviction:
            </p>
            <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] p-3">
                <span className="block text-xs text-[var(--color-text-muted)] uppercase tracking-wide">Buy fee</span>
                <span className="text-lg font-semibold text-blue-600">0.5%</span>
              </div>
                <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] p-3">
                <span className="block text-xs text-[var(--color-text-muted)] uppercase tracking-wide">Sell fee</span>
                <span className="text-lg font-semibold text-red-400">3.5%</span>
              </div>
            </div>
            <p className="text-xs text-[var(--color-text-muted)] mt-2">
              Low entry cost, higher exit cost, aligned with builders who stay, not extractors who flip.
            </p>
          </div>

          <div>
            <h3 className="mb-1 font-semibold text-zinc-900">Limited tickers, limited supply</h3>
            <p>
              Every token has a fixed supply on its bonding curve: no unlimited minting, no hidden inflation.
              Wallets are capped at 3% of total supply, so no single buyer can hog the curve.
              Tickers and names are locked with an 8-hour cooldown after each launch, so nobody can
              squat or spam the same idea. Combined with a creation fee, this keeps launches intentional
              and the ticker space clean.
            </p>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="px-6 pb-6 pt-2">
          <Button onClick={handleClose} className="w-full" size="lg">
            Got it, let&apos;s go
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
