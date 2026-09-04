import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Real, server-side social store: profiles + a follow graph, persisted to disk
 * and shared across every viewer hitting this server. No external deps.
 *
 * Writes are serialized through an in-process queue and committed atomically
 * (temp file + rename). This is a single-process store; the shape is abstracted
 * so it can be swapped for Postgres/SQLite behind the same functions when the
 * app runs multi-instance / serverless.
 */

export type Profile = {
  /** Unique handle bound to this address (canonical lowercase, no leading @). */
  username?: string;
  displayName?: string;
  bio?: string;
  avatar?: string;
  banner?: string;
  twitter?: string;
  telegram?: string;
  /** A verified badge. Set ONLY via the reserve/claim path (a reservation's
   *  preset), never through a normal self-edit profile save. */
  verified?: boolean;
  updatedAt?: number;
};

/** 3-20 chars, lowercase letters / digits / underscore. */
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export class SocialError extends Error {
  constructor(public code: "username_taken" | "username_invalid", message: string) {
    super(message);
    this.name = "SocialError";
  }
}

/** Normalize a submitted handle: strip a leading @, lowercase, trim. */
export function canonicalUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

export type Post = {
  id: string;
  author: string;
  text: string;
  createdAt: number;
  /** Present on comments: the token address the comment is on. Also carries an
   *  attached token preview when a post links a token. */
  token?: string;
  /** Inline image data URL attached to the post. */
  image?: string;
  /** Id of a post this one quotes. */
  quoteOf?: string;
  /** Resolved + inlined on read when this post has a quoteOf. */
  quoted?: Post;
  /** The post's id in the on-chain ansem-social contract, when it was relayed
   *  on-chain (its text + author are signature-verified by the contract). */
  onchainId?: string;
  /** The tx hash that recorded this post on-chain (for an explorer link). */
  txhash?: string;
};

/** Optional attachments for a new post. */
export type PostOpts = { image?: string; token?: string; quoteOf?: string };

export type FollowEvent = { follower: string; target: string; createdAt: number };

/**
 * A direct message (wallet-to-wallet chat). Unlike a Post, a DM is private: it
 * is readable only by its sender or recipient. That privacy is server-trust,
 * NOT end-to-end encryption (the text is stored in plaintext); E2E is a future
 * iteration. `readAt` is set when the recipient has read the message.
 */
export type Message = {
  id: string;
  sender: string;
  recipient: string;
  text: string;
  createdAt: number;
  readAt?: number | null;
};

/** One inbox row: a conversation partner + the latest message + unread count. */
export type DmThreadSummary = {
  peer: string;
  lastMessage: string;
  lastAt: number;
  lastFromMe: boolean;
  unread: number;
};

/** A post plus its engagement counts (and viewer flags when a viewer is given). */
export type PostWithMeta = Post & {
  likeCount: number;
  repostCount: number;
  replyCount: number;
  viewerLiked?: boolean;
  viewerReposted?: boolean;
};

/**
 * An in-app notification, as returned to the app (public shape). A notification
 * is produced only as a SIDE EFFECT of another social write (a follow, a like /
 * repost / reply on your post, a DM, or an @mention). `read` is derived from the
 * stored read timestamp. The disk store keeps a richer internal row (with the
 * recipient + readAt) that maps to this on read.
 */
export type Notification = {
  id: string;
  /** follow | like | repost | reply | comment | mention | dm */
  kind: string;
  /** Who caused the notification. */
  actor?: string;
  /** The post it concerns (reply / like / repost / mention-in-post). */
  postId?: string;
  /** For a `dm`, the sender (so the client can open that conversation). */
  dmPeer?: string;
  /** Short text snippet (reply / mention / dm bodies). */
  preview?: string;
  read: boolean;
  createdAt: number;
};

/** The disk store's internal notification row (adds recipient + readAt). */
type StoredNotification = {
  id: string;
  recipient: string;
  kind: string;
  actor?: string;
  postId?: string;
  dmPeer?: string;
  preview?: string;
  readAt: number | null;
  createdAt: number;
};

type DB = {
  profiles: Record<string, Profile>;
  /** canonical username -> address (unique handle index) */
  usernames: Record<string, string>;
  /** follower address -> list of target addresses it follows */
  follows: Record<string, string[]>;
  /** user posts ("tweets"), newest last */
  posts: Post[];
  /** token address -> comments, newest last */
  comments: Record<string, Post[]>;
  /** follow events (for activity feeds), newest last */
  followEvents: FollowEvent[];
  /** post id -> addresses that liked it */
  postLikes: Record<string, string[]>;
  /** post id -> addresses that reposted it */
  postReposts: Record<string, string[]>;
  /** post id -> replies, newest last */
  postReplies: Record<string, Post[]>;
  /** direct messages (all conversations), newest last */
  dms: Message[];
  /** in-app notifications (all recipients), newest last */
  notifications: StoredNotification[];
};

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_PATH = path.join(DATA_DIR, "social.json");

// Profiles persist to the indexer's Postgres (persistent, works on a
// serverless read-only filesystem where the disk store below cannot). When
// SOCIAL_WRITE_TOKEN is set, the four profile functions use the remote store;
// otherwise they fall back to the local disk store (dev convenience).
const SOCIAL_API_BASE = (
  process.env.SOCIAL_API_BASE ??
  process.env.NEXT_PUBLIC_INDEXER_HTTP ??
  "https://api.ansemchain.fun/api"
).replace(/\/$/, "");
const SOCIAL_WRITE_TOKEN = process.env.SOCIAL_WRITE_TOKEN ?? "";
const useRemoteProfiles = SOCIAL_WRITE_TOKEN.length > 0;
// The rest of the SocialFi layer (follow graph, posts/feed, likes/reposts/
// replies, comments) persists to the same indexer Postgres under the same
// condition. Reads hit the public GET routes; writes POST with the bearer.
const useRemoteSocial = SOCIAL_WRITE_TOKEN.length > 0;

