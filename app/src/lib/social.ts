"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SocialSignature } from "@/components/wallet/solana-wallet-provider";
import {
  canonicalSocialMessage,
  editProfileSignAction,
  followSignAction,
  commentSignAction,
  dmSendSignAction,
  dmReadSignAction,
  notificationsReadSignAction,
  claimUsernameSignAction,
  bindWalletSignAction,
} from "@/lib/social-sign";

/**
 * Frontend social client - talks to the real server API (/api/social/*).
 * Reads are cached with react-query; writes are authenticated by a signature
 * from the connected wallet (ADR-36 where the wallet supports signArbitrary,
 * otherwise a SIGN_MODE_DIRECT sign doc), so a user can only edit their own
 * profile or act as themselves.
 */

export type Profile = {
  username?: string;
  displayName?: string;
  bio?: string;
  avatar?: string;
  banner?: string;
  twitter?: string;
  telegram?: string;
  /** A verified badge (set only via the reserve/claim flow). */
  verified?: boolean;
};

export type Graph = {
  /** Addresses that follow this user. */
  followers: string[];
  /** Addresses this user follows. */
  following: string[];
  followerCount: number;
  followingCount: number;
  viewerFollows: boolean;
};

/** Matches the server's socialAuthMessage(action, ts). */
function authMessage(action: string, ts: number): string {
  return `ansem social: ${action}\nts: ${ts}`;
}

export interface Signer {
  address: string | null;
  signSocial: (message: string) => Promise<SocialSignature>;
}

// ── reads ─────────────────────────────────────────────────────────────────

export function useProfile(address: string) {
  return useQuery({
    queryKey: ["social", "profile", address],
    queryFn: async (): Promise<Profile> => {
      const r = await fetch(`/api/social/profile/${address}`);
      if (!r.ok) return {};
      const j = (await r.json()) as { profile?: Profile };
      return j.profile ?? {};
    },
    enabled: Boolean(address),
    staleTime: 60_000,
  });
}

export function useGraph(address: string, viewer?: string | null) {
  return useQuery({
    queryKey: ["social", "graph", address, viewer ?? ""],
    queryFn: async (): Promise<Graph> => {
      const qs = viewer ? `?viewer=${encodeURIComponent(viewer)}` : "";
      const r = await fetch(`/api/social/graph/${address}${qs}`);
      if (!r.ok) return { followers: [], following: [], followerCount: 0, followingCount: 0, viewerFollows: false };
      return (await r.json()) as Graph;
    },
    enabled: Boolean(address),
    staleTime: 30_000,
  });
}

// ── writes (signed) ─────────────────────────────────────────────────────────

export async function saveProfile(address: string, profile: Profile, signer: Signer): Promise<Profile> {
  const ts = Date.now();
  const sig = await signer.signSocial(authMessage(editProfileSignAction(), ts));
  const r = await fetch("/api/social/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, profile, ts, ...sig }),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string; code?: string };
    const err = new Error(body.error ?? "Could not save profile") as Error & { code?: string };
    err.code = body.code;
    throw err;
  }
  return ((await r.json()) as { profile: Profile }).profile;
}

/**
 * Claim a reserved username with its one-time token, signed by the acting
 * wallet. The signature binds the exact token; on success the reserved handle +
 * preset (and any verified badge) bind to the caller's address.
 */
export async function claimUsername(address: string, token: string, signer: Signer): Promise<Profile> {
  const ts = Date.now();
  const sig = await signer.signSocial(authMessage(claimUsernameSignAction(token), ts));
  const r = await fetch("/api/social/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, token, ts, ...sig }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not claim username");
  return ((await r.json()) as { profile: Profile }).profile;
}

/**
 * Claim a reserved username. On success, invalidates the claimer's profile so
 * the newly bound handle / preset / verified badge show immediately.
 */
export function useClaimUsername() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ address, token, signer }: { address: string; token: string; signer: Signer }) =>
      claimUsername(address, token, signer),
    onSuccess: (_p, { address }) => {
      void qc.invalidateQueries({ queryKey: ["social", "profile", address] });
    },
  });
}

// ── token-as-credential claim (claim without a wallet, bind one later) ────────
//
// DELIBERATE, DOCUMENTED EXCEPTION to the wallet-signature identity model. A
// reserved handle can be claimed with the claim token alone (no wallet); the
// token then acts as the edit credential for the resulting `token-<username>`
// account. A real wallet is bound later — THAT step re-introduces a signature.

