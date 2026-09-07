/**
 * Link previews for a launched token.
 *
 * The page itself is a client component, so it cannot export metadata. This
 * layer sits above it purely to answer the crawlers: X, Telegram, Discord and
 * Slack all read the tags once and never run the app's JavaScript, so without
 * this a shared token link unfurls as the bare site title with no logo, which
 * is the form most people actually see a launch in.
 *
 * The image points at /api/float/token-image, not at the on-chain data: URI.
 * A data: URI in an og:image is ignored by every one of those crawlers, and
 * the tags need an absolute origin, which is taken from the request rather
 * than an env var so this works the same on the dev port and in production.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";
import { isAddress, type Address } from "viem";
import { cfTokenMeta, readTokenMeta } from "@/lib/float/curve-funder";

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  const { address } = await params;
  if (!isAddress(address)) return {};

  // Two sources, because they fail apart. TokenMetadata carries the launch's
  // logo and blurb but is empty for anything launched outside the wizard; the
  // ERC20's own name and symbol are always there. Take the richer one and fall
  // back to the token itself rather than to nothing.
  const [meta, erc20] = await Promise.all([
    readTokenMeta(address as Address).catch(() => null),
    cfTokenMeta(address as Address).catch(() => null),
  ]);
  const symbol = (meta?.symbol || erc20?.symbol)?.trim();
  const name = (meta?.name || erc20?.name)?.trim();
  // "NAME (SYM)" when both are known, whichever exists when one is, and the
  // address when the chain gave nothing rather than a title reading "undefined".
  const title = name && symbol ? `${name} (${symbol})` : name || symbol || `${address.slice(0, 10)}…`;
  const description =
    meta?.description?.trim() ||
    `${symbol || name || "This token"} on Floatdesk. Curve settled in a real stock, on chain, no presale.`;

  const site = await origin();
  const images = meta?.image && site ? [{ url: `${site}/api/float/token-image/${address}`, alt: title }] : [];

  return {
    title,
    description,
    openGraph: { title, description, images, type: "website", ...(site ? { url: `${site}/token/${address}` } : {}) },
    // summary, not summary_large_image: the logo is a square, and the wide
    // card would letterbox it into a strip of background.
    twitter: { card: "summary", title, description, images },
  };
}

export default function TokenLayout({ children }: { children: React.ReactNode }) {
  return children;
}