/** Bearer-authenticated POST to a social write endpoint. */
async function socialWrite<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SOCIAL_API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SOCIAL_WRITE_TOKEN}` },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `social store HTTP ${res.status}`);
  return data;
}

/**
 * Bearer-authenticated GET to a social read endpoint. Used for DM reads, which
 * (unlike public post/profile reads) are bearer-gated because they carry an
 * app-verified caller identity — a random public read of a private thread must
 * be impossible. `path` includes the query string.
 */
async function socialReadAuthed<T>(path: string): Promise<T> {
  const res = await fetch(`${SOCIAL_API_BASE}${path}`, {
    headers: { authorization: `Bearer ${SOCIAL_WRITE_TOKEN}` },
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `social store HTTP ${res.status}`);
  return data;
}

let cache: DB | null = null;
/**
 * Mtime of the on-disk file that `cache` was built from. Next.js bundles each
 * route handler as its own module-graph instance, so this module (and its
 * `cache`) exists once PER ROUTE, not once per server. The disk file is the only
 * thing all routes share. If `load()` memoized `cache` forever, a profile written
 * by the POST /api/social/profile route would never be seen by the GET
 * /api/social/profile/[address] route (its own cache was populated earlier and
 * never refreshed) - which is exactly why a saved profile did not appear even on
 * reload. So we re-read whenever the file's mtime has moved since we last read.
 */
let cachedMtimeMs = -1;
let queue: Promise<unknown> = Promise.resolve();

function emptyDB(): DB {
  return {
    profiles: {},
    usernames: {},
    follows: {},
    posts: [],
    comments: {},
    followEvents: [],
    postLikes: {},
    postReposts: {},
    postReplies: {},
    dms: [],
    notifications: [],
  };
}

/** Backfill any keys a persisted DB predates so callers never touch undefined. */
function normalize(db: DB): DB {
  if (!db.profiles) db.profiles = {};
  if (!db.usernames) db.usernames = {};
  if (!db.follows) db.follows = {};
  if (!db.posts) db.posts = [];
  if (!db.comments) db.comments = {};
  if (!db.followEvents) db.followEvents = [];
  if (!db.postLikes) db.postLikes = {};
  if (!db.postReposts) db.postReposts = {};
  if (!db.postReplies) db.postReplies = {};
  if (!db.dms) db.dms = [];
  if (!db.notifications) db.notifications = [];
  return db;
}

async function load(): Promise<DB> {
  let mtimeMs = -1;
  try {
    mtimeMs = (await fs.stat(DB_PATH)).mtimeMs;
  } catch {
    // No file yet: start empty and keep it until something is persisted.
    if (!cache) {
      cache = emptyDB();
      cachedMtimeMs = -1;
    }
    return normalize(cache);
  }
  // Re-read when we have nothing cached, or the file changed under us (another
  // route module, or another process, wrote to it since our last read).
  if (!cache || mtimeMs !== cachedMtimeMs) {
    try {
      cache = JSON.parse(await fs.readFile(DB_PATH, "utf8")) as DB;
    } catch {
      cache = emptyDB();
    }
    cachedMtimeMs = mtimeMs;
  }
  return normalize(cache);
}

async function persist(db: DB): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db), "utf8");
  await fs.rename(tmp, DB_PATH);
  // Track the freshly written file's mtime so this module's own next read does
  // not needlessly re-parse, while a DIFFERENT route module (with a different
  // cachedMtimeMs) still detects the change and reloads.
  cache = db;
  try {
    cachedMtimeMs = (await fs.stat(DB_PATH)).mtimeMs;
  } catch {
    cachedMtimeMs = -1;
  }
}

/** Serialize a read-modify-write so concurrent requests don't clobber. */
function withWrite<T>(fn: (db: DB) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const db = await load();
    const result = await fn(db);
    await persist(db);
    return result;
  });
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

// ── reads ───────────────────────────────────────────────────────────────────

export async function getProfile(address: string): Promise<Profile> {
  if (useRemoteProfiles) {
    const res = await fetch(`${SOCIAL_API_BASE}/social/profile/${address}`, { cache: "no-store" });
    if (!res.ok) return {};
    return ((await res.json()) as { profile?: Profile }).profile ?? {};
  }
  const db = await load();
  return db.profiles[address] ?? {};
}

export async function getGraph(address: string): Promise<{
  followers: string[];
  following: string[];
  followerCount: number;
  followingCount: number;
}> {
  if (useRemoteSocial) {
    const res = await fetch(`${SOCIAL_API_BASE}/social/graph/${address}`, { cache: "no-store" });
    if (!res.ok) return { followers: [], following: [], followerCount: 0, followingCount: 0 };
    const d = (await res.json()) as {
      followers?: string[]; following?: string[]; followerCount?: number; followingCount?: number;
    };
    const followers = d.followers ?? [];
    const following = d.following ?? [];
    return {
      followers,
      following,
      followerCount: d.followerCount ?? followers.length,
      followingCount: d.followingCount ?? following.length,
    };
  }
  const db = await load();
  const following = db.follows[address] ?? [];
  const followers = Object.keys(db.follows).filter((f) => (db.follows[f] ?? []).includes(address));
  return { followers, following, followerCount: followers.length, followingCount: following.length };
}

export async function isFollowing(follower: string, target: string): Promise<boolean> {
  if (useRemoteSocial) {
    const res = await fetch(
      `${SOCIAL_API_BASE}/social/is-following?follower=${encodeURIComponent(follower)}&target=${encodeURIComponent(target)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return false;
    return ((await res.json()) as { following?: boolean }).following ?? false;
  }
  const db = await load();
  return (db.follows[follower] ?? []).includes(target);
}

