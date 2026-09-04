"use client";

/**
 * Messages surface: a two-pane wallet-to-wallet DM client.
 *   left  = inbox (conversation list, unread badges)
 *   right = the open thread (message bubbles + a composer)
 *
 * DMs are private: reads and writes are both signed by the connected wallet, so
 * the pane only ever shows the signer's own conversations. This is server-trust
 * privacy, not end-to-end encryption (a future iteration).
 */

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { PaperPlaneRight, ChatCircleDots, ArrowLeft } from "@phosphor-icons/react";
import { toast } from "sonner";
import { useFloorWallet } from "@/components/wallet/solana-wallet-provider";
import { useProfile, useDmInbox, useDmThread, useSendDm, type DmThreadSummary } from "@/lib/social";
import { Avatar, resolveIdentity, short, ago, errMsg } from "@/components/social/shared";

export function Messages() {
  const wallet = useFloorWallet();
  const router = useRouter();
  const params = useSearchParams();
  const peer = params.get("peer") ?? "";

  if (!wallet.address) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <ChatCircleDots size={40} weight="duotone" className="text-[var(--color-text-subtle)]" />
        <h1 className="font-display text-[18px] font-semibold text-[var(--color-text-primary)]">Your messages</h1>
        <p className="max-w-sm text-[14px] text-[var(--color-text-muted)]">
          Connect your wallet to read and send private messages. Every message is
          signed by your wallet, so only you and the recipient can read them.
        </p>
        <button
          type="button"
          onClick={() => void wallet.connect().catch(() => {})}
          className="mt-1 inline-flex h-9 items-center rounded-lg bg-[var(--color-accent-solid)] px-4 text-[13px] font-semibold text-[var(--color-on-accent)] transition-opacity hover:opacity-90"
        >
          Connect wallet
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="mb-4 px-1 font-display text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)]">
        Messages
      </h1>
      <div className="grid min-h-[70vh] overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--color-bg-surface)] md:grid-cols-[300px_minmax(0,1fr)]">
        {/* Inbox pane: full-width on mobile until a thread is open */}
        <div
          className={
            "min-h-0 border-b border-[var(--hairline)] md:border-b-0 md:border-r " +
            (peer ? "hidden md:block" : "block")
          }
        >
          <InboxPane activePeer={peer} onOpen={(p) => router.push(`/messages?peer=${encodeURIComponent(p)}`)} />
        </div>
        {/* Thread pane */}
        <div className={"min-h-0 " + (peer ? "block" : "hidden md:block")}>
          {peer ? (
            <ThreadPane
              peer={peer}
              onBack={() => router.push("/messages")}
            />
          ) : (
            <div className="flex h-full min-h-[40vh] flex-col items-center justify-center gap-2 text-center text-[var(--color-text-subtle)]">
              <ChatCircleDots size={34} weight="duotone" />
              <p className="text-[13px]">Select a conversation</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InboxPane({ activePeer, onOpen }: { activePeer: string; onOpen: (peer: string) => void }) {
  const wallet = useFloorWallet();
  const inbox = useDmInbox(wallet);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center px-4 font-display text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
        Inbox
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {inbox.isLoading ? (
          <p className="px-4 py-6 text-[13px] text-[var(--color-text-subtle)]">Loading…</p>
        ) : inbox.isError ? (
          <p className="px-4 py-6 text-[13px] text-[var(--color-negative)]">{errMsg(inbox.error)}</p>
        ) : inbox.data && inbox.data.length ? (
          <ul>
            {inbox.data.map((t) => (
              <InboxRow key={t.peer} thread={t} active={t.peer === activePeer} onOpen={onOpen} />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-[13px] text-[var(--color-text-subtle)]">
            No conversations yet. Open someone&apos;s profile and hit Message to start one.
          </p>
        )}
      </div>
    </div>
  );
}

function InboxRow({
  thread,
  active,
  onOpen,
}: {
  thread: DmThreadSummary;
  active: boolean;
  onOpen: (peer: string) => void;
}) {
  const profile = useProfile(thread.peer).data ?? {};
  const identity = resolveIdentity(profile, thread.peer);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(thread.peer)}
        className={
          "flex w-full items-center gap-3 border-b border-[var(--hairline)] px-4 py-3 text-left transition-colors " +
          (active ? "bg-[var(--color-bg-raised)]" : "hover:bg-[var(--color-bg-raised)]")
        }
      >
        <Avatar src={profile.avatar} className="h-10 w-10" iconSize={18} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-sans text-[14px] font-semibold text-[var(--color-text-primary)]">
              {identity.name}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-[var(--color-text-subtle)]">{ago(thread.lastAt)}</span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="truncate text-[12px] text-[var(--color-text-muted)]">
              {thread.lastFromMe && <span className="text-[var(--color-text-subtle)]">You: </span>}
              {thread.lastMessage}
            </span>
            {thread.unread > 0 && (
              <span className="ml-1 inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-solid)] px-1 text-[11px] font-bold text-[var(--color-on-accent)]">
                {thread.unread}
              </span>
            )}
          </div>
        </div>
      </button>
    </li>
  );
}

function ThreadPane({ peer, onBack }: { peer: string; onBack: () => void }) {
  const wallet = useFloorWallet();
  const thread = useDmThread(peer, wallet);
  const send = useSendDm();
  const profile = useProfile(peer).data ?? {};
  const identity = resolveIdentity(profile, peer);
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest message in view when the thread loads / grows.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [thread.data?.length]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || !wallet.address) return;
    try {
      await send.mutateAsync({ sender: wallet.address, recipient: peer, text, signer: wallet });
      setDraft("");
    } catch (e) {
      toast.error("Could not send", { description: errMsg(e) });
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Thread header */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--hairline)] px-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-text-primary)] md:hidden"
          aria-label="Back to inbox"
        >
          <ArrowLeft size={18} weight="bold" />
        </button>
        <Link href={`/creator/${peer}`} className="flex min-w-0 items-center gap-3">
          <Avatar src={profile.avatar} className="h-9 w-9" iconSize={16} />
          <div className="min-w-0 leading-tight">
            <div className="truncate font-sans text-[14px] font-semibold text-[var(--color-text-primary)] hover:underline">
              {identity.name}
            </div>
            <div className="truncate font-mono text-[11px] text-[var(--color-text-muted)]">{short(peer)}</div>
          </div>
        </Link>
      </div>

      {/* Messages */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {thread.isLoading ? (
          <p className="text-[13px] text-[var(--color-text-subtle)]">Loading messages…</p>
        ) : thread.isError ? (
          <p className="text-[13px] text-[var(--color-negative)]">{errMsg(thread.error)}</p>
        ) : thread.data && thread.data.length ? (
          <div className="flex flex-col gap-2">
            {thread.data.map((m) => {
              const mine = m.sender === wallet.address;
              return (
                <div key={m.id} className={"flex " + (mine ? "justify-end" : "justify-start")}>
                  <div
                    className={
                      "max-w-[78%] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed " +
                      (mine
                        ? "rounded-br-md bg-[var(--color-accent-solid)] text-[var(--color-on-accent)]"
                        : "rounded-bl-md bg-[var(--color-bg-raised)] text-[var(--color-text-primary)]")
                    }
                    title={new Date(m.createdAt).toLocaleString()}
                  >
                    <span className="whitespace-pre-wrap break-words">{m.text}</span>
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        ) : (
          <p className="text-[13px] text-[var(--color-text-subtle)]">No messages yet. Say hi.</p>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-[var(--hairline)] p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            rows={1}
            maxLength={2000}
            placeholder="Write a message…"
            className="max-h-32 min-h-[40px] flex-1 resize-none rounded-xl border border-[var(--hairline)] bg-[var(--color-bg-page)] px-3 py-2.5 text-[14px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-subtle)] focus:border-[var(--hairline-strong)] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!draft.trim() || send.isPending}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent-solid)] text-[var(--color-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-40"
            aria-label="Send message"
          >
            <PaperPlaneRight size={18} weight="fill" />
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-[var(--color-text-subtle)]">
          Signed by your wallet. Only you and the recipient can read this conversation.
        </p>
      </div>
    </div>
  );
}
