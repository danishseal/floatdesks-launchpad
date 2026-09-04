/**
 * Clean card-image fetcher.
 *
 * Walks data/allowlist.yaml, resolves every card entry to an official
 * plain scan (no holo effect, no slab), and downloads it to
 * data/card-images/<safe-identifier>.<ext>. Emits a per-card report to
 * data/card-images/report.json and a summary on stdout.
 *
 * Sources, in preference order per franchise:
 *   Pokemon (EN sets):  pokemontcg.io search (name + number), hires PNG
 *   Pokemon (JP/other): TCGdex ja assets (best effort)
 *   One Piece:          optcgapi.com clean JPG, then official Bandai PNG
 *                       (complete incl. promos, faint SAMPLE watermark)
 *
 * Usage: npx tsx scripts/card-images.ts
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { parse } from "yaml";

const DATA_DIR = new URL("../data", import.meta.url).pathname;
const OUT_DIR = `${DATA_DIR}/card-images`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CardEntry {
  kind: string;
  identifier: string; // card:<year>|<set>|#<serial>|<grader>|<grade>
  name: string;
  grade: string;
  _snapshot: { category: string };
}

interface Resolution {
  identifier: string;
  name: string;
  category: string;
  status: "ok" | "watermarked" | "manual";
  source?: string;
  url?: string;
  file?: string;
  note?: string;
}

const safe = (s: string) =>
  s.replace(/^card:/, "").replace(/[^a-zA-Z0-9#-]+/g, "_").slice(0, 120);

function parts(identifier: string) {
  const [year, set, serialRaw, grader, grade] = identifier
    .replace(/^card:/, "")
    .split("|");
  return { year, set, serial: serialRaw.replace(/^#/, ""), grader, grade };
}

/** Card title from a CC item name like "2023 #198 Venusaur EX PSA 10 Mew EN-151". */
function cardTitle(name: string): string {
  const m = name.match(/#\S+\s+(.*?)\s+(?:PSA|CGC|BGS)\b/i);
  if (m) return m[1].replace(/Full Art\//i, "").trim();
  return name.split(/\s+/).slice(2, 5).join(" ");
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
    await sleep(1200 * (i + 1));
  }
  return null;
}

async function download(url: string, file: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return false;
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 5000) return false; // error pages
        writeFileSync(file, buf);
        return true;
      }
    } catch {}
    await sleep(1200 * (i + 1));
  }
  return false;
}

// ---------- One Piece ----------

/** Derive the card code (OP13-120, ST01-002, P-043) from set + serial. */
function onePieceCode(set: string, serial: string): string | null {
  const s = serial.toUpperCase().replace(/\s+/g, "");
  // Serial already carries a full code.
  let m = s.match(/^(OP\d{2}|ST\d{2}|EB\d{2})-?(\d{3})$/);
  if (m) return `${m[1]}-${m[2]}`;
  m = s.match(/^(ST\d{2})(\d{3})$/);
  if (m) return `${m[1]}-${m[2]}`;
  m = s.match(/^P-?(\d{3})$/);
  if (m) return `P-${m[1]}`;
  // Otherwise pull the set code out of the set name.
  const setCode = set.toUpperCase().match(/\b(OP\d{2}|ST\d{2}|EB\d{2})\b/);
  const num = s.match(/^(\d{1,3})$/);
  if (setCode && num) return `${setCode[1]}-${num[1].padStart(3, "0")}`;
  // Promo sets: plain number becomes P-xxx.
  if (/PROMO/i.test(set) && num) return `P-${num[1].padStart(3, "0")}`;
  return null;
}

async function resolveOnePiece(e: CardEntry): Promise<Resolution> {
  const { set, serial } = parts(e.identifier);
  const base: Resolution = {
    identifier: e.identifier,
    name: e.name,
    category: "One Piece",
    status: "manual",
  };
  const code = onePieceCode(set, serial);
  if (!code) return { ...base, note: "could not derive card code" };

  const file = `${OUT_DIR}/${safe(e.identifier)}`;
  const clean = `https://optcgapi.com/media/static/Card_Images/${code}.jpg`;
  if (await download(clean, `${file}.jpg`)) {
    return { ...base, status: "ok", source: "optcgapi", url: clean, file: `${file}.jpg` };
  }
  const official = `https://en.onepiece-cardgame.com/images/cardlist/card/${code}.png`;
  if (await download(official, `${file}.png`)) {
    return {
      ...base,
      status: "watermarked",
      source: "bandai-official",
      url: official,
      file: `${file}.png`,
      note: "official scan carries a faint SAMPLE watermark",
    };
  }
  return { ...base, note: `code ${code} not found on optcgapi or Bandai` };
}

// ---------- Pokemon ----------

const JP_HINTS = /japanese|korean|chinese|sv\d+a|sv-p\b|m-p\b|mbg|m2-|c-collection/i;

const GENERIC_WORDS = new Set([
  "mega", "full", "art", "promo", "promos", "first", "partner", "illustration",
  "card", "pokemon", "black", "star", "holo", "reverse", "team", "tag",
]);

