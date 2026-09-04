"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

type CopyableBlockProps = {
  text: string;
  className?: string;
  truncate?: boolean;
};

export function CopyableBlock({
  text,
  className,
  truncate = true,
}: CopyableBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!text || !navigator.clipboard) return;

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => {
        void handleCopy();
      }}
      className={cn(
        "w-fit max-w-full min-w-0 rounded-lg border px-2 py-1 text-left font-mono text-sm transition-colors",
        copied
          ? "border-primary/60 bg-primary/20 text-primary"
          : "border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] text-zinc-700 hover:bg-[var(--color-bg-surface)]",
        className,
      )}
      title={copied ? "Copied" : "Click to copy"}
    >
      <span className={truncate ? "block truncate" : "block break-all"}>
        {text}
      </span>
    </button>
  );
}
