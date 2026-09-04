/**
 * Listing allowlist generator.
 *
 * Encodes the depth thresholds that decide which collectibles qualify as
 * underlyings, scans the live sources, and emits the qualifying set as
 * ready-to-use relayer config entries (data/allowlist.yaml) plus a human
 * summary on stdout.
 *
 * NFT side: candidate-universe sweep of major Solana collections via the
 * Magic Eden stats API (exhaustive discovery needs a Tensor API key).
 * Card side: full Collector Crypt marketplace scan (use --scan-cards to
 * refresh; otherwise reads the cached data/cc-depth-scout.json).
 *
 * Usage: npx tsx scripts/allowlist.ts [--scan-cards]
 */
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { stringify } from "yaml";

const PROGRAM_ID = new PublicKey("QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM");
const DATA_DIR = new URL("../data", import.meta.url).pathname;

// ---------- thresholds (the listing policy, as code) ----------
const NFT = {
  minListed: 100,
  minWeeklyVolSol: 1000,
  minFloorSol: 0.3,
};
const CARD = {
  minListings: 4,
  minFloorUsd: 100,
  categories: ["Pokemon", "One Piece", "Yu-Gi-Oh!", "Magic The Gathering", "Baseball", "Football", "Basketball", "Soccer", "Hockey"],
};

// Candidate universe for NFT discovery, pending a Tensor API key for a
// true full-market crawl.
const NFT_CANDIDATES = [
  "mad_lads", "froganas", "tensorians", "bodoggos", "famous_fox_federation",
  "claynosaurz", "solana_monkey_business", "smb_gen3", "okay_bears", "degods",
  "y00ts", "galactic_geckos", "retardio_cousins", "cets_on_creck", "aurory",
  "portals", "sharx", "lifinity_flares", "meegos", "degenerate_ape_academy",
  "degen_fat_cats", "blocksmith_labs", "transdimensional_fox_federation",
  "oogy", "udder_chaos", "bubblegoose_ballers", "primates", "thugbirdz",
  "catalina_whale_mixer", "shadowy_super_coder_dao", "infinity_labs",
  "ghost_kid_dao", "jelly_rascals", "quekz", "sujiko_warrior", "marms",
  "the_heist", "photo_finish_pfp_collection", "elixir_ovols", "banx",
  "stoned_ape_crew", "monkey_baby_business", "boryoku_dragonz", "cyber_frogs",
  "rakkudos", "genopets_habitats",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic on-chain collection id + market PDA for an underlying. */
function derive(idString: string) {
  const collection = new PublicKey(createHash("sha256").update(idString).digest());
  const [market] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), collection.toBuffer()],
    PROGRAM_ID
  );
  return { collection: collection.toBase58(), market: market.toBase58() };
}

async function scanNfts() {
  const rows: any[] = [];
  for (const sym of NFT_CANDIDATES) {
    try {
      const r = await fetch(
        `https://api-mainnet.magiceden.dev/v2/collections/${sym}/stats`
      );
      if (!r.ok) continue;
      const s: any = await r.json();
      rows.push({
        symbol: sym,
        floorSol: (s.floorPrice ?? 0) / 1e9,
        listed: s.listedCount ?? 0,
        weeklyVolSol: (s.volume7d ?? 0) / 1e9,
      });
    } catch {}
    await sleep(200);
  }
  const qualified = rows
    .filter(
      (r) =>
        r.listed >= NFT.minListed &&
        r.weeklyVolSol >= NFT.minWeeklyVolSol &&
        r.floorSol >= NFT.minFloorSol
    )
    .sort((a, b) => b.weeklyVolSol - a.weeklyVolSol);
  return { rows, qualified };
}