// ── writes ──────────────────────────────────────────────────────────────────

export async function upsertProfile(address: string, profile: Profile): Promise<Profile> {
  if (useRemoteProfiles) {
    const res = await fetch(`${SOCIAL_API_BASE}/social/profile`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SOCIAL_WRITE_TOKEN}` },
      body: JSON.stringify({ address, profile }),
    });
    const data = (await res.json().catch(() => ({}))) as { profile?: Profile; error?: string; code?: string };
    if (!res.ok) {
      if (data.code === "username_taken") throw new SocialError("username_taken", data.error ?? "username taken");
      if (data.code === "username_invalid") throw new SocialError("username_invalid", data.error ?? "invalid username");
      throw new Error(data.error ?? `profile store HTTP ${res.status}`);
    }
    return data.profile ?? {};
  }
  return withWrite((db) => {
    const next: Profile = { ...profile, updatedAt: Date.now() };

    // Reconcile the unique username index. A profile save is a full replace, so
    // treat an absent/blank username as "release my handle".
    const oldHandle = db.profiles[address]?.username;
    let newHandle: string | undefined;
    const submitted = typeof profile.username === "string" ? canonicalUsername(profile.username) : "";
    if (submitted) {
      if (!USERNAME_RE.test(submitted)) {
        throw new SocialError("username_invalid", "username must be 3-20 chars: a-z, 0-9, _");
      }
      const owner = db.usernames[submitted];
      if (owner && owner !== address) {
        throw new SocialError("username_taken", `@${submitted} is taken`);
      }
      newHandle = submitted;
    }
    if (newHandle !== oldHandle) {
      if (oldHandle && db.usernames[oldHandle] === address) delete db.usernames[oldHandle];
      if (newHandle) db.usernames[newHandle] = address;
    }
    next.username = newHandle;

    // Drop empty fields so they don't overwrite with blanks.
    (Object.keys(next) as (keyof Profile)[]).forEach((k) => {
      if (next[k] === "" || next[k] == null) delete next[k];
    });
    db.profiles[address] = next;
    return next;
  });
}

/**
 * Claim a reserved username with its one-time token, binding the reserved handle
 * + preset (and any verified badge) to `address`. The signature was already
 * verified by the Next route; we forward with the bearer to the remote store,
 * which consumes the token in one transaction and returns the resulting profile.
 * Claims require the remote (Postgres) store; the disk fallback cannot serve
 * them, so it throws.
 */
export async function claimUsername(address: string, token: string): Promise<Profile> {
  if (!useRemoteProfiles) {
    throw new Error("claims require the remote store");
  }
  const data = await socialWrite<{ profile?: Profile; error?: string }>("/social/claim", {
    token,
    address,
  });
  return data.profile ?? {};
}

/**
 * DELIBERATE, DOCUMENTED EXCEPTION to the wallet-signature identity model.
 *
 * Claim a reserved username WITHOUT a wallet — the raw claim token is the only
 * credential ("token-as-credential"). The claimed handle + preset (and verified
 * badge) bind to a SYNTHETIC owner id `token-<username>` (never a real bech32
 * wallet). No signature is involved: whoever holds the token controls the
 * account until a real wallet is bound (see `bindWallet`). Returns the created
 * profile and its synthetic `ownerId`. Requires the remote (Postgres) store.
 */
export async function claimUsernameNoWallet(
  token: string,
  profile?: Profile,
): Promise<{ profile: Profile; ownerId: string }> {
  if (!useRemoteProfiles) {
    throw new Error("claims require the remote store");
  }
  // First create the token-owned account (no address => token-account claim).
  const data = await socialWrite<{ profile?: Profile; ownerId?: string; error?: string }>(
    "/social/claim",
    { token },
  );
  const ownerId = data.ownerId ?? "";
  // If the caller supplied initial profile fields, apply them via the
  // token-authed editor so the account starts populated.
  if (profile && (profile.displayName || profile.bio || profile.avatar || profile.banner)) {
    const edited = await editTokenProfile(token, profile);
    return { profile: edited, ownerId };
  }
  return { profile: data.profile ?? {}, ownerId };
}

/**
 * Edit a TOKEN-OWNED account's mutable profile fields (displayName / bio /
 * avatar / banner) using the claim token as the credential — no wallet
 * signature. username + verified are locked server-side. Requires the remote
 * store.
 */
export async function editTokenProfile(token: string, profile: Profile): Promise<Profile> {
  if (!useRemoteProfiles) {
    throw new Error("token-profile edits require the remote store");
  }
  const data = await socialWrite<{ profile?: Profile; error?: string }>("/social/token-profile", {
    token,
    profile,
  });
  return data.profile ?? {};
}

/**
 * Bind a real wallet to a token-owned account. The wallet's signature was
 * already verified by the Next route (proving the new owner); we forward the
 * token + verified address to the indexer, which migrates ownership from
 * `token-<username>` to the wallet and spends the token. Requires the remote store.
 */
export async function bindWallet(address: string, token: string): Promise<Profile> {
  if (!useRemoteProfiles) {
    throw new Error("wallet binding requires the remote store");
  }
  const data = await socialWrite<{ profile?: Profile; error?: string }>("/social/bind-wallet", {
    token,
    address,
  });
  return data.profile ?? {};
}

/** Resolve a handle (with or without leading @) to its bound address, or null. */
export async function resolveUsername(raw: string): Promise<string | null> {
  if (useRemoteProfiles) {
    const res = await fetch(`${SOCIAL_API_BASE}/social/resolve/${encodeURIComponent(canonicalUsername(raw))}`, { cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { address?: string | null }).address ?? null;
  }
  const db = await load();
  const handle = canonicalUsername(raw);
  return db.usernames[handle] ?? null;
}

export type ProfileHit = { address: string } & Profile;

/** Search profiles by username, display name, or address prefix. */
export async function searchProfiles(query: string, limit = 8): Promise<ProfileHit[]> {
  if (useRemoteProfiles) {
    const res = await fetch(`${SOCIAL_API_BASE}/social/search?q=${encodeURIComponent(query)}&limit=${limit}`, { cache: "no-store" });
    if (!res.ok) return [];
    return ((await res.json()) as { hits?: ProfileHit[] }).hits ?? [];
  }
  const db = await load();
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const bare = q.replace(/^@+/, "");
  const hits: Array<{ hit: ProfileHit; rank: number }> = [];
  for (const [address, profile] of Object.entries(db.profiles)) {
    const uname = (profile.username ?? "").toLowerCase();
    const dname = (profile.displayName ?? "").toLowerCase();
    let rank = -1;
    if (uname && uname === bare) rank = 0;
    else if (uname && uname.startsWith(bare)) rank = 1;
    else if (dname && dname.startsWith(q)) rank = 2;
    else if (uname && uname.includes(bare)) rank = 3;
    else if (dname && dname.includes(q)) rank = 4;
    else if (address.toLowerCase().startsWith(bare)) rank = 5;
    if (rank >= 0) hits.push({ hit: { address, ...profile }, rank });
  }
  hits.sort((a, b) => a.rank - b.rank);
  return hits.slice(0, Math.min(limit, 25)).map((h) => h.hit);
}

export function setFollow(follower: string, target: string, follow: boolean): Promise<boolean> {
  if (useRemoteSocial) {
    return socialWrite<{ following?: boolean }>("/social/follow", { follower, target, follow }).then(
      (d) => d.following ?? follow,
    );
  }
  return withWrite((db) => {
    const set = new Set(db.follows[follower] ?? []);
    const wasFollowing = set.has(target);
    if (follow) set.add(target);
    else set.delete(target);
    db.follows[follower] = [...set];
    // Log a follow event for activity feeds (only on a new follow).
    if (follow && !wasFollowing) {
      db.followEvents.push({ follower, target, createdAt: Date.now() });
      emitLocalNotification(db, { recipient: target, kind: "follow", actor: follower });
    }
    return follow;
  });
}

export async function listFollowEvents(opts: { target?: string; limit?: number }): Promise<FollowEvent[]> {
  if (useRemoteSocial) {
    const qs = new URLSearchParams();
    if (opts.target) qs.set("target", opts.target);
    if (opts.limit != null) qs.set("limit", String(opts.limit));
    const res = await fetch(`${SOCIAL_API_BASE}/social/follow-events?${qs.toString()}`, { cache: "no-store" });
    if (!res.ok) return [];
    return ((await res.json()) as { events?: FollowEvent[] }).events ?? [];
  }
  const db = await load();
  const limit = Math.min(opts.limit ?? 50, 200);
  let list = db.followEvents;
  if (opts.target) list = list.filter((e) => e.target === opts.target || e.follower === opts.target);
  return [...list].reverse().slice(0, limit);
}

// ── posts + comments ─────────────────────────────────────────────────────────

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ── disk-store notification emitters (dev fallback) ───────────────────────────
//
// When SOCIAL_WRITE_TOKEN is unset the app IS the store (dev), so the same
// notification side effects the indexer produces are mirrored here off the disk
// writes. In production (remote store) none of these run — the indexer emits.

const MENTION_RE = /@([a-z0-9_]{3,20})/g;

function notifPreview(text: string): string | undefined {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 140) : undefined;
}

/** Push a notification row (never notify an actor about their own action). */
function emitLocalNotification(
  db: DB,
  n: {
    recipient: string;
    kind: string;
    actor?: string;
    postId?: string;
    dmPeer?: string;
    preview?: string;
  },
): void {
  if (!n.recipient) return;
  if (n.actor && n.recipient === n.actor) return;
  db.notifications.push({
    id: newId(),
    recipient: n.recipient,
    kind: n.kind,
    actor: n.actor,
    postId: n.postId,
    dmPeer: n.dmPeer,
    preview: n.preview,
    readAt: null,
    createdAt: Date.now(),
  });
}

/** Emit a `mention` per distinct, non-author, resolved @handle not in `exclude`. */
function emitLocalMentions(
  db: DB,
  opts: { text: string; actor: string; postId?: string; exclude?: Iterable<string> },
): void {
  const handles = new Set<string>();
  for (const m of (opts.text ?? "").matchAll(MENTION_RE)) handles.add(m[1].toLowerCase());
  if (!handles.size) return;
  const seen = new Set<string>(opts.exclude ?? []);
  seen.add(opts.actor);
  for (const handle of handles) {
    const address = db.usernames[handle];
    if (!address || seen.has(address)) continue;
    seen.add(address);
    emitLocalNotification(db, {
      recipient: address,
      kind: "mention",
      actor: opts.actor,
      postId: opts.postId,
      preview: notifPreview(opts.text),
    });
  }
}

export async function listPosts(opts: {
  author?: string;
  limit?: number;
  viewer?: string;
}): Promise<PostWithMeta[]> {
  if (useRemoteSocial) {
    const qs = new URLSearchParams();
    if (opts.author) qs.set("author", opts.author);
    if (opts.viewer) qs.set("viewer", opts.viewer);
    if (opts.limit != null) qs.set("limit", String(opts.limit));
    const res = await fetch(`${SOCIAL_API_BASE}/social/posts?${qs.toString()}`, { cache: "no-store" });
    if (!res.ok) return [];
    return ((await res.json()) as { posts?: PostWithMeta[] }).posts ?? [];
  }
  const db = await load();
  const limit = Math.min(opts.limit ?? 50, 200);
  let list = db.posts;
  if (opts.author) list = list.filter((p) => p.author === opts.author);
  return [...list]
    .reverse()
    .slice(0, limit)
    .map((p) => withMeta(db, p, opts.viewer));
}

/** Attach engagement counts (and viewer flags when a viewer is supplied). */
function withMeta(db: DB, p: Post, viewer?: string): PostWithMeta {
  const likes = db.postLikes[p.id] ?? [];
  const reposts = db.postReposts[p.id] ?? [];
  const replies = db.postReplies[p.id] ?? [];
  const meta: PostWithMeta = {
    ...p,
    likeCount: likes.length,
    repostCount: reposts.length,
    replyCount: replies.length,
  };
  // Inline the quoted post (one pass) so the card can render it without a
  // second fetch. Guard against a self-reference / missing target.
  if (p.quoteOf && p.quoteOf !== p.id) {
    const q = db.posts.find((x) => x.id === p.quoteOf);
    if (q) meta.quoted = { ...q, quoted: undefined };
  }
  if (viewer) {
    meta.viewerLiked = likes.includes(viewer);
    meta.viewerReposted = reposts.includes(viewer);
  }
  return meta;
}

export function addPost(
  author: string,
  text: string,
  opts?: PostOpts & { onchainId?: string; txhash?: string },
): Promise<Post> {
  if (useRemoteSocial) {
    return socialWrite<{ post?: Post }>("/social/post", {
      author,
      text,
      image: opts?.image,
      token: opts?.token,
      quoteOf: opts?.quoteOf,
      onchainId: opts?.onchainId,
      txhash: opts?.txhash,
    }).then((d) => d.post ?? { id: newId(), author, text, createdAt: Date.now() });
  }
  return withWrite((db) => {
    const post: Post = { id: newId(), author, text, createdAt: Date.now() };
    if (opts?.image) post.image = opts.image;
    if (opts?.token) post.token = opts.token;
    if (opts?.quoteOf) post.quoteOf = opts.quoteOf;
    if (opts?.onchainId) post.onchainId = opts.onchainId;
    if (opts?.txhash) post.txhash = opts.txhash;
    db.posts.push(post);
    emitLocalMentions(db, { text, actor: author, postId: post.id });
    return post;
  });
}

/** Does a post with this id exist? (used to validate a quoteOf target). */
export async function postExists(id: string): Promise<boolean> {
  if (useRemoteSocial) {
    const res = await fetch(`${SOCIAL_API_BASE}/social/post-exists/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return false;
    return ((await res.json()) as { exists?: boolean }).exists ?? false;
  }
  const db = await load();
  return db.posts.some((p) => p.id === id);
}

