"use client";

import { useEffect, useState } from "react";
import { Check, CopySimple, Sparkle } from "@phosphor-icons/react";
import { HORNS } from "@/lib/horns-catalog";

/** Fetches a Horn's raw source from /public/horns/<slug>.rs and renders it as a
 *  read-only, line-numbered code preview (GitHub-raw style, no external deps). */
export function HornCodeViewer({ slug }: { slug: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedAi, setCopiedAi] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCode(null);
    setError(false);
    fetch(`/horns/${slug}.rs`)
      .then((r) => {
        if (!r.ok) throw new Error("not found");
        return r.text();
      })
      .then((t) => {
        if (!cancelled) setCode(t);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function copy() {
    if (!code) return;
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  const path = slug.startsWith("_") ? "contracts/amm/src/hooks.rs" : `contracts/horn-${slug}/src/lib.rs`;
  const lines = code ? code.replace(/\n$/, "").split("\n") : [];
  const horn = HORNS.find((h) => h.slug === slug);

  // Copy a self-contained, AI-friendly bundle: explanation plus fenced source.
  async function copyForAi() {
    if (!code || !horn) return;
    const md =
      `# ansemchain Horn: ${horn.name} (${horn.category})\n\n` +
      `> ${horn.tagline}\n\n` +
      `${horn.blurb}\n\n` +
      `Hooks: ${horn.hooks.join(", ")}\n\n` +
      `Highlights:\n${horn.points.map((p) => `- ${p}`).join("\n")}\n\n` +
      `Source: ${path} (${lines.length} lines)\n\n` +
      "```rust\n" +
      `${code}\n` +
      "```\n";
    await navigator.clipboard.writeText(md);
    setCopiedAi(true);
    window.setTimeout(() => setCopiedAi(false), 1_500);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-bg-page)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3 py-2">
        <span className="truncate font-mono text-[11px] text-[var(--color-text-muted)]">
          {path}
          {code ? ` · ${lines.length} lines` : ""}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={copyForAi}
            disabled={!code || !horn}
            title="Copy the explanation plus source as one markdown block for an AI assistant"
            className="flex items-center gap-1.5 rounded-md border border-[#26343a] bg-[#12181b] px-2 py-1 font-mono text-[11px] text-[#7fd4e6] transition-colors hover:text-[#a6e6f2] disabled:opacity-40"
          >
            {copiedAi ? <Check size={12} className="text-[var(--color-accent-strong)]" weight="bold" /> : <Sparkle size={12} weight="fill" />}
            {copiedAi ? "Copied" : "Copy for AI"}
          </button>
          <button
            type="button"
            onClick={copy}
            disabled={!code}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-40"
          >
            {copied ? <Check size={12} className="text-[var(--color-accent-strong)]" weight="bold" /> : <CopySimple size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <div className="max-h-[68vh] overflow-auto">
        {error ? (
          <p className="px-4 py-10 text-center text-[13px] text-[var(--color-text-muted)]">Source unavailable.</p>
        ) : !code ? (
          <p className="px-4 py-10 text-center font-mono text-[12px] text-[var(--color-text-subtle)]">Loading source…</p>
        ) : (
          <pre className="min-w-max font-mono text-[12px] leading-[1.55]">
            {lines.map((ln, i) => {
              const isComment = /^\s*(\/\/|\/\*|\*)/.test(ln);
              const isAttr = /^\s*#\[/.test(ln);
              return (
                <div key={i} className="flex hover:bg-[var(--color-bg-surface)]/[0.02]">
                  <span
                    className="sticky left-0 z-10 select-none border-r border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3 text-right text-[11px] text-zinc-700"
                    style={{ minWidth: "3.5rem" }}
                  >
                    {i + 1}
                  </span>
                  <code
                    className={`whitespace-pre px-4 ${
                      isComment ? "text-[#5f8a67]" : isAttr ? "text-[#c9a26b]" : "text-[var(--color-text-secondary)]"
                    }`}
                  >
                    {ln || " "}
                  </code>
                </div>
              );
            })}
          </pre>
        )}
      </div>
    </div>
  );
}