/**
 * Claim a reserved username WITHOUT a wallet. The token is the only credential;
 * the resulting account is owned by a synthetic `token-<username>` id. Returns
 * the created profile and its ownerId.
 */
export async function claimUsernameNoWallet(
  token: string,
  profile?: Profile,
): Promise<{ profile: Profile; ownerId: string }> {
  const r = await fetch("/api/social/claim-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, profile }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not claim username");
  return (await r.json()) as { profile: Profile; ownerId: string };
}

/**
 * Edit a token-owned account's profile with the claim token as the credential
 * (no wallet signature). username + verified are locked server-side.
 */
export async function editTokenProfile(token: string, profile: Profile): Promise<Profile> {
  const r = await fetch("/api/social/token-profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, profile }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not save profile");
  return ((await r.json()) as { profile: Profile }).profile;
}

/**
 * Bind a real wallet to a token-owned account. This step DOES require a wallet
 * signature (binding the exact token): the token proves the account, the
 * signature proves the new wallet. On success ownership migrates to the wallet
 * and the token is spent.
 */
export async function bindWallet(address: string, token: string, signer: Signer): Promise<Profile> {
  const ts = Date.now();
  const sig = await signer.signSocial(authMessage(bindWalletSignAction(token), ts));
  const r = await fetch("/api/social/bind-wallet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, token, ts, ...sig }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not bind wallet");
  return ((await r.json()) as { profile: Profile }).profile;
}

/** Claim a reserved handle with only the token (no wallet). */
export function useClaimNoWallet() {
  return useMutation({
    mutationFn: ({ token, profile }: { token: string; profile?: Profile }) =>
      claimUsernameNoWallet(token, profile),
  });
}

/** Edit a token-owned account's profile using the token credential. */
export function useEditTokenProfile() {
  return useMutation({
    mutationFn: ({ token, profile }: { token: string; profile: Profile }) =>
      editTokenProfile(token, profile),
  });
}

/**
 * Bind a real wallet to a token-owned account. On success, invalidates the
 * wallet's profile so the migrated handle / preset / verified badge show up.
 */
export function useBindWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ address, token, signer }: { address: string; token: string; signer: Signer }) =>
      bindWallet(address, token, signer),
    onSuccess: (_p, { address }) => {
      void qc.invalidateQueries({ queryKey: ["social", "profile", address] });
    },
  });
}

export async function setFollow(
  follower: string,
  target: string,
  follow: boolean,
  signer: Signer,
): Promise<boolean> {
  const ts = Date.now();
  const sig = await signer.signSocial(authMessage(followSignAction(target, follow), ts));
  const r = await fetch("/api/social/follow", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ follower, target, follow, ts, ...sig }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not update follow");
  return ((await r.json()) as { following: boolean }).following;
}

// ── posts ("tweets") + token comments ───────────────────────────────────────

export type Post = {
  id: string;
  author: string;
  text: string;
  createdAt: number;
  /** Attached token address (a preview) or, on comments, the commented token. */
  token?: string;
  /** Inline image data URL. */
  image?: string;
  /** Id of a post this one quotes. */
  quoteOf?: string;
  /** Resolved + inlined by the server when this post quotes another. */
  quoted?: Post;
  /** Engagement counts (present on the feed list). */
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  /** Present when a viewer is supplied to usePosts. */
  viewerLiked?: boolean;
  viewerReposted?: boolean;
  /** The post's id in the on-chain ansem-social contract, when relayed on-chain. */
  onchainId?: string;
  /** The tx hash that recorded this post on-chain (for an explorer link). */
  txhash?: string;
};

/** Global (or by-author) timeline. Pass `viewer` to get like/repost flags + reconcile toggles. */
export function usePosts(viewer?: string | null, author?: string) {
  return useQuery({
    queryKey: ["social", "posts", author ?? "all", viewer ?? ""],
    queryFn: async (): Promise<Post[]> => {
      const params = new URLSearchParams();
      if (author) params.set("author", author);
      if (viewer) params.set("viewer", viewer);
      const qs = params.toString();
      const r = await fetch(`/api/social/post${qs ? `?${qs}` : ""}`);
      if (!r.ok) return [];
      return ((await r.json()) as { posts: Post[] }).posts ?? [];
    },
    staleTime: 15_000,
  });
}