/**
 * A single post by id, with engagement counts (and viewer flags when a viewer is
 * supplied). Returns null when no post with that id exists. Backs the isolated
 * /post/[id] detail view.
 */
export async function getPost(id: string, viewer?: string): Promise<PostWithMeta | null> {
  if (useRemoteSocial) {
    const qs = viewer ? `?viewer=${encodeURIComponent(viewer)}` : "";
    const res = await fetch(`${SOCIAL_API_BASE}/social/post/${encodeURIComponent(id)}${qs}`, { cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { post?: PostWithMeta | null }).post ?? null;
  }
  const db = await load();
  const p = db.posts.find((x) => x.id === id);
  if (!p) return null;
  return withMeta(db, p, viewer);
}

// ── post engagement: likes, reposts, replies ─────────────────────────────────

/** Toggle a viewer's like on a post. Returns the new like count. */
export function togglePostLike(postId: string, user: string, like: boolean): Promise<{ count: number }> {
  if (useRemoteSocial) {
    return socialWrite<{ count?: number }>("/social/post-like", { postId, user, like }).then((d) => ({
      count: d.count ?? 0,
    }));
  }
  return withWrite((db) => {
    const set = new Set(db.postLikes[postId] ?? []);
    const had = set.has(user);
    if (like) set.add(user);
    else set.delete(user);
    db.postLikes[postId] = [...set];
    // Notify the post's author only on a NEW like.
    if (like && !had) {
      const author = db.posts.find((p) => p.id === postId)?.author;
      if (author) emitLocalNotification(db, { recipient: author, kind: "like", actor: user, postId });
    }
    return { count: set.size };
  });
}

/** Toggle a viewer's repost of a post. Returns the new repost count. */
export function togglePostRepost(
  postId: string,
  user: string,
  repost: boolean,
): Promise<{ count: number }> {
  if (useRemoteSocial) {
    return socialWrite<{ count?: number }>("/social/post-repost", { postId, user, repost }).then((d) => ({
      count: d.count ?? 0,
    }));
  }
  return withWrite((db) => {
    const set = new Set(db.postReposts[postId] ?? []);
    const had = set.has(user);
    if (repost) set.add(user);
    else set.delete(user);
    db.postReposts[postId] = [...set];
    // Notify the post's author only on a NEW repost.
    if (repost && !had) {
      const author = db.posts.find((p) => p.id === postId)?.author;
      if (author) emitLocalNotification(db, { recipient: author, kind: "repost", actor: user, postId });
    }
    return { count: set.size };
  });
}

export function addPostReply(
  postId: string,
  author: string,
  text: string,
  onchain?: { onchainId?: string; txhash?: string },
): Promise<Post> {
  if (useRemoteSocial) {
    return socialWrite<{ reply?: Post }>("/social/post-reply", {
      postId,
      author,
      text,
      onchainId: onchain?.onchainId,
      txhash: onchain?.txhash,
    }).then((d) => d.reply ?? { id: newId(), author, text, createdAt: Date.now() });
  }
  return withWrite((db) => {
    const reply: Post = { id: newId(), author, text, createdAt: Date.now() };
    if (onchain?.onchainId) reply.onchainId = onchain.onchainId;
    if (onchain?.txhash) reply.txhash = onchain.txhash;
    if (!db.postReplies[postId]) db.postReplies[postId] = [];
    db.postReplies[postId].push(reply);
    // Notify the parent post's author (reply), then @mentions in the body —
    // never the parent author twice (reply kind wins over a mention).
    const parent = db.posts.find((p) => p.id === postId)?.author;
    const exclude = new Set<string>();
    if (parent) {
      exclude.add(parent);
      emitLocalNotification(db, {
        recipient: parent, kind: "reply", actor: author, postId, preview: notifPreview(text),
      });
    }
    emitLocalMentions(db, { text, actor: author, postId, exclude });
    return reply;
  });
}

export async function listPostReplies(postId: string, limit = 100): Promise<Post[]> {
  if (useRemoteSocial) {
    const res = await fetch(
      `${SOCIAL_API_BASE}/social/replies?postId=${encodeURIComponent(postId)}&limit=${limit}`,
      { cache: "no-store" },
    );
    if (!res.ok) return [];
    return ((await res.json()) as { replies?: Post[] }).replies ?? [];
  }
  const db = await load();
  const list = db.postReplies[postId] ?? [];
  return [...list].reverse().slice(0, Math.min(limit, 300));
}

export async function listComments(token: string, limit = 100): Promise<Post[]> {
  if (useRemoteSocial) {
    const res = await fetch(
      `${SOCIAL_API_BASE}/social/comments/${encodeURIComponent(token)}?limit=${limit}`,
      { cache: "no-store" },
    );
    if (!res.ok) return [];
    return ((await res.json()) as { comments?: Post[] }).comments ?? [];
  }
  const db = await load();
  const list = db.comments[token] ?? [];
  return [...list].reverse().slice(0, Math.min(limit, 300));
}

export function addComment(token: string, author: string, text: string): Promise<Post> {
  if (useRemoteSocial) {
    return socialWrite<{ comment?: Post }>("/social/comment", { token, author, text }).then(
      (d) => d.comment ?? { id: newId(), author, text, token, createdAt: Date.now() },
    );
  }
  return withWrite((db) => {
    const comment: Post = { id: newId(), author, text, token, createdAt: Date.now() };
    if (!db.comments[token]) db.comments[token] = [];
    db.comments[token].push(comment);
    // A comment is on a token (no parent post author); only @mentions in the
    // body generate notifications, with no postId.
    emitLocalMentions(db, { text, actor: author });
    return comment;
  });
}

// ── trending / discovery ──────────────────────────────────────────────────────
//
// Public discovery surfaces (trending posts, trending hashtags, a hashtag feed,
// suggested follows). Remote-backed by the indexer's public GET routes; the disk
// fallback computes the same shapes from the in-process DB so dev works without
// the remote store. Reads only, all public.

/** A trending hashtag: the tag (no leading #) + its post counts. */
export type TrendingHashtag = { tag: string; count: number; posts24h: number };

/** A suggested profile to follow: a profile plus its follower/overlap counts. */
export type SuggestedProfile = { address: string } & Profile & {
  followerCount: number;
  mutual: number;
};

/** Whole-tag, case-insensitive test that `text` contains #<tag>. */
function textHasTag(text: string, tag: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])#${tag}([^A-Za-z0-9_]|$)`, "i").test(text);
}

