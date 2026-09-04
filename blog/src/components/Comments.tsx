"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useEffect, useState } from "react";

type Comment = { id: string; author: string; text: string; ts: number };

export default function Comments() {
  const { ready, authenticated, user, login, logout, getAccessToken } =
    usePrivy();
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/comments")
      .then((r) => r.json())
      .then((d) => Array.isArray(d.comments) && setComments(d.comments))
      .catch(() => {});
  }, []);

  const authorLabel = () => {
    if (!user) return "you";
    if (user.email?.address) return user.email.address;
    const addr = user.wallet?.address;
    if (addr) return `${addr.slice(0, 4)}..${addr.slice(-4)}`;
    return "you";
  };

  const post = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "could not post");
        return;
      }
      setComments((prev) => [data.comment, ...prev]);
      setDraft("");
    } catch {
      setError("could not post");
    } finally {
      setBusy(false);
    }
  };

  const heading =
    comments.length === 0
      ? "No comments yet"
      : `${comments.length} comment${comments.length > 1 ? "s" : ""}`;

  return (
    <div
      id="comments"
      className="bg-[#1c1817] border border-zinc-800 rounded-2xl p-6 flex flex-col gap-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">{heading}</h2>
        {ready && authenticated && (
          <button
            type="button"
            onClick={logout}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {authorLabel()} · log out
          </button>
        )}
      </div>

      {ready && authenticated ? (
        <div className="flex flex-col gap-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a comment"
            rows={3}
            className="w-full bg-[#141111] border border-zinc-800 rounded-xl p-3 text-sm text-white placeholder:text-zinc-600 resize-none focus:outline-none focus:border-zinc-600"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            type="button"
            onClick={post}
            disabled={!draft.trim() || busy}
            className="self-end text-white text-sm font-medium px-4 py-2 rounded-xl transition-all duration-200 hover:-translate-y-0.5 active:scale-95 disabled:opacity-40 disabled:hover:translate-y-0"
            style={{ backgroundColor: "#3b82f6" }}
          >
            {busy ? "Posting…" : "Post"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={login}
          disabled={!ready}
          className="bg-[#e6ebfe] hover:bg-zinc-50 text-[#6c88f9] font-medium px-4 py-2 rounded-xl transition-colors w-full my-2 h-10 disabled:opacity-60"
        >
          {ready ? "Login to comment" : "Loading…"}
        </button>
      )}

      {comments.length > 0 && (
        <div className="flex flex-col gap-4 mt-2">
          {comments.map((c) => (
            <div
              key={c.id}
              className="flex flex-col gap-1 border-t border-white/[0.06] pt-3"
            >
              <div className="text-xs text-zinc-500 font-mono">{c.author}</div>
              <div className="text-sm text-zinc-300 whitespace-pre-wrap">
                {c.text}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
