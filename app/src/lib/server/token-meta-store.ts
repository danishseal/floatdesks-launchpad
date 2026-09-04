import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Tiny server-side store for per-token off-chain metadata the chain does not
 * hold. Today that is a single flag: `teamLaunch`, set by the creator in the
 * launch wizard, which disables holder metadata-change governance for the token.
 *
 * It follows the same shape as social-store.ts (atomic temp-file + rename write,
 * mtime-based cache invalidation so sibling route modules see each other's
 * writes) but lives in its own file so it can be swapped for a real DB later
 * without touching the social store. No external deps.
 */

export type TokenMeta = {
  /** True when the creator launched this as a team token: holders cannot open
   *  proposals to change its metadata. */
  teamLaunch?: boolean;
  /** The address that set the flag. The read side only honors `teamLaunch` when
   *  this equals the token's on-chain creator, so a non-creator can never make a
   *  flag effective (they cannot sign as the creator address). */
  setBy?: string;
  updatedAt?: number;
};

type DB = {
  /** token address -> its off-chain meta record. */
  tokens: Record<string, TokenMeta>;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_PATH = path.join(DATA_DIR, "token-meta.json");

let cache: DB | null = null;
// See social-store.ts for why this mtime dance is needed: Next.js bundles each
// route handler as its own module instance, so the on-disk file is the only
// thing every route shares. Re-read whenever the file's mtime moved.
let cachedMtimeMs = -1;
let queue: Promise<unknown> = Promise.resolve();

function emptyDB(): DB {
  return { tokens: {} };
}

function normalize(db: DB): DB {
  if (!db.tokens) db.tokens = {};
  return db;
}

async function load(): Promise<DB> {
  let mtimeMs = -1;
  try {
    mtimeMs = (await fs.stat(DB_PATH)).mtimeMs;
  } catch {
    if (!cache) {
      cache = emptyDB();
      cachedMtimeMs = -1;
    }
    return normalize(cache);
  }
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
  cache = db;
  try {
    cachedMtimeMs = (await fs.stat(DB_PATH)).mtimeMs;
  } catch {
    cachedMtimeMs = -1;
  }
}

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

// ── reads ─────────────────────────────────────────────────────────────────

export async function getTokenMeta(token: string): Promise<TokenMeta> {
  const db = await load();
  return db.tokens[token] ?? {};
}

// ── writes ────────────────────────────────────────────────────────────────

/** Record the team-launch flag for a token, stamped with who set it. */
export function setTeamLaunch(
  token: string,
  teamLaunch: boolean,
  setBy: string,
): Promise<TokenMeta> {
  return withWrite((db) => {
    const next: TokenMeta = { teamLaunch, setBy, updatedAt: Date.now() };
    db.tokens[token] = next;
    return next;
  });
}