/** All distinct lowercased hashtags in a post body. */
function extractTags(text: string): string[] {
  const out = new Set<string>();
  const re = /#([A-Za-z0-9_]{2,32})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1].toLowerCase());
  return [...out];
}

/** Main-feed posts ranked by a windowed engagement score with recency decay. */
export async function listTrendingPosts(opts: {
  windowHours?: number;
  limit?: number;
  viewer?: string;
}): Promise<PostWithMeta[]> {
  if (useRemoteSocial) {
    const qs = new URLSearchParams();
    if (opts.windowHours != null) qs.set("window", String(opts.windowHours));
    if (opts.limit != null) qs.set("limit", String(opts.limit));
    if (opts.viewer) qs.set("viewer", opts.viewer);
    const res = await fetch(`${SOCIAL_API_BASE}/social/trending/posts?${qs.toString()}`, { cache: "no-store" });
    if (!res.ok) return [];
    return ((await res.json()) as { posts?: PostWithMeta[] }).posts ?? [];
  }
  const db = await load();
  const windowMs = (opts.windowHours ?? 24) * 3600_000;
  const limit = Math.min(opts.limit ?? 30, 100);
  const now = Date.now();
  const cutoff = now - windowMs;
  const scored = db.posts
    .map((p) => {
      const likesW = (db.postLikes[p.id] ?? []).length; // disk store keeps no per-like ts
      const repostsW = (db.postReposts[p.id] ?? []).length;
      const repliesW = (db.postReplies[p.id] ?? []).filter((r) => r.createdAt >= cutoff).length;
      const raw = likesW + 2 * repostsW + 1.5 * repliesW;
      const ageH = (now - p.createdAt) / 3600_000;
      return { p, score: raw / Math.pow(ageH + 2, 1.5) };
    })
    .sort((a, b) => b.score - a.score || b.p.createdAt - a.p.createdAt)
    .slice(0, limit);
  return scored.map((s) => withMeta(db, s.p, opts.viewer));
}

