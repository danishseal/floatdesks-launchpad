"use client";

import { Search as SearchIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Post = { title: string; sub: string; href: string };
type TokenResult = {
  ticker: string;
  name: string;
  href: string;
  image: string | null;
};

/** flFROG -> $FROG (the launched ticker carries an "fl" prefix). */
const fmtTicker = (t: string) =>
  t.toLowerCase().startsWith("fl") ? `$${t.slice(2)}` : `$${t}`;

/** Blog posts, extend as the series grows. */
const POSTS: Post[] = [
  {
    title: "The Last Supper, Panel I: a token that owns a price",
    sub: "What commas is and how it works.",
    href: "/blog",
  },
];

/**
 * Token source. Defaults to the local indexer for dev; point
 * NEXT_PUBLIC_TOKENS_API at the commas.art token API in production.
 */
const TOKENS_API =
  process.env.NEXT_PUBLIC_TOKENS_API ?? "http://localhost:8787/listings";

const API_ORIGIN = (() => {
  try {
    return new URL(TOKENS_API).origin;
  } catch {
    return "";
  }
})();

/** Resolve a token image URL, prefixing relative indexer paths. */
function resolveImg(img: unknown): string | null {
  if (!img || typeof img !== "string") return null;
  if (/^(https?:|data:)/.test(img)) return img;
  return API_ORIGIN + (img.startsWith("/") ? img : `/${img}`);
}

export default function SearchModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [tokens, setTokens] = useState<TokenResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    fetch(TOKENS_API)
      .then((r) => r.json())
      .then((d) => {
        const list: TokenResult[] = Object.values(d ?? {})
          .filter((x: any) => x?.ticker)
          .map((x: any) => ({
            ticker: String(x.ticker),
            name: String(x.name ?? x.ticker),
            href: "https://launch.commas.art",
            image: resolveImg(x.image),
          }));
        setTokens(list);
      })
      .catch(() => setTokens([]));
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const query = q.trim().toLowerCase();
  const posts = POSTS.filter(
    (p) =>
      !query ||
      p.title.toLowerCase().includes(query) ||
      p.sub.toLowerCase().includes(query)
  );
  const toks = tokens
    .filter(
      (t) =>
        !query ||
        t.ticker.toLowerCase().includes(query) ||
        t.name.toLowerCase().includes(query)
    )
    .slice(0, 8);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-28 px-4 bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-[#1c1817] border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 h-12 border-b border-zinc-800">
          <SearchIcon className="w-4 h-4 text-zinc-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search posts and tokens"
            className="flex-1 bg-transparent text-sm text-white placeholder:text-zinc-600 focus:outline-none"
          />
          <kbd className="text-[10px] text-zinc-600 border border-zinc-700 rounded px-1.5 py-0.5">
            esc
          </kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {posts.length > 0 && (
            <div className="mb-2">
              <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-zinc-600">
                Posts
              </div>
              {posts.map((p) => (
                <Link
                  key={p.href}
                  href={p.href}
                  onClick={onClose}
                  className="flex flex-col gap-0.5 px-3 py-2 rounded-lg hover:bg-white/5 transition-colors"
                >
                  <span className="text-sm text-white">{p.title}</span>
                  <span className="text-xs text-zinc-500">{p.sub}</span>
                </Link>
              ))}
            </div>
          )}
          <div>
            <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-zinc-600">
              Tokens
            </div>
            {toks.length === 0 ? (
              <div className="px-3 py-2 text-xs text-zinc-600">
                {query ? "No tokens match." : "Type to search tokens."}
              </div>
            ) : (
              toks.map((t) => (
                <Link
                  key={t.ticker}
                  href={t.href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={onClose}
                  className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg hover:bg-white/5 transition-colors"
                >
                  <span className="flex items-center gap-3 min-w-0">
                    {t.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={t.image}
                        alt=""
                        className="w-7 h-7 rounded-full object-cover shrink-0 bg-[#141111]"
                      />
                    ) : (
                      <span className="w-7 h-7 rounded-full shrink-0 bg-[#141111] border border-zinc-800" />
                    )}
                    <span className="text-sm text-white truncate">{t.name}</span>
                  </span>
                  <span className="text-xs font-mono text-zinc-500 shrink-0">
                    {fmtTicker(t.ticker)}
                  </span>
                </Link>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