/**
 * A match is only trusted if the API card's name shares a specific word
 * with the marketplace item name. Guards the looser search rungs against
 * same-number cards from other sets (a real failure we hit: a "Mega ..."
 * promo matching Mega Chandelure ex).
 */
function namesOverlap(itemName: string, apiName: string): boolean {
  const words = (s: string) =>
    new Set(
      s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w))
    );
  const a = words(itemName);
  for (const w of words(apiName)) if (a.has(w)) return true;
  return false;
}

async function resolvePokemon(e: CardEntry): Promise<Resolution> {
  const { set, serial } = parts(e.identifier);
  const base: Resolution = {
    identifier: e.identifier,
    name: e.name,
    category: "Pokemon",
    status: "manual",
  };
  const file = `${OUT_DIR}/${safe(e.identifier)}`;
  const jp = JP_HINTS.test(set) || JP_HINTS.test(e.name);

  if (!jp) {
    // English sets: pokemontcg.io search with a retry ladder that walks
    // from precise to loose. Number variants handle leading zeros and
    // slashed print numbers; name variants strip suffixes and quoting
    // hazards ("&", "-Holo", Full Art/).
    const title = cardTitle(e.name).replace(/"/g, "");
    const firstWord = title.split(/[\s&-]+/)[0];
    const numbers = [
      ...new Set([
        serial,
        serial.replace(/^0+/, ""),
        serial.split("/")[0],
        serial.split("/")[0].replace(/^0+/, ""),
      ]),
    ].filter(Boolean);
    const names = [...new Set([title, title.replace(/-?Holo/i, "").trim(), firstWord])];

    for (const num of numbers) {
      for (const nm of names) {
        const q = encodeURIComponent(`name:"${nm}" number:"${num}"`);
        const res: any = await getJson(
          `https://api.pokemontcg.io/v2/cards?q=${q}&select=id,name,set,images&pageSize=5`
        );
        const hit = res?.data?.find((c: any) => namesOverlap(e.name, c.name));
        if (hit?.images?.large && (await download(hit.images.large, `${file}.png`))) {
          return {
            ...base,
            status: "ok",
            source: `pokemontcg.io (${hit.set?.name ?? hit.id})`,
            url: hit.images.large,
            file: `${file}.png`,
          };
        }
        await sleep(150);
      }
    }
    // Last rung: number-only, filtered by loose name containment.
    for (const num of numbers) {
      const res: any = await getJson(
        `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`number:"${num}"`)}&select=id,name,set,images&pageSize=50`
      );
      const hit = res?.data?.find(
        (c: any) =>
          c.name.toLowerCase().includes(firstWord.toLowerCase()) &&
          namesOverlap(e.name, c.name)
      );
      if (hit?.images?.large && (await download(hit.images.large, `${file}.png`))) {
        return {
          ...base,
          status: "ok",
          source: `pokemontcg.io number-scan (${hit.set?.name ?? hit.id})`,
          url: hit.images.large,
          file: `${file}.png`,
        };
      }
    }
    return { ...base, note: `no pokemontcg.io match for "${title}" #${serial}` };
  }

  // Japanese and other-language sets: best-effort TCGdex.
  const setCode = (set.match(/\b(Sv\d+a|SV\d+|M2|Mbg|M-P|SV-P)\b/i)?.[1] ?? "").toLowerCase();
  if (setCode) {
    const card: any = await getJson(
      `https://api.tcgdex.net/v2/ja/sets/${setCode}/${serial.replace(/^0+/, "")}`
    );
    if (card?.image) {
      const url = `${card.image}/high.png`;
      if (await download(url, `${file}.png`)) {
        return { ...base, status: "ok", source: "tcgdex-ja", url, file: `${file}.png` };
      }
    }
  }
  return {
    ...base,
    note: "non-English print; source manually (TCGdex/limitlesstcg)",
  };
}

// ---------- main ----------

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const allow = parse(readFileSync(`${DATA_DIR}/allowlist.yaml`, "utf8"));
  const cards: CardEntry[] = allow.markets.filter((m: any) => m.kind === "card");
  console.log(`resolving images for ${cards.length} cards...`);

  const results: Resolution[] = [];
  for (const e of cards) {
    const r =
      e._snapshot.category === "One Piece"
        ? await resolveOnePiece(e)
        : await resolvePokemon(e);
    results.push(r);
    const mark = r.status === "ok" ? "OK " : r.status === "watermarked" ? "WM " : "MAN";
    console.log(`  [${mark}] ${e.name.slice(0, 62)}${r.note ? ` (${r.note})` : ""}`);
    await sleep(250);
  }

  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(results, null, 2));
  const ok = results.filter((r) => r.status === "ok").length;
  const wm = results.filter((r) => r.status === "watermarked").length;
  const man = results.filter((r) => r.status === "manual").length;
  console.log(
    `\nclean: ${ok}  watermarked-official: ${wm}  needs-manual: ${man}  -> ${OUT_DIR}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
