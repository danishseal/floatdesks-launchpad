/**
 * Representative NFT image fetcher.
 *
 * For every NFT entry in data/allowlist.yaml, grabs one currently listed
 * token from Magic Eden (floor-ish, so it is a typical piece rather than a
 * grail) and downloads its artwork to data/nft-images/<symbol>.<ext>,
 * with a report.json recording which token was used.
 *
 * Usage: npx tsx scripts/nft-images.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse } from "yaml";

const DATA_DIR = new URL("../data", import.meta.url).pathname;
const OUT_DIR = `${DATA_DIR}/nft-images`;
const ME = "https://api-mainnet.magiceden.dev/v2";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const gateway = (u: string) =>
  u.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${u.slice(7)}` : u;

async function getJson(url: string) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(1000 * (i + 1));
  }
  return null;
}

async function download(url: string, fileBase: string): Promise<string | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(gateway(url));
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 2000) return null;
        const ct = r.headers.get("content-type") ?? "";
        const ext = ct.includes("png") ? "png" : ct.includes("gif") ? "gif" : ct.includes("webp") ? "webp" : "jpg";
        const file = `${fileBase}.${ext}`;
        writeFileSync(file, buf);
        return file;
      }
    } catch {}
    await sleep(1000 * (i + 1));
  }
  return null;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const allow = parse(readFileSync(`${DATA_DIR}/allowlist.yaml`, "utf8"));
  const nfts = allow.markets.filter((m: any) => m.kind === "nft");
  console.log(`fetching a representative NFT for ${nfts.length} collections...`);

  const report: any[] = [];
  for (const m of nfts) {
    const sym = m.symbol;
    let entry: any = { symbol: sym, identifier: m.identifier, status: "manual" };
    // A few listings in, to skip potential oddball floor pieces.
    const listings: any = await getJson(`${ME}/collections/${sym}/listings?offset=2&limit=5`);
    const cand = (Array.isArray(listings) ? listings : []).flatMap((l: any) => [
      { img: l?.extra?.img, token: l?.tokenMint, name: l?.token?.name, price: l?.price },
      { img: l?.token?.image, token: l?.tokenMint, name: l?.token?.name, price: l?.price },
    ]).filter((c) => c.img);
    for (const c of cand) {
      const file = await download(c.img, `${OUT_DIR}/${sym}`);
      if (file) {
        entry = { ...entry, status: "ok", file, tokenMint: c.token, tokenName: c.name, priceSol: c.price, url: c.img };
        break;
      }
    }
    // Fallback: resolve the token mint through the tokens endpoint.
    if (entry.status !== "ok") {
      const mints = (Array.isArray(listings) ? listings : [])
        .map((l: any) => l?.tokenMint)
        .filter(Boolean);
      for (const mint of mints.slice(0, 3)) {
        const tok: any = await getJson(`${ME}/tokens/${mint}`);
        if (tok?.image) {
          const file = await download(tok.image, `${OUT_DIR}/${sym}`);
          if (file) {
            entry = { ...entry, status: "ok", file, tokenMint: mint, tokenName: tok.name, url: tok.image };
            break;
          }
        }
        await sleep(250);
      }
    }
    console.log(`  [${entry.status === "ok" ? "OK " : "MAN"}] ${sym}${entry.tokenName ? ` (${entry.tokenName}, ${entry.priceSol} SOL)` : ""}`);
    report.push(entry);
    await sleep(300);
  }

  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
  const ok = report.filter((r) => r.status === "ok").length;
  console.log(`\ndone: ${ok}/${report.length} -> ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