/** Trending hashtags, ranked by distinct posts in the last 24h. */
export async function listTrendingHashtags(limit = 12): Promise<TrendingHashtag[]> {
  if (useRemoteSocial) {
    const res = await fetch(`${SOCIAL_API_BASE}/social/hashtags/trending?limit=${limit}`, { cache: "no-store" });
    if (!res.ok) return [];
    return ((await res.json()) as { tags?: TrendingHashtag[] }).tags ?? [];
  }
  const db = await load();
  const dayAgo = Date.now() - 24 * 3600_000;
  const all = new Map<string, number>();
  const recent = new Map<string, number>();
  for (const p of db.posts) {
    for (const tag of extractTags(p.text)) {
      all.set(tag, (all.get(tag) ?? 0) + 1);
      if (p.createdAt >= dayAgo) recent.set(tag, (recent.get(tag) ?? 0) + 1);
    }
  }
  return [...recent.entries()]
    .map(([tag, posts24h]) => ({ tag, count: all.get(tag) ?? posts24h, posts24h }))
    .sort((a, b) => b.posts24h - a.posts24h || b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, Math.min(limit, 50));
}

/** Recent main-feed posts containing #<tag>. */
export async function listHashtagPosts(
  tag: string,
  opts: { limit?: number; viewer?: string } = {},
): Promise<PostWithMeta[]> {
  const clean = tag.replace(/^#/, "").toLowerCase();
  if (useRemoteSocial) {
    const qs = new URLSearchParams();
    if (opts.limit != null) qs.set("limit", String(opts.limit));
    if (opts.viewer) qs.set("viewer", opts.viewer);
    const res = await fetch(`${SOCIAL_API_BASE}/social/hashtag/${encodeURIComponent(clean)}?${qs.toString()}`, { cache: "no-store" });
    if (!res.ok) return [];
    return ((await res.json()) as { posts?: PostWithMeta[] }).posts ?? [];
  }
  const db = await load();
  const limit = Math.min(opts.limit ?? 50, 200);
  return [...db.posts]
    .reverse()
    .filter((p) => textHasTag(p.text, clean))
    .slice(0, limit)
    .map((p) => withMeta(db, p, opts.viewer));
}

/** Suggested follows for `me` (nullable), ranked by follower count + overlap. */
export async function listSuggestedFollows(me: string | null, limit = 8): Promise<SuggestedProfile[]> {
  if (useRemoteSocial) {
    const qs = new URLSearchParams();
    if (me) qs.set("me", me);
    qs.set("limit", String(limit));
    const res = await fetch(`${SOCIAL_API_BASE}/social/suggested-follows?${qs.toString()}`, { cache: "no-store" });
    if (!res.ok) return [];
    return ((await res.json()) as { profiles?: SuggestedProfile[] }).profiles ?? [];
  }
  const db = await load();
  const myFollows = new Set(me ? db.follows[me] ?? [] : []);
  // follower counts
  const followerCount = new Map<string, number>();
  for (const targets of Object.values(db.follows)) {
    for (const t of targets) followerCount.set(t, (followerCount.get(t) ?? 0) + 1);
  }
  // follows-of-follows overlap: accounts followed by the people `me` follows.
  const mutual = new Map<string, number>();
  if (me) {
    for (const f of myFollows) {
      for (const t of db.follows[f] ?? []) mutual.set(t, (mutual.get(t) ?? 0) + 1);
    }
  }
  const candidates = new Set<string>([...followerCount.keys(), ...Object.keys(db.profiles)]);
  return [...candidates]
    .filter((a) => a !== me && !a.startsWith("token-") && !myFollows.has(a))
    .map((address) => ({
      address,
      ...(db.profiles[address] ?? {}),
      followerCount: followerCount.get(address) ?? 0,
      mutual: mutual.get(address) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.mutual - a.mutual ||
        b.followerCount - a.followerCount ||
        (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
        a.address.localeCompare(b.address),
    )
    .slice(0, Math.min(limit, 50));
}

// ── direct messages (wallet-to-wallet chat) ──────────────────────────────────
//
// Privacy is server-trust, NOT end-to-end encryption: the Next.js route verifies
// the caller's ADR-36 signature and forwards only the VERIFIED address, so a DM
// thread is reachable solely by its two participants. Both the send AND the two
// reads carry the bearer, since a read also carries an app-verified identity.
// E2E encryption is a future iteration.

/** Send a DM from `sender` (already verified upstream) to `recipient`. */
export function sendDm(sender: string, recipient: string, text: string): Promise<Message> {
  if (useRemoteSocial) {
    return socialWrite<{ message?: Message }>("/social/dm", { sender, recipient, text }).then(
      (d) => d.message ?? { id: newId(), sender, recipient, text, createdAt: Date.now() },
    );
  }
  return withWrite((db) => {
    const message: Message = { id: newId(), sender, recipient, text, createdAt: Date.now(), readAt: null };
    db.dms.push(message);
    // Notify the recipient of a received DM (dmPeer = the sender).
    emitLocalNotification(db, {
      recipient, kind: "dm", actor: sender, dmPeer: sender, preview: notifPreview(text),
    });
    return message;
  });
}

/**
 * The conversation between `me` and `peer`, oldest->newest (chat order). Marks
 * peer->me messages read as a side effect of the me-authenticated read.
 */
export async function getDmThread(me: string, peer: string, limit = 200): Promise<Message[]> {
  if (useRemoteSocial) {
    const qs = new URLSearchParams({ me, peer, limit: String(limit) });
    const d = await socialReadAuthed<{ messages?: Message[] }>(`/social/dm/thread?${qs.toString()}`);
    return d.messages ?? [];
  }
  return withWrite((db) => {
    const now = Date.now();
    for (const m of db.dms) {
      if (m.recipient === me && m.sender === peer && m.readAt == null) m.readAt = now;
    }
    const pair = db.dms.filter(
      (m) =>
        (m.sender === me && m.recipient === peer) ||
        (m.sender === peer && m.recipient === me),
    );
    // Take the most-recent `limit`, then present oldest->newest.
    return pair
      .slice(-Math.min(limit, 500))
      .sort((a, b) => a.createdAt - b.createdAt);
  });
}

/** The inbox for `me`: one summary per conversation partner, most-recent first. */
export async function getDmInbox(me: string, limit = 100): Promise<DmThreadSummary[]> {
  if (useRemoteSocial) {
    const qs = new URLSearchParams({ me, limit: String(limit) });
    const d = await socialReadAuthed<{ threads?: DmThreadSummary[] }>(`/social/dm/inbox?${qs.toString()}`);
    return d.threads ?? [];
  }
  const db = await load();
  const byPeer = new Map<string, { last: Message; unread: number }>();
  for (const m of db.dms) {
    if (m.sender !== me && m.recipient !== me) continue;
    const peer = m.sender === me ? m.recipient : m.sender;
    const cur = byPeer.get(peer) ?? { last: m, unread: 0 };
    if (m.createdAt >= cur.last.createdAt) cur.last = m;
    if (m.recipient === me && m.sender === peer && m.readAt == null) cur.unread += 1;
    byPeer.set(peer, cur);
  }
  return [...byPeer.entries()]
    .map(([peer, { last, unread }]) => ({
      peer,
      lastMessage: last.text,
      lastAt: last.createdAt,
      lastFromMe: last.sender === me,
      unread,
    }))
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, Math.min(limit, 300));
}

// ── notifications (private, same server-trust model as DMs) ───────────────────
//
// The Next route verifies the reader's signature and passes only the VERIFIED
// `me`; these reads/mark are bearer-gated on the remote just like DMs. Rows are
// produced only as side effects of other writes (emitted by the indexer, or by
// the disk emitters above in dev). Remote branch hits the indexer; the disk
// fallback serves the same shape from the local store.

/** Map an internal stored row to the app's public Notification shape. */
function toNotification(n: StoredNotification): Notification {
  return {
    id: n.id,
    kind: n.kind,
    actor: n.actor,
    postId: n.postId,
    dmPeer: n.dmPeer,
    preview: n.preview,
    read: n.readAt != null,
    createdAt: n.createdAt,
  };
}

/** The caller's notifications, newest-first. */
export async function getNotifications(me: string, limit = 50): Promise<Notification[]> {
  if (useRemoteSocial) {
    const qs = new URLSearchParams({ me, limit: String(limit) });
    const d = await socialReadAuthed<{ items?: Notification[] }>(`/social/notifications?${qs.toString()}`);
    return d.items ?? [];
  }
  const db = await load();
  return db.notifications
    .filter((n) => n.recipient === me)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.min(limit, 100))
    .map(toNotification);
}

/** The caller's unread notification count. */
export async function getUnreadCount(me: string): Promise<number> {
  if (useRemoteSocial) {
    const qs = new URLSearchParams({ me });
    const d = await socialReadAuthed<{ count?: number }>(
      `/social/notifications/unread-count?${qs.toString()}`,
    );
    return d.count ?? 0;
  }
  const db = await load();
  return db.notifications.filter((n) => n.recipient === me && n.readAt == null).length;
}

/** Mark the listed notification ids read, or ALL of `me`'s unread when omitted. */
export async function markNotificationsRead(me: string, ids?: string[]): Promise<number> {
  if (useRemoteSocial) {
    const d = await socialWrite<{ marked?: number }>("/social/notifications/read", { me, ids });
    return d.marked ?? 0;
  }
  return withWrite((db) => {
    const now = Date.now();
    const idSet = ids ? new Set(ids) : null;
    let marked = 0;
    for (const n of db.notifications) {
      if (n.recipient !== me || n.readAt != null) continue;
      if (idSet && !idSet.has(n.id)) continue;
      n.readAt = now;
      marked += 1;
    }
    return marked;
  });
}
