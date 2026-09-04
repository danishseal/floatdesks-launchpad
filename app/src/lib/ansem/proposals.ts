// Token-scoped community proposals for the launchpad token page.
//
// This is the SAME memo/treasury governance protocol the ANSEM proposals web
// app (ansemm-proposal) and @chanseproposalbot speak - proposals and votes are
// 1-uchanse bank transfers to a treasury address carrying an encoded memo,
// read back from tx history. NOTHING here uses the CosmWasm proposals contract;
// the live governance flow is memo-based and holds no per-token state.
//
// Wire contract (interoperable with the web app + bot):
//   proposal memo: `ansem-prop:v1:<base64(JSON{title,description[,options][,category][,subject]})>`
//     - binary proposal      => NO `options` key; votes are literal "yes"/"no"
//     - multi-option (2..10)  => `options:[...]`; votes are `opt-<index>` (0-indexed)
//   vote memo:     `ansem-vote:v1:<proposalId>:<choice>`  (choice = yes|no|opt-N)
//   proposalId  =  the CREATE tx's txhash (case-sensitive).
//   dedup       =  FIRST-vote-wins per wallet per proposal (oldest first).
//
// `category` + `subject` are additive fields the base web reader ignores. The
// launchpad uses them to bind a proposal to the "token" category and to THIS
// token's address, so the token page can list only its own proposals. Creating
// a proposal here always fixes category="token" and subject=<tokenAddress>.