/** Mutate every cached posts list so an optimistic toggle shows everywhere. */
function patchCachedPosts(
  qc: ReturnType<typeof useQueryClient>,
  postId: string,
  patch: (p: Post) => Post,
) {
  qc.setQueriesData<Post[]>({ queryKey: ["social", "posts"] }, (old) =>
    old ? old.map((p) => (p.id === postId ? patch(p) : p)) : old,
  );
  // Also patch the single-post detail cache (/post/[id]) so its counts + flags
  // reflect the same optimistic toggle.
  qc.setQueriesData<Post | null>({ queryKey: ["social", "post", postId] }, (old) =>
    old && old.id === postId ? patch(old) : old,
  );
}

/** A single post by id (+ engagement counts), for the isolated /post/[id] view. */
export function usePost(id: string, viewer?: string | null) {
  return useQuery({
    queryKey: ["social", "post", id, viewer ?? ""],
    queryFn: async (): Promise<Post | null> => {
      const qs = viewer ? `?viewer=${encodeURIComponent(viewer)}` : "";
      const r = await fetch(`/api/social/post/${encodeURIComponent(id)}${qs}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("Could not load post");
      return ((await r.json()) as { post: Post }).post;
    },
    enabled: Boolean(id),
    staleTime: 15_000,
    retry: false,
  });
}

/** Like / unlike a post, signed by the acting wallet. Returns the new count. */
export async function toggleLike(
  postId: string,
  viewer: string,
  like: boolean,
  signer: Signer,
  onchainId?: string,
): Promise<{ count: number }> {
  const ts = Date.now();
  // Sign the contract's canonical message so the same signature verifies both
  // off-chain and (when the target is on-chain) at the relay. `subject` is the
  // target's on-chain id when it has one, else its off-chain id (which just
  // never relays). Like is a toggle on-chain; ts keeps each action's message
  // unique so a like then unlike are distinct signed messages.
  const subject = onchainId ?? postId;
  const sig = await signer.signSocial(canonicalSocialMessage("like", subject, ts, ""));
  const r = await fetch("/api/social/post/like", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ postId, subject, user: viewer, like, ts, ...sig }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not like");
  return (await r.json()) as { count: number };
}

/** Repost / un-repost a post, signed by the acting wallet. Returns the new count. */
export async function toggleRepost(
  postId: string,
  viewer: string,
  repost: boolean,
  signer: Signer,
  onchainId?: string,
): Promise<{ count: number }> {
  const ts = Date.now();
  const subject = onchainId ?? postId;
  const sig = await signer.signSocial(canonicalSocialMessage("repost", subject, ts, ""));
  const r = await fetch("/api/social/post/repost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ postId, subject, user: viewer, repost, ts, ...sig }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not repost");
  return (await r.json()) as { count: number };
}

/** Optimistic like mutation: flips the cached flag/count, reconciles on settle. */
export function useLikePost(viewer?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postId, like, signer, onchainId }: { postId: string; like: boolean; signer: Signer; onchainId?: string }) => {
      if (!viewer) throw new Error("Connect a wallet first.");
      return toggleLike(postId, viewer, like, signer, onchainId);
    },
    onMutate: async ({ postId, like }) => {
      await qc.cancelQueries({ queryKey: ["social", "posts"] });
      await qc.cancelQueries({ queryKey: ["social", "post", postId] });
      const prev = qc.getQueriesData<Post[]>({ queryKey: ["social", "posts"] });
      const prevOne = qc.getQueriesData<Post | null>({ queryKey: ["social", "post", postId] });
      patchCachedPosts(qc, postId, (p) => ({
        ...p,
        viewerLiked: like,
        likeCount: Math.max(0, (p.likeCount ?? 0) + (like ? 1 : -1)),
      }));
      return { prev, prevOne };
    },
    onError: (_e, _v, ctx) => {
      ctx?.prev.forEach(([key, data]) => qc.setQueryData(key, data));
      ctx?.prevOne.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: (_d, _e, { postId }) => {
      void qc.invalidateQueries({ queryKey: ["social", "posts"] });
      void qc.invalidateQueries({ queryKey: ["social", "post", postId] });
    },
  });
}

/** Optimistic repost mutation: flips the cached flag/count, reconciles on settle. */
export function useRepostPost(viewer?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postId, repost, signer, onchainId }: { postId: string; repost: boolean; signer: Signer; onchainId?: string }) => {
      if (!viewer) throw new Error("Connect a wallet first.");
      return toggleRepost(postId, viewer, repost, signer, onchainId);
    },
    onMutate: async ({ postId, repost }) => {
      await qc.cancelQueries({ queryKey: ["social", "posts"] });
      await qc.cancelQueries({ queryKey: ["social", "post", postId] });
      const prev = qc.getQueriesData<Post[]>({ queryKey: ["social", "posts"] });
      const prevOne = qc.getQueriesData<Post | null>({ queryKey: ["social", "post", postId] });
      patchCachedPosts(qc, postId, (p) => ({
        ...p,
        viewerReposted: repost,
        repostCount: Math.max(0, (p.repostCount ?? 0) + (repost ? 1 : -1)),
      }));
      return { prev, prevOne };
    },
    onError: (_e, _v, ctx) => {
      ctx?.prev.forEach(([key, data]) => qc.setQueryData(key, data));
      ctx?.prevOne.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: (_d, _e, { postId }) => {
      void qc.invalidateQueries({ queryKey: ["social", "posts"] });
      void qc.invalidateQueries({ queryKey: ["social", "post", postId] });
    },
  });
}

/** A post's replies, newest first. */
export function usePostReplies(postId: string, enabled = true) {
  return useQuery({
    queryKey: ["social", "replies", postId],
    queryFn: async (): Promise<Post[]> => {
      const r = await fetch(`/api/social/post/reply?postId=${encodeURIComponent(postId)}`);
      if (!r.ok) return [];
      return ((await r.json()) as { replies: Post[] }).replies ?? [];
    },
    enabled: Boolean(postId) && enabled,
    staleTime: 15_000,
  });
}

/** Reply to a post, signed by the acting wallet. */
export async function addPostReply(
  postId: string,
  author: string,
  text: string,
  signer: Signer,
  onchainId?: string,
): Promise<Post> {
  const ts = Date.now();
  const subject = onchainId ?? postId;
  const sig = await signer.signSocial(canonicalSocialMessage("reply", subject, ts, text));
  const r = await fetch("/api/social/post/reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ postId, subject, author, text, ts, ...sig }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not reply");
  return ((await r.json()) as { reply: Post }).reply;
}

/** Optional attachments for a new post. */
export type PostAttachments = { image?: string; token?: string; quoteOf?: string };

export async function addPost(
  author: string,
  text: string,
  signer: Signer,
  opts?: PostAttachments,
): Promise<Post> {
  const ts = Date.now();
  // Sign the on-chain contract's canonical message (text only) so the one
  // signature is valid both at the off-chain store and the on-chain relay.
  // Attachments are sent as metadata; they are not bound by this signature.
  const sig = await signer.signSocial(canonicalSocialMessage("post", "", ts, text));
  const r = await fetch("/api/social/post", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      author,
      text,
      image: opts?.image,
      token: opts?.token,
      quoteOf: opts?.quoteOf,
      ts,
      ...sig,
    }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not post");
  return ((await r.json()) as { post: Post }).post;
}

/** Convenience: quote an existing post with optional text / image / token. */
export function quotePost(
  author: string,
  text: string,
  quoteOf: string,
  signer: Signer,
  extra?: { image?: string; token?: string },
): Promise<Post> {
  return addPost(author, text, signer, { ...extra, quoteOf });
}

export type FollowEvent = { follower: string; target: string; createdAt: number };

export function useFollowEvents(target?: string) {
  return useQuery({
    queryKey: ["social", "events", target ?? "all"],
    queryFn: async (): Promise<FollowEvent[]> => {
      const qs = target ? `?target=${encodeURIComponent(target)}` : "";
      const r = await fetch(`/api/social/events${qs}`);
      if (!r.ok) return [];
      return ((await r.json()) as { events: FollowEvent[] }).events ?? [];
    },
    staleTime: 15_000,
  });
}

export function useComments(token: string) {
  return useQuery({
    queryKey: ["social", "comments", token],
    queryFn: async (): Promise<Post[]> => {
      const r = await fetch(`/api/social/comments/${token}`);
      if (!r.ok) return [];
      return ((await r.json()) as { comments: Post[] }).comments ?? [];
    },
    enabled: Boolean(token),
    staleTime: 15_000,
  });
}

export async function addComment(token: string, author: string, text: string, signer: Signer): Promise<Post> {
  const ts = Date.now();
  const sig = await signer.signSocial(authMessage(commentSignAction(token, text), ts));
  const r = await fetch("/api/social/comment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ author, token, text, ts, ...sig }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not comment");
  return ((await r.json()) as { comment: Post }).comment;
}

// ── direct messages (wallet-to-wallet chat) ──────────────────────────────────
//
// Privacy: DMs are NOT public. A conversation is readable ONLY by its two
// participants. Every DM request — the send AND the two reads — carries a wallet
// signature; the Next route verifies it, then acts only as/for the VERIFIED
// address. So even a read proves you own the address before it returns a thread.
// This is server-trust privacy, NOT end-to-end encryption (a future iteration).

export type DmMessage = {
  id: string;
  sender: string;
  recipient: string;
  text: string;
  createdAt: number;
  /** Set once the recipient has read this message. */
  readAt?: number | null;
};

export type DmThreadSummary = {
  /** The other party in the conversation. */
  peer: string;
  lastMessage: string;
  lastAt: number;
  /** True when the latest message was sent BY the inbox owner. */
  lastFromMe: boolean;
  /** Count of unread messages from `peer` to the inbox owner. */
  unread: number;
};

/** Send a DM, signed by the sender's wallet (binds recipient + text). */
export async function sendDm(
  sender: string,
  recipient: string,
  text: string,
  signer: Signer,
): Promise<DmMessage> {
  const ts = Date.now();
  const sig = await signer.signSocial(authMessage(dmSendSignAction(recipient, text), ts));
  const r = await fetch("/api/social/dm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sender, recipient, text, ts, ...sig }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not send message");
  return ((await r.json()) as { message: DmMessage }).message;
}

/** Read a DM thread with `peer`, proving ownership of `me` via a signed read. */
async function fetchDmThread(me: string, peer: string, signer: Signer): Promise<DmMessage[]> {
  const ts = Date.now();
  const sig = await signer.signSocial(authMessage(dmReadSignAction(), ts));
  const r = await fetch("/api/social/dm/thread", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ me, peer, ts, ...sig }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not load messages");
  return ((await r.json()) as { messages: DmMessage[] }).messages ?? [];
}

/** Read the caller's inbox, proving ownership of `me` via a signed read. */
async function fetchDmInbox(me: string, signer: Signer): Promise<DmThreadSummary[]> {
  const ts = Date.now();
  const sig = await signer.signSocial(authMessage(dmReadSignAction(), ts));
  const r = await fetch("/api/social/dm/inbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ me, ts, ...sig }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not load inbox");
  return ((await r.json()) as { threads: DmThreadSummary[] }).threads ?? [];
}

/**
 * Send a DM. On success, invalidates the open thread + inbox so they refetch.
 * The signer is passed in the mutation variables (same flow as like/repost/reply).
 */
export function useSendDm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      sender,
      recipient,
      text,
      signer,
    }: {
      sender: string;
      recipient: string;
      text: string;
      signer: Signer;
    }) => sendDm(sender, recipient, text, signer),
    onSuccess: (_d, { recipient }) => {
      void qc.invalidateQueries({ queryKey: ["social", "dm", "thread", recipient] });
      void qc.invalidateQueries({ queryKey: ["social", "dm", "inbox"] });
    },
  });
}

/**
 * A DM thread with `peer`, oldest->newest. Each fetch signs a read-proof, so this
 * does NOT auto-poll (that would prompt the wallet repeatedly); it refetches on
 * mount / manual invalidation (e.g. after sending). `signer` carries the viewer
 * identity + the signSocial function.
 */
export function useDmThread(peer: string, signer: Signer) {
  const me = signer.address ?? "";
  return useQuery({
    queryKey: ["social", "dm", "thread", peer, me],
    queryFn: () => fetchDmThread(me, peer, signer),
    enabled: Boolean(peer && me),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** The caller's DM inbox, most-recent thread first. Same signed-read model. */
export function useDmInbox(signer: Signer) {
  const me = signer.address ?? "";
  return useQuery({
    queryKey: ["social", "dm", "inbox", me],
    queryFn: () => fetchDmInbox(me, signer),
    enabled: Boolean(me),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

// ── in-app notifications ──────────────────────────────────────────────────────
//
// A notification is produced only as a SIDE EFFECT of another social write (a
// follow, a like / repost / reply on your post, a DM, or an @mention). Like DMs,
// a wallet's notifications are private: every read/mark is a signed request that
// proves ownership of `me`, and the Next route passes only that VERIFIED address
// to the indexer. To avoid prompting on every 30s poll, ONE read-proof is signed
// (on a deliberate gesture — opening the bell) and cached, then reused for both
// the poll and the mark-read write until it nears the server's replay window.

export type Notification = {
  id: string;
  /** follow | like | repost | reply | comment | mention | dm */
  kind: string;
  /** Who caused it. */
  actor?: string;
  /** The post it concerns (reply / like / repost / mention-in-post). */
  postId?: string;
  /** For a `dm`, the sender — so a click can open that conversation. */
  dmPeer?: string;
  /** Short text snippet (reply / mention / dm). */
  preview?: string;
  read: boolean;
  createdAt: number;
};

type NotifFeed = { items: Notification[]; unread: number };

/** A cached read-proof (signature + its timestamp) for one address. */
type NotifAuth = { sig: SocialSignature; ts: number };

// Kept below the server's 5-min replay window (AUTH_MAX_AGE_MS) so a reused
// signature is never rejected as stale.
const NOTIF_AUTH_TTL_MS = 4 * 60_000;
const notifAuthCache = new Map<string, NotifAuth>();

function cachedNotifAuth(address: string): NotifAuth | null {
  const a = notifAuthCache.get(address);
  if (a && Date.now() - a.ts < NOTIF_AUTH_TTL_MS) return a;
  return null;
}

/**
 * Return a fresh cached read-proof for `signer`, signing one (which prompts the
 * wallet) only when none is cached or it has expired. Call this on a deliberate
 * user gesture (opening the bell); the poll then reuses the cache silently.
 */
export async function ensureNotifAuth(signer: Signer): Promise<NotifAuth> {
  const address = signer.address;
  if (!address) throw new Error("Connect a wallet first.");
  const cached = cachedNotifAuth(address);
  if (cached) return cached;
  const ts = Date.now();
  const sig = await signer.signSocial(authMessage(notificationsReadSignAction(), ts));
  const auth: NotifAuth = { sig, ts };
  notifAuthCache.set(address, auth);
  return auth;
}

async function fetchNotifFeed(me: string, auth: NotifAuth, limit: number): Promise<NotifFeed> {
  const r = await fetch("/api/social/notifications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ me, limit, ts: auth.ts, ...auth.sig }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not load notifications");
  return (await r.json()) as NotifFeed;
}

/**
 * The polling query behind both notification hooks. It NEVER prompts the wallet:
 * it fetches only when a cached read-proof already exists (created by opening the
 * bell), and otherwise throws so react-query keeps the prior data. So a connected
 * wallet is never prompted on page load or on a background poll — only the badge
 * count stays at its last value until the bell is opened to (re)sign.
 */
function useNotifFeedQuery<T>(signer: Signer, select: (f: NotifFeed) => T, limit = 30) {
  const me = signer.address ?? "";
  return useQuery({
    queryKey: ["social", "notif", me],
    queryFn: async (): Promise<NotifFeed> => {
      const auth = cachedNotifAuth(me);
      if (!auth) throw new Error("notif-auth-needed");
      return fetchNotifFeed(me, auth, limit);
    },
    enabled: Boolean(me),
    select,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** The caller's notifications, newest-first. Polls every 30s once authed. */
export function useNotifications(signer: Signer, limit = 30) {
  return useNotifFeedQuery(signer, (f) => f.items, limit);
}

/** The caller's unread count (0 until the bell is opened once). Polls every 30s. */
export function useUnreadCount(signer: Signer): number {
  const q = useNotifFeedQuery(signer, (f) => f.unread);
  return q.data ?? 0;
}

/**
 * Mark notifications read (all of the caller's unread when `ids` is omitted).
 * Reuses the cached read-proof. On success, refetches the feed so the badge and
 * list reflect the change.
 */
export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ signer, ids }: { signer: Signer; ids?: string[] }) => {
      const me = signer.address;
      if (!me) throw new Error("Connect a wallet first.");
      const auth = await ensureNotifAuth(signer);
      const r = await fetch("/api/social/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ me, ids, ts: auth.ts, ...auth.sig }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not update notifications");
      return ((await r.json()) as { marked: number }).marked;
    },
    onSuccess: (_m, { signer }) => {
      void qc.invalidateQueries({ queryKey: ["social", "notif", signer.address ?? ""] });
    },
  });
}
