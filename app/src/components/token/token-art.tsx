"use client";

/**
 * A launched token's artwork, in the one place that knows how to draw it.
 *
 * This existed as sixteen copies of `<img src={token.image} class="...object-cover">`,
 * and every one of them had the same three holes:
 *
 *   - a URI the browser cannot fetch. The launch wizard offers "or paste
 *     ipfs://" and nothing anywhere turned that into a gateway URL, so every
 *     token launched that way drew a broken-image glyph forever.
 *   - a load failure. A dead https:// host, a gateway timing out, a data: URI
 *     that got truncated on the way in: all of it rendered as the browser's
 *     torn-page icon, in a grid, at card size.
 *   - eager decode. Sixteen to forty of these on a feed, each a base64 blob
 *     read off chain, all decoded on the main thread before first paint.
 *
 * The fallback is the symbol's first letter rather than a generic placeholder,
 * because in a grid the useful thing is still knowing which token you are
 * looking at.
 */

import { useState } from "react";

const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

/** Anything the browser will actually load, or null if there is nothing to draw. */
export function resolveTokenImage(src: string | null | undefined): string | null {
  const v = src?.trim();
  if (!v) return null;
  if (v.startsWith("ipfs://")) return `${IPFS_GATEWAY}${v.slice("ipfs://".length).replace(/^ipfs\//, "")}`;
  // A bare CID, which is what a few launches stored instead of a full URI.
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58})(\/.*)?$/.test(v)) return `${IPFS_GATEWAY}${v}`;
  if (/^(https?:|data:|blob:|\/)/i.test(v)) return v;
  return null;
}

export function TokenArt({
  src,
  symbol,
  alt,
  className = "",
  eager = false,
}: {
  src: string | null | undefined;
  symbol?: string | null;
  /** Omit on art that sits beside the token's own name: it reads twice. */
  alt?: string;
  /** Sizing, rounding and object-fit. Applied to the artwork and the fallback
   *  alike so the box does not change shape when there is no image. */
  className?: string;
  /** Set on art that is above the fold, where lazy loading costs a frame. */
  eager?: boolean;
}) {
  const url = resolveTokenImage(src);
  // Which URL failed, not whether one did. A virtualised row recycled onto a
  // different token has to retry, or one dead image poisons that slot for every
  // token that scrolls through it, and comparing against the current URL resets
  // during render without an effect that would cost a second pass.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = failedUrl !== null && failedUrl === url;

  if (!url || failed) {
    return (
      <span
        aria-hidden
        className={`flex items-center justify-center bg-[var(--color-bg-raised)] font-display font-semibold text-[var(--color-text-subtle)] ${className}`}
      >
        {symbol?.trim().slice(0, 1).toUpperCase() || "?"}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt ?? ""}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onError={() => setFailedUrl(url)}
      className={className}
    />
  );
}