import type { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { DENOM } from "@/lib/floorlaunch/config";
import { getRestUrl } from "@/lib/floorlaunch/live-config";

export const PROP_PREFIX = "ansem-prop:v1:";
export const VOTE_PREFIX = "ansem-vote:v1:";
export const MAX_OPTIONS = 10;

/** The governance category this page fixes every proposal to. The wider
 *  governance surface recognises other categories (blockchain infra, treasury,
 *  general, ...); the launchpad token page only ever reads/writes "token". */
export const TOKEN_CATEGORY = "token";

// Proposal/vote submission recipient. Baked env anchor, stable across regenesis
// and not held in the config registry (matches the web app + bot). Default is
// the live ansem-1 community-proposal treasury.
export const PROPOSAL_TREASURY =
  process.env.NEXT_PUBLIC_ANSEM_TREASURY ??
  "ansem1yhlt4665wr0geu6nej6nddgdn0dp03hxsm807a";

// Chain max_memo_characters (raised to 2048 via governance).
const MEMO_LIMIT = 2048;

// ── base64 helpers (browser + node safe) ────────────────────────────────────
function toBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  if (typeof btoa === "function") {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  return Buffer.from(bytes).toString("base64");
}

function fromBase64Utf8(b64: string): string {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(b64, "base64").toString("utf8");
}

// ── codec ───────────────────────────────────────────────────────────────────
export type ParsedChoice =
  | { kind: "binary"; vote: "yes" | "no" }
  | { kind: "option"; index: number };

function parseChoiceToken(raw: string): ParsedChoice | null {
  if (raw === "yes" || raw === "no") return { kind: "binary", vote: raw };
  if (raw.startsWith("opt-")) {
    const t = raw.slice(4);
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    if (n < 0 || n >= MAX_OPTIONS) return null;
    return { kind: "option", index: n };
  }
  return null;
}

/** Build a proposal memo. Key order title/description/options stays byte-
 *  compatible with the bot; category/subject are appended, additive fields. */
export function encodeProposalMemo(
  title: string,
  description: string,
  options: string[] | undefined,
  category: string,
  subject: string,
): string {
  const body: {
    title: string;
    description: string;
    options?: string[];
    category?: string;
    subject?: string;
  } = { title, description };
  if (options && options.length >= 2) body.options = options;
  if (category) body.category = category;
  if (subject) body.subject = subject;
  return PROP_PREFIX + toBase64Utf8(JSON.stringify(body));
}

export function encodeVoteMemo(
  proposalId: string,
  choice: "yes" | "no" | number,
): string {
  const token = typeof choice === "number" ? `opt-${choice}` : choice;
  return `${VOTE_PREFIX}${proposalId}:${token}`;
}

// ── read model ──────────────────────────────────────────────────────────────
export interface TokenProposal {
  id: string;
  proposer: string;
  title: string;
  description: string;
  category: string;
  subject: string;
  /** null => binary (Yes/No); otherwise 2..10 option labels. */
  options: string[] | null;
  binary: boolean;
  /** Labels tallied against: binary => ["Yes","No"], else `options`. */
  optionLabels: string[];
  /** Vote counts parallel to optionLabels. */
  optionCounts: number[];
  totalVotes: number;
  /** The connected viewer's chosen option index, or null. */
  yourChoice: number | null;
  height: number;
  timestamp: number;
}

interface CosmosTxResponse {
  txhash: string;
  height: string;
  timestamp: string;
  code: number;
  tx?: {
    body?: {
      memo?: string;
      messages?: Array<Record<string, unknown> & { "@type": string }>;
    };
  };
}

interface RawProposal {
  id: string;
  proposer: string;
  title: string;
  description: string;
  category: string;
  subject: string;
  options: string[] | null;
  height: number;
  timestamp: number;
}

interface RawVote {
  proposalId: string;
  voter: string;
  choice: ParsedChoice;
  height: number;
  timestamp: number;
}

async function fetchTreasuryTxs(limit = 200): Promise<CosmosTxResponse[]> {
  const rest = await getRestUrl();
  const url = new URL(`${rest.replace(/\/$/, "")}/cosmos/tx/v1beta1/txs`);
  url.searchParams.set("query", `transfer.recipient='${PROPOSAL_TREASURY}'`);
  url.searchParams.set("order_by", "ORDER_BY_DESC");
  url.searchParams.set("pagination.limit", String(limit));
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Treasury tx fetch failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { tx_responses?: CosmosTxResponse[] };
  return (json.tx_responses ?? []).filter((tx) => tx.code === 0);
}

function senderFromTx(tx: CosmosTxResponse): string {
  const msg = tx.tx?.body?.messages?.[0] as Record<string, unknown> | undefined;
  return String(msg?.from_address ?? "");
}

function parseProposal(tx: CosmosTxResponse): RawProposal | null {
  const memo = tx.tx?.body?.memo ?? "";
  if (!memo.startsWith(PROP_PREFIX)) return null;
  try {
    const body = JSON.parse(fromBase64Utf8(memo.slice(PROP_PREFIX.length))) as {
      title?: unknown;
      description?: unknown;
      options?: unknown;
      category?: unknown;
      subject?: unknown;
    };
    if (typeof body.title !== "string" || typeof body.description !== "string") {
      return null;
    }
    let options: string[] | null = null;
    if (Array.isArray(body.options)) {
      const opts = body.options
        .filter((o): o is string => typeof o === "string")
        .map((o) => o.trim())
        .filter((o) => o.length >= 1 && o.length <= 60);
      if (opts.length >= 2 && opts.length <= MAX_OPTIONS) options = opts;
    }
    return {
      id: tx.txhash,
      proposer: senderFromTx(tx),
      title: body.title,
      description: body.description,
      category: typeof body.category === "string" ? body.category : "",
      subject: typeof body.subject === "string" ? body.subject : "",
      options,
      height: Number(tx.height),
      timestamp: new Date(tx.timestamp).getTime(),
    };
  } catch {
    return null;
  }
}

function parseVote(tx: CosmosTxResponse): RawVote | null {
  const memo = tx.tx?.body?.memo ?? "";
  if (!memo.startsWith(VOTE_PREFIX)) return null;
  const rest = memo.slice(VOTE_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) return null;
  const proposalId = rest.slice(0, lastColon);
  const choice = parseChoiceToken(rest.slice(lastColon + 1));
  if (!proposalId || !choice) return null;
  const voter = senderFromTx(tx);
  if (!voter) return null;
  return {
    proposalId,
    voter,
    choice,
    height: Number(tx.height),
    timestamp: new Date(tx.timestamp).getTime(),
  };
}

function choiceIndexFor(p: RawProposal, choice: ParsedChoice): number | null {
  if (p.options) {
    if (choice.kind !== "option") return null;
    return choice.index < p.options.length ? choice.index : null;
  }
  if (choice.kind !== "binary") return null;
  return choice.vote === "yes" ? 0 : 1;
}

function buildTally(
  p: RawProposal,
  byVoter: Map<string, RawVote> | undefined,
  viewer?: string,
): TokenProposal {
  const labels = p.options ?? ["Yes", "No"];
  const counts = new Array(labels.length).fill(0);
  let yourChoice: number | null = null;
  if (byVoter) {
    for (const raw of byVoter.values()) {
      const idx = choiceIndexFor(p, raw.choice);
      if (idx === null) continue;
      counts[idx] += 1;
      if (viewer && raw.voter === viewer) yourChoice = idx;
    }
  }
  return {
    id: p.id,
    proposer: p.proposer,
    title: p.title,
    description: p.description,
    category: p.category,
    subject: p.subject,
    options: p.options,
    binary: p.options === null,
    optionLabels: labels,
    optionCounts: counts,
    totalVotes: counts.reduce((a, b) => a + b, 0),
    yourChoice,
    height: p.height,
    timestamp: p.timestamp,
  };
}

/**
 * List the "token"-category proposals that pertain to `tokenAddress`, with live
 * vote tallies. Reads the treasury tx history (same source as the governance
 * web app) and filters to proposals whose memo carries category==="token" and
 * subject===tokenAddress. Returns newest-first. Never returns fabricated data:
 * if no such proposals exist, the list is empty.
 */
export async function listTokenProposals(
  tokenAddress: string,
  viewer?: string,
): Promise<TokenProposal[]> {
  const txs = await fetchTreasuryTxs(200);

  const proposalsById = new Map<string, RawProposal>();
  for (const tx of [...txs].reverse()) {
    const p = parseProposal(tx);
    if (
      p &&
      p.category === TOKEN_CATEGORY &&
      p.subject === tokenAddress
    ) {
      proposalsById.set(p.id, p);
    }
  }
  if (proposalsById.size === 0) return [];

  // First-vote-wins tally: reverse to oldest-first so the earliest vote sticks.
  const votes = new Map<string, Map<string, RawVote>>();
  for (const tx of [...txs].reverse()) {
    const raw = parseVote(tx);
    if (!raw) continue;
    const p = proposalsById.get(raw.proposalId);
    if (!p) continue;
    if (choiceIndexFor(p, raw.choice) === null) continue;
    let byVoter = votes.get(raw.proposalId);
    if (!byVoter) {
      byVoter = new Map();
      votes.set(raw.proposalId, byVoter);
    }
    if (!byVoter.has(raw.voter)) byVoter.set(raw.voter, raw);
  }

  return [...proposalsById.values()]
    .sort((a, b) => b.height - a.height)
    .map((p) => buildTally(p, votes.get(p.id), viewer));
}

// ── write path (real on-chain execute, signed by the connected wallet) ───────
// Proposals/votes are 1-uchanse bank transfers to the treasury with the encoded
// memo. SigningCosmWasmClient extends SigningStargateClient, so sendTokens is
// available on the same client the launchpad already uses for trades.

export interface CreateTokenProposalArgs {
  title: string;
  description: string;
  /** Omit or pass <2 for a Yes/No proposal; 2..10 labels for a ballot. */
  options?: string[];
}

/** Sign + broadcast a new token-category proposal bound to `tokenAddress`.
 *  Returns the create tx hash, which is also the proposal id. */
export async function submitTokenProposal(
  client: SigningCosmWasmClient,
  sender: string,
  tokenAddress: string,
  args: CreateTokenProposalArgs,
): Promise<string> {
  const title = args.title.trim();
  const description = args.description.trim();
  if (!title) throw new Error("Title is required.");
  if (!description) throw new Error("Description is required.");

  let options: string[] | undefined;
  if (args.options && args.options.length > 0) {
    options = args.options.map((o) => o.trim()).filter((o) => o.length > 0);
    if (options.length < 2) {
      throw new Error("A ballot needs at least 2 options (or none for Yes/No).");
    }
    if (options.length > MAX_OPTIONS) throw new Error("At most 10 options.");
    if (options.some((o) => o.length > 60)) {
      throw new Error("Each option must be 60 characters or fewer.");
    }
  }

  const memo = encodeProposalMemo(
    title,
    description,
    options,
    TOKEN_CATEGORY,
    tokenAddress,
  );
  if (new TextEncoder().encode(memo).length > MEMO_LIMIT) {
    throw new Error(
      "Proposal too long. Shorten the title, description, or options.",
    );
  }

  const res = await client.sendTokens(
    sender,
    PROPOSAL_TREASURY,
    [{ denom: DENOM, amount: "1" }],
    "auto",
    memo,
  );
  if (res.code !== 0) {
    throw new Error(`Proposal failed (code ${res.code}): ${res.rawLog}`);
  }
  return res.transactionHash;
}

/** Sign + broadcast a vote. `choice` is "yes"/"no" for a binary proposal, or a
 *  0-indexed option number for a ballot. Returns the vote tx hash. */
export async function castTokenProposalVote(
  client: SigningCosmWasmClient,
  sender: string,
  proposalId: string,
  choice: "yes" | "no" | number,
): Promise<string> {
  const memo = encodeVoteMemo(proposalId, choice);
  const res = await client.sendTokens(
    sender,
    PROPOSAL_TREASURY,
    [{ denom: DENOM, amount: "1" }],
    "auto",
    memo,
  );
  if (res.code !== 0) {
    throw new Error(`Vote failed (code ${res.code}): ${res.rawLog}`);
  }
  return res.transactionHash;
}