async function scanCardsFull() {
  const first: any = await (await fetch("https://api.collectorcrypt.com/marketplace?page=1")).json();
  const pages = first.totalPages;
  interface Group { prices: number[]; name: string; category: string }
  const groups = new Map<string, Group>();
  for (let p = 1; p <= pages; p++) {
    let d: any = p === 1 ? first : null;
    for (let attempt = 0; !d && attempt < 4; attempt++) {
      try {
        d = await (await fetch(`https://api.collectorcrypt.com/marketplace?page=${p}`)).json();
      } catch {
        await sleep(1500 * (attempt + 1));
      }
    }
    if (!d) continue;
    for (const it of d.filterNFtCard ?? []) {
      const price = it.listing?.price;
      if (!price || !["USDC", "USD"].includes(it.listing?.currency) || it.type !== "Card") continue;
      const key = `${it.year}|${it.set}|#${it.serial}|${it.gradingCompany}|${it.grade}`;
      const g: Group = groups.get(key) ?? { prices: [] as number[], name: it.itemName ?? "", category: it.category ?? "" };
      g.prices.push(Number(price));
      groups.set(key, g);
    }
    if (p % 200 === 0) console.error(`  card scan: page ${p}/${pages}`);
    await sleep(120);
  }
  const rows = [...groups.entries()].map(([key, g]) => {
    const prices = [...g.prices].sort((a, b) => a - b);
    return {
      key,
      name: g.name,
      category: g.category,
      listings: prices.length,
      floor_usd: prices[0],
      median_usd: prices[Math.floor(prices.length / 2)],
    };
  });
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    `${DATA_DIR}/cc-depth-scout.json`,
    JSON.stringify({ scanned_pages: pages, total_pages: pages, groups: rows.length, rows })
  );
  return rows;
}

async function main() {
  const scanCards = process.argv.includes("--scan-cards");

  console.error("scanning NFT candidates (Magic Eden)...");
  const nfts = await scanNfts();

  let cardRows: any[];
  const cachePath = `${DATA_DIR}/cc-depth-scout.json`;
  if (scanCards || !existsSync(cachePath)) {
    console.error("scanning Collector Crypt marketplace (full, ~10 min)...");
    cardRows = await scanCardsFull();
  } else {
    cardRows = JSON.parse(readFileSync(cachePath, "utf8")).rows;
    console.error(`cards: using cached scan (${cachePath}); pass --scan-cards to refresh`);
  }
  const cards = cardRows
    .filter(
      (r) =>
        r.listings >= CARD.minListings &&
        r.floor_usd >= CARD.minFloorUsd &&
        CARD.categories.includes(r.category)
    )
    .sort((a: any, b: any) => b.listings - a.listings);

  // ---------- emit ----------
  const nftEntries = nfts.qualified.map((r) => {
    const ids = derive(`magiceden:${r.symbol}`);
    return {
      kind: "nft",
      market: ids.market,
      collectionId: ids.collection,
      identifier: `magiceden:${r.symbol}`,
      symbol: r.symbol,
      lookbackDays: 3,
      minSales: 5,
      maxDisagreementBps: 2500,
      _snapshot: {
        floorSol: Number(r.floorSol.toFixed(2)),
        listed: r.listed,
        weeklyVolSol: Math.round(r.weeklyVolSol),
      },
    };
  });
  const cardEntries = cards.map((r: any) => {
    const ids = derive(`card:${r.key}`);
    const grade = r.key.split("|").slice(-2).join(" ");
    return {
      kind: "card",
      market: ids.market,
      collectionId: ids.collection,
      identifier: `card:${r.key}`,
      name: r.name,
      grade,
      // Manual price until the graded API key is provisioned; seeded from
      // the Collector Crypt median as the operator-attested starting value.
      source: "manual",
      usdPrice: r.median_usd,
      lookbackDays: 14,
      minSales: 5,
      maxDisagreementBps: 1500,
      _snapshot: {
        ccListings: r.listings,
        ccFloorUsd: r.floor_usd,
        category: r.category,
      },
    };
  });

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    `${DATA_DIR}/allowlist.yaml`,
    "# Generated by scripts/allowlist.ts. Snapshot fields (_snapshot) are\n" +
      "# informational. collectionId feeds create_market; market is the\n" +
      "# derived PDA. Re-run before every listing decision.\n" +
      stringify({
        generatedAt: new Date().toISOString(),
        thresholds: { nft: NFT, card: CARD },
        markets: [...nftEntries, ...cardEntries],
      })
  );

  console.log(`\nNFT collections qualifying: ${nftEntries.length}`);
  for (const e of nftEntries) {
    console.log(
      `  ${e.symbol.padEnd(34)} floor ${String(e._snapshot.floorSol).padStart(7)}  listed ${String(e._snapshot.listed).padStart(5)}  7d ${String(e._snapshot.weeklyVolSol).padStart(8)} SOL`
    );
  }
  console.log(`\nCard markets qualifying: ${cardEntries.length}`);
  const byCat: Record<string, number> = {};
  for (const e of cardEntries) byCat[e._snapshot.category] = (byCat[e._snapshot.category] ?? 0) + 1;
  console.log(`  by franchise: ${JSON.stringify(byCat)}`);
  console.log(`\nwrote ${DATA_DIR}/allowlist.yaml (${nftEntries.length + cardEntries.length} markets)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
