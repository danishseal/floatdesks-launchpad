"use client";

import Link from "next/link";
import { useMemo } from "react";
import { formatDistanceToNow } from "date-fns";
import { User } from "@phosphor-icons/react";
import { useTokens } from "@/hooks/use-tokens";
import { DEFAULT_TOKEN_SUPPLY } from "@/lib/chain-config";
import type { TokenListItem } from "@/lib/api";

/** Cap on the decoded size of an inline post image (matches profile-edit). */
export const POST_IMAGE_MAX_BYTES = 900 * 1024;

/**
 * Read an image file, downscale it on a canvas, and return a compressed data URL.
 * Mirrors the approach in components/utoken/profile-edit.tsx so inline post
 * images stay small enough to store in the JSON post record.
 */
export async function downscaleImage(file: File, opts: { maxEdge: number }): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("That file isn't an image. Pick a PNG, JPG, or WebP.");
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("That image couldn't be decoded."));
    el.src = dataUrl;
  });

  const scale = Math.min(1, opts.maxEdge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image processing isn't available in this browser.");
  ctx.drawImage(img, 0, 0, w, h);

  let out = canvas.toDataURL("image/webp", 0.85);
  if (!out.startsWith("data:image/webp")) {
    out = canvas.toDataURL("image/jpeg", 0.85);
  }

  const b64 = out.split(",")[1] ?? "";
  const bytes = Math.floor((b64.length * 3) / 4);
  if (bytes > POST_IMAGE_MAX_BYTES) {
    throw new Error("That image is too large even after resizing. Try a smaller one.");
  }
  return out;
}

/* ---------------- formatting ---------------- */

export function short(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a;
}

export function ago(ts: number): string {
  return formatDistanceToNow(new Date(ts), { addSuffix: true });
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function capUsd(t: TokenListItem): number {
  return (Number(t.current_price) / 1e6) * t.market.solUsd * DEFAULT_TOKEN_SUPPLY;
}

export function usdCompact(v: number): string {
  return Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(v || 0);
}

/* ---------------- identity (name / @username) ---------------- */

/**
 * Resolve how a user's identity should render, X-style:
 *  - `name`       the primary line (display name if set, else @username, else a
 *                 shortened address as a last resort).
 *  - `handle`     the `@username`, or null when there is no username.
 *  - `showHandle` true ONLY when BOTH a display name and a username exist, so the
 *                 header shows two lines (name on top, muted @username below).
 *                 When only one identity exists, it lives on the single top line.
 * Feed rows and the profile header both derive from this so they stay consistent.
 */
export function resolveIdentity(
  p: { displayName?: string; username?: string },
  address: string,
): { name: string; handle: string | null; showHandle: boolean } {
  const hasName = Boolean(p.displayName);
  const hasUser = Boolean(p.username);
  const name = p.displayName || (p.username ? `@${p.username}` : short(address));
  const handle = p.username ? `@${p.username}` : null;
  return { name, handle, showHandle: hasName && hasUser };
}

/**
 * Shared post-header identity: the display name (bold) with the relative time on
 * the first line and, when a display name AND username both exist, the muted
 * `@username` on a second line beneath it - the two-line X layout. Used by the
 * feed PostCard so every row renders identity the same way.
 */
export function PostIdentity({
  profile,
  address,
  createdAt,
}: {
  profile: { displayName?: string; username?: string };
  address: string;
  createdAt: number;
}) {
  const { name, handle, showHandle } = resolveIdentity(profile, address);
  return (
    <div className="min-w-0 leading-tight">
      <div className="flex items-center gap-x-1.5">
        <Link
          href={`/creator/${address}`}
          onClick={(e) => e.stopPropagation()}
          className="truncate font-sans text-[14px] font-semibold text-[var(--color-text-primary)] hover:underline"
        >
          {name}
        </Link>
        <span className="text-[12px] text-[var(--color-text-subtle)]">·</span>
        <span
          className="shrink-0 font-mono text-[12px] text-[var(--color-text-subtle)]"
          title={new Date(createdAt).toLocaleString()}
        >
          {ago(createdAt)}
        </span>
      </div>
      {showHandle && handle && (
        <Link
          href={`/creator/${address}`}
          onClick={(e) => e.stopPropagation()}
          className="block truncate font-mono text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
        >
          {handle}
        </Link>
      )}
    </div>
  );
}

/* ---------------- avatar ---------------- */

export function Avatar({
  src,
  className = "",
  iconSize = 18,
}: {
  src?: string;
  className?: string;
  iconSize?: number;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--color-bg-raised)] ring-1 ring-inset ring-white/10 ${className}`}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <User size={iconSize} weight="fill" className="text-[var(--color-text-subtle)]" />
      )}
    </span>
  );
}

/* ---------------- token lookup ---------------- */

/** Resolve a token address to its list record (from the shared token cache). */
export function useToken(address?: string): TokenListItem | undefined {
  const { data: tokens } = useTokens();
  return useMemo(
    () => (address ? (tokens ?? []).find((t) => t.address === address) : undefined),
    [tokens, address],
  );
}

/**
 * Compact token-preview banner: image + $SYMBOL + name + mcap + 24h%, linking to
 * the token page. Used inside a post body and inside a quoted embed.
 */
export function TokenPreviewBanner({
  address,
  size = "md",
}: {
  address: string;
  size?: "md" | "sm";
}) {
  const token = useToken(address);
  const dim = size === "sm" ? "h-8 w-8" : "h-10 w-10";
  const sym = size === "sm" ? "text-[12px]" : "text-[13px]";

  const inner = (
    <div className="flex items-center gap-2.5 rounded-xl border border-[var(--hairline)] bg-[var(--color-bg-page)] px-3 py-2 transition-colors hover:border-[var(--hairline-strong)]">
      <div className={`${dim} shrink-0 overflow-hidden rounded-md border border-[var(--hairline)] bg-[var(--color-bg-raised)]`}>
        {token?.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={token.image} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full items-center justify-center font-mono text-[11px] text-[var(--color-text-subtle)]">
            {token?.symbol?.slice(0, 1) ?? "?"}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={`truncate font-display ${sym} font-semibold text-[var(--color-accent-strong)]`}>
            ${token?.symbol ?? short(address)}
          </span>
          {token?.name && (
            <span className="truncate font-sans text-[12px] text-[var(--color-text-muted)]">{token.name}</span>
          )}
        </div>
        {token && (
          <div className="mt-0.5 flex items-center gap-2">
            <span className="font-mono text-[11px] text-[var(--color-text-secondary)]">{usdCompact(capUsd(token))}</span>
            {token.price_change_24h != null && (
              <span
                className={`font-mono text-[11px] ${token.price_change_24h >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}`}
              >
                {token.price_change_24h >= 0 ? "+" : ""}
                {token.price_change_24h.toFixed(1)}%
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <Link
      href={`/token/${address}`}
      className="mt-2 block"
      onClick={(e) => e.stopPropagation()}
      aria-label={`View ${token?.symbol ?? "token"}`}
    >
      {inner}
    </Link>
  );
}
