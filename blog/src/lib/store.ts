/**
 * Comments + subscribers store.
 *
 * Auto-detects its backend: if Upstash Redis env vars are present
 * (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN), it uses Upstash
 * (works on serverless like Vercel and is shared across instances).
 * Otherwise it falls back to a local JSON file under ./data (gitignored),
 * which is fine for local dev and single-instance Node hosts. The API
 * routes and components never change.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const USE_UPSTASH = !!(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);

const COMMENTS_KEY = "commas:comments";
const SUBSCRIBERS_KEY = "commas:subscribers";
const MAX_COMMENTS = 1000;

export type Comment = {
  id: string;
  author: string;
  text: string;
  ts: number;
};

// ---------- Upstash backend ----------

let redisClient: any = null;
async function redis() {
  if (!redisClient) {
    const { Redis } = await import("@upstash/redis");
    redisClient = Redis.fromEnv();
  }
  return redisClient;
}

// ---------- File backend ----------

const DATA_DIR = path.join(process.cwd(), "data");
async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, file), "utf8")) as T;
  } catch {
    return fallback;
  }
}
async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ---------- Public API ----------

export async function getComments(): Promise<Comment[]> {
  if (USE_UPSTASH) {
    const r = await redis();
    const items: unknown[] = await r.lrange(COMMENTS_KEY, 0, MAX_COMMENTS - 1);
    return items.map((x) =>
      typeof x === "string" ? (JSON.parse(x) as Comment) : (x as Comment)
    );
  }
  return readJson<Comment[]>("comments.json", []);
}

export async function addComment(c: Comment): Promise<Comment> {
  if (USE_UPSTASH) {
    const r = await redis();
    await r.lpush(COMMENTS_KEY, JSON.stringify(c));
    await r.ltrim(COMMENTS_KEY, 0, MAX_COMMENTS - 1);
    return c;
  }
  const list = await readJson<Comment[]>("comments.json", []);
  list.unshift(c);
  await writeJson("comments.json", list.slice(0, MAX_COMMENTS));
  return c;
}

export async function addSubscriber(
  email: string
): Promise<{ ok: boolean; already: boolean }> {
  const e = email.trim().toLowerCase();
  if (USE_UPSTASH) {
    const r = await redis();
    const added: number = await r.sadd(SUBSCRIBERS_KEY, e);
    return { ok: true, already: added === 0 };
  }
  const list = await readJson<string[]>("subscribers.json", []);
  if (list.includes(e)) return { ok: true, already: true };
  list.push(e);
  await writeJson("subscribers.json", list);
  return { ok: true, already: false };
}

export async function getSubscriberCount(): Promise<number> {
  if (USE_UPSTASH) {
    const r = await redis();
    return (await r.scard(SUBSCRIBERS_KEY)) as number;
  }
  return (await readJson<string[]>("subscribers.json", [])).length;
}
