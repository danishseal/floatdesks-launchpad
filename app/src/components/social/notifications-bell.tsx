"use client";

/**
 * Notifications bell: an icon button in the top nav with an unread badge, opening
 * a dropdown panel that lists the connected wallet's notifications.
 *
 * Notifications are private (server-trust, like DMs), so reading them signs a
 * read-proof. To avoid prompting on every poll, the signature is cached and
 * reused (see useUnreadCount / useNotifications). The badge polls every ~30s once
 * the panel has been opened at least once (which is when the read-proof is
 * signed). Opening the panel marks everything read; a snapshot taken at open time
 * keeps the just-arrived rows highlighted while the panel stays open.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Bell } from "@phosphor-icons/react";
import { useFloorWallet } from "@/components/wallet/solana-wallet-provider";
import {
  useNotifications,
  useUnreadCount,
  useMarkNotificationsRead,
  useProfile,
  ensureNotifAuth,
  type Notification,
} from "@/lib/social";
import { Avatar, resolveIdentity, ago, errMsg } from "@/components/social/shared";

/** Stable empty set so an un-captured snapshot never allocates per render. */
const EMPTY_SNAPSHOT: ReadonlySet<string> = new Set();

/** Where a notification click should navigate. */
function routeFor(n: Notification): string {
  switch (n.kind) {
    case "follow":
      return n.actor ? `/creator/${n.actor}` : "/";
    case "dm":
      return `/messages?peer=${encodeURIComponent(n.dmPeer ?? n.actor ?? "")}`;
    case "like":
    case "repost":
    case "reply":
    case "mention":
      if (n.postId) return `/post/${encodeURIComponent(n.postId)}`;
      return n.actor ? `/creator/${n.actor}` : "/";
    default:
      return n.actor ? `/creator/${n.actor}` : "/";
  }
}

/** The human-readable action for a notification kind. */
function verbFor(kind: string): string {
  switch (kind) {
    case "follow":
      return "followed you";
    case "like":
      return "liked your post";
    case "repost":
      return "reposted your post";
    case "reply":
      return "replied to your post";
    case "comment":
      return "commented";
    case "mention":
      return "mentioned you";
    case "dm":
      return "sent you a message";
    default:
      return "interacted with you";
  }
}

export function NotificationsBell() {
  const wallet = useFloorWallet();
  const qc = useQueryClient();
  const unread = useUnreadCount(wallet);
  const markRead = useMarkNotificationsRead();

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function handleToggle() {
    const next = !open;
    setOpen(next);
    if (!next || !wallet.address) return;
    // Opening: sign the read-proof once (prompt only if not cached), load the
    // list, then mark everything read.
    try {
      await ensureNotifAuth(wallet);
      await qc.invalidateQueries({ queryKey: ["social", "notif", wallet.address] });
      await markRead.mutateAsync({ signer: wallet });
    } catch {
      /* user rejected the signature or is offline — leave the panel open */
    }
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => void handleToggle()}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          "relative flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-surface)] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--hairline-strong)] hover:text-[var(--color-text-primary)] " +
          (open ? "border-[var(--hairline-strong)] text-[var(--color-text-primary)]" : "")
        }
      >
        <Bell size={16} weight={unread > 0 ? "fill" : "bold"} />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-[var(--color-accent-solid)] px-1 font-mono text-[10px] font-bold tabular-nums text-[var(--color-on-accent)] ring-2 ring-[var(--color-bg-page)]">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--color-bg-surface)] shadow-2xl shadow-black/50">
          <Panel connected={Boolean(wallet.address)} onNavigate={() => setOpen(false)} onConnect={() => void wallet.connect().catch(() => {})} />
        </div>
      )}
    </div>
  );
}

function Panel({
  connected,
  onNavigate,
  onConnect,
}: {
  connected: boolean;
  onNavigate: () => void;
  onConnect: () => void;
}) {
  const wallet = useFloorWallet();
  const notifs = useNotifications(wallet);
  const items = notifs.data ?? [];

  // Snapshot which rows were unread at open time so they stay highlighted while
  // the panel is open, even after mark-all-read flips their stored flag. The
  // Panel remounts every time the dropdown opens (it is conditionally rendered),
  // so the snapshot captures once per open, the first render where data has
  // arrived. This is the React-sanctioned "adjust state during render" pattern
  // (guarded so it runs exactly once, no effect and no cascade).
  const [openSnapshot, setOpenSnapshot] = useState<ReadonlySet<string> | null>(null);
  if (openSnapshot === null && items.length) {
    setOpenSnapshot(new Set(items.filter((n) => !n.read).map((n) => n.id)));
  }
  const fresh = openSnapshot ?? EMPTY_SNAPSHOT;

  return (
    <div className="flex max-h-[70vh] flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--hairline)] px-4">
        <span className="font-display text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-secondary)]">
          Notifications
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!connected ? (
          <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
            <Bell size={26} weight="duotone" className="text-[var(--color-text-subtle)]" />
            <p className="text-[13px] text-[var(--color-text-secondary)]">Connect your wallet to see notifications.</p>
            <button
              type="button"
              onClick={onConnect}
              className="mt-1 inline-flex h-8 items-center rounded-lg bg-[var(--color-accent-solid)] px-3 text-[12px] font-semibold text-[var(--color-on-accent)] transition-opacity hover:opacity-90"
            >
              Connect wallet
            </button>
          </div>
        ) : notifs.isLoading ? (
          <p className="px-4 py-6 text-[13px] text-[var(--color-text-subtle)]">Loading…</p>
        ) : notifs.isError ? (
          <p className="px-4 py-6 text-[13px] text-[var(--color-negative)]">{errMsg(notifs.error)}</p>
        ) : items.length ? (
          <ul>
            {items.map((n) => (
              <NotificationRow key={n.id} n={n} fresh={fresh.has(n.id)} onNavigate={onNavigate} />
            ))}
          </ul>
        ) : (
          <div className="px-6 py-8 text-center">
            <p className="text-[13px] text-[var(--color-text-secondary)]">You&apos;re all caught up.</p>
            <p className="mt-1 text-[12px] text-[var(--color-text-subtle)]">
              Follows, likes, replies, mentions and messages will show up here.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function NotificationRow({
  n,
  fresh,
  onNavigate,
}: {
  n: Notification;
  fresh: boolean;
  onNavigate: () => void;
}) {
  const router = useRouter();
  const profile = useProfile(n.actor ?? "").data ?? {};
  const identity = resolveIdentity(profile, n.actor ?? "");

  return (
    <li>
      <button
        type="button"
        onClick={() => {
          onNavigate();
          router.push(routeFor(n));
        }}
        className={
          "flex w-full items-start gap-3 border-b border-[var(--hairline)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-bg-raised)] " +
          (fresh ? "bg-[#1f241f]" : "")
        }
      >
        <Avatar src={profile.avatar} className="h-9 w-9" iconSize={16} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[13px] text-[var(--color-text-primary)]">
              <span className="font-semibold text-[var(--color-text-primary)]">{identity.name}</span>{" "}
              <span className="text-[var(--color-text-secondary)]">{verbFor(n.kind)}</span>
            </span>
          </div>
          {n.preview && (
            <p className="mt-0.5 truncate text-[12px] text-[var(--color-text-muted)]">{n.preview}</p>
          )}
          <span className="mt-0.5 block font-mono text-[11px] text-[var(--color-text-subtle)]">{ago(n.createdAt)}</span>
        </div>
        {fresh && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--color-accent-solid)]" aria-hidden />}
      </button>
    </li>
  );
}
