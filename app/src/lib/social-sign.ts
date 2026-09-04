/**
 * The exact action string a post signature binds. Shared by the client
 * (src/lib/social.ts) and the server (src/app/api/social/post/route.ts) so a
 * signature also covers whether an image / token / quote is attached, which
 * keeps replay protection meaningful for those fields too.
 *
 * The base is `post:${text}`; attachments append stable markers:
 *   :img            when an inline image is attached
 *   :tok:<address>  when a token preview is attached
 *   :q:<postId>     when the post quotes another post
 *
 * This lives in its own pure module (no client/server-only imports) precisely so
 * both sides import the same function and cannot drift. verify.ts is untouched.
 */
export function postSignAction(
  text: string,
  opts?: { image?: boolean | string; token?: string; quoteOf?: string },
): string {
  let action = `post:${text}`;
  if (opts?.image) action += ":img";
  if (opts?.token) action += `:tok:${opts.token}`;
  if (opts?.quoteOf) action += `:q:${opts.quoteOf}`;
  return action;
}

/*
 * Shared action-string builders for every OTHER social write. Same contract as
 * postSignAction: each returns ONLY the action portion that gets wrapped as
 * `ansem social: <action>\nts: <ts>` (via authMessage on the client and
 * socialAuthMessage on the server). Because both sides import these exact
 * functions, the signed message and the server-reconstructed message cannot
 * drift - which is precisely what silently broke edit-profile / like / repost /
 * follow / comment / reply when client and server each built the string inline.
 */

/** Editing one's own profile. No fields are bound beyond the action + ts. */
export function editProfileSignAction(): string {
  return "edit-profile";
}

/** Follow / unfollow. Binds the target so a signature can't be reused elsewhere. */
export function followSignAction(target: string, follow: boolean): string {
  return `${follow ? "follow" : "unfollow"}:${target}`;
}

/** Like / unlike. Binds the post id; like and unlike differ so a toggle re-signs. */
export function likeSignAction(postId: string, like: boolean): string {
  return `${like ? "like" : "unlike"}:${postId}`;
}

/** Repost / un-repost. Binds the post id; the two directions differ, as with like. */
export function repostSignAction(postId: string, repost: boolean): string {
  return `${repost ? "repost" : "unrepost"}:${postId}`;
}

/** Comment on a token. Binds the token address + the exact comment text. */
export function commentSignAction(token: string, text: string): string {
  return `comment:${token}:${text}`;
}

/** Reply to a post. Binds the parent post id + the exact reply text. */
export function replySignAction(postId: string, text: string): string {
  return `reply-post:${postId}:${text}`;
}

/**
 * Send a direct message. Binds the recipient + the exact message text so the
 * sender's signature proves both WHO they are and WHAT they sent to WHOM.
 */
export function dmSendSignAction(recipient: string, text: string): string {
  return `dm:${recipient}:${text}`;
}

/**
 * Claim a reserved username. Binds the exact one-time token so the signature
 * cannot be replayed to claim a DIFFERENT token, and a captured claim request
 * for one token proves nothing about another. The signer becomes the owner.
 */
export function claimUsernameSignAction(token: string): string {
  return `claim:${token}`;
}

/**
 * Bind a real wallet to a token-owned account (the "claim without a wallet" path).
 * Binds the exact claim token so the signature proves BOTH the new wallet (it is
 * the signer, verified upstream) AND which token-owned account is being bound.
 * This is the security upgrade in the token-as-credential flow: the token alone
 * created and edited the account, but promoting it to a wallet requires that
 * wallet's signature. The signer becomes the account's new, permanent owner.
 */
export function bindWalletSignAction(token: string): string {
  return `bind:${token}`;
}

/**
 * Read DMs (a thread or the inbox). Binds nothing but the action + ts (added by
 * socialAuthMessage), which is enough: the signature proves the caller owns the
 * address, and the Next route passes only that VERIFIED address to the indexer,
 * so a signed read can only ever read the signer's own conversations.
 */
export function dmReadSignAction(): string {
  return "dm-read";
}

/**
 * Read (or mark-read) the caller's notifications. Like dmReadSignAction it binds
 * nothing but the action + ts: the signature proves the caller owns the address,
 * and the Next route passes only that VERIFIED address to the indexer, so a
 * signed read/mark can only ever touch the signer's own notifications. One
 * cached signature is reused for both the read poll and the mark-read write
 * within the replay window, so the wallet is prompted at most once per window.
 */
export function notificationsReadSignAction(): string {
  return "notif-read";
}

/*
 * ── On-chain canonical message ───────────────────────────────────────────────
 *
 * The `ansem-social` contract binds a DIFFERENT, self-describing message (it has
 * no notion of the action strings above). For actions that are relayed on-chain
 * (post / reply / like / repost) the client signs THIS exact string so one
 * signature satisfies both the off-chain store and the on-chain contract:
 *
 *   ansem social: {kind}:{subject}\nts: {ts}\n{text}
 *
 * - kind    : "post" | "reply" | "like" | "repost"
 * - subject : the target post's on-chain id (decimal) for reply/like/repost, "" for a post
 * - text    : the content for post/reply, "" for like/repost
 *
 * This must match contracts/social/src/lib.rs `canonical_message` byte-for-byte.
 * Attachments (image/token/quote) are NOT bound here; they are stored off-chain
 * as metadata alongside the on-chain-authenticated text.
 */
export type OnchainKind = "post" | "reply" | "like" | "repost";

export function canonicalSocialMessage(
  kind: OnchainKind,
  subject: string,
  ts: number,
  text: string,
): string {
  return `ansem social: ${kind}:${subject}\nts: ${ts}\n${text}`;
}
