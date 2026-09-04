/**
 * Localnet launch executor + listing metadata store.
 *
 * POST /dev/launch mirrors the admin-gated v1 listing flow: the UI submits
 * an underlying (from the allowlist catalog) plus token metadata (ticker,
 * name, image, links, fee receiver); this module creates the market with
 * the local admin key, pushes an initial index with the oracle key, and
 * persists the listing metadata for the UI.
 *
 * Guard rails: only enabled against a localhost RPC. On devnet/mainnet the
 * same shape becomes a queue the admin approves.
 */
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getOrCreateEscrow, type Platform } from "./escrow.js";
import { loadAdminKeypair, loadOracleKeypair } from "./keypairs.js";

const LAMPORTS = 1e9;
const BASE_UNITS_PER_NFT = 1_000_000_000_000n;
const CATALOG_PATH = fileURLToPath(
  new URL("../bundled/underlyings.json", import.meta.url),
);
const RESOLVED_CATALOG_PATH = process.env.CATALOG_PATH ?? CATALOG_PATH;
const CARD_MINTS_PATH = fileURLToPath(
  new URL("../bundled/card-onchain-mints.json", import.meta.url),
);
const RESOLVED_CARD_MINTS_PATH =
  process.env.CARD_MINTS_PATH ?? CARD_MINTS_PATH;
const LISTINGS_PATH =
  process.env.LISTINGS_PATH ??
  new URL("../data/listings.json", import.meta.url).pathname;
export const FEE_TREASURY = process.env.FEE_TREASURY ?? "BNbCZjxJJ3UT75XyvzHA7ZL9yb7kVonw2GR1TDtSGNAX";
export const LAUNCH_FEE_LAMPORTS = Number(process.env.LAUNCH_FEE_LAMPORTS ?? 100_000_000);
const RESERVED_TICKERS = new Set(["SOL", "USDC", "BTC", "ETH", "FL", "FLOOR"]);
let launchQueue = Promise.resolve();

export type FeeReceiver =
  | { kind: "wallet" | "address"; value: string }
  | { kind: Platform; value: string; escrow: string };

export interface ListingMeta {
  ticker: string;
  name: string;
  image: string | null;
  links: {
    twitter?: string;
    website?: string;
    discord?: string;
    telegram?: string;
    collectiblePage?: string;
    description?: string;
  };
  feeReceiver: FeeReceiver;
  launchedBy: string;
  launchedAt: number;
  identifier: string;
  feePaymentSig?: string | null;
}

export function loadListings(): Record<string, ListingMeta> {
  try {
    return JSON.parse(readFileSync(LISTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function tickerAvailability(rawTicker: string): {
  ticker: string;
  available: boolean;
} {
  const suffix = String(rawTicker ?? "")
    .trim()
    .replace(/^fl/i, "")
    .toUpperCase();
  if (!/^[A-Z]{1,8}$/.test(suffix) || RESERVED_TICKERS.has(suffix)) {
    return { ticker: suffix ? `fl${suffix}` : "", available: false };
  }
  const ticker = `fl${suffix}`;
  const available = !Object.values(loadListings()).some(
    (listing) => listing.ticker.toUpperCase() === ticker.toUpperCase()
  );
  return { ticker, available };
}

export async function launchReadiness(rpcUrl: string): Promise<{
  ready: true;
  admin: { address: string; balanceLamports: number; minimumLamports: number };
  oracle: { address: string; balanceLamports: number; minimumLamports: number };
}> {
  const connection = new Connection(rpcUrl, "confirmed");
  await connection.getLatestBlockhash("confirmed");

  const admin = loadAdminKeypair();
  const oracle = loadOracleKeypair();
  const [adminBalance, oracleBalance] = await Promise.all([
    connection.getBalance(admin.publicKey, "confirmed"),
    connection.getBalance(oracle.publicKey, "confirmed"),
  ]);
  const adminMinimum = Number(
    process.env.LAUNCH_ADMIN_MIN_BALANCE_LAMPORTS ?? 50_000_000
  );
  const oracleMinimum = Number(
    process.env.LAUNCH_ORACLE_MIN_BALANCE_LAMPORTS ?? 5_000_000
  );

  if (adminBalance < adminMinimum) {
    throw new Error(
      `launch signer ${admin.publicKey.toBase58()} has ${adminBalance} lamports; ` +
        `${adminMinimum} required`
    );
  }
  if (oracleBalance < oracleMinimum) {
    throw new Error(
      `oracle signer ${oracle.publicKey.toBase58()} has ${oracleBalance} lamports; ` +
        `${oracleMinimum} required`
    );
  }

  return {
    ready: true,
    admin: {
      address: admin.publicKey.toBase58(),
      balanceLamports: adminBalance,
      minimumLamports: adminMinimum,
    },
    oracle: {
      address: oracle.publicKey.toBase58(),
      balanceLamports: oracleBalance,
      minimumLamports: oracleMinimum,
    },
  };
}

async function solUsd(): Promise<number> {
  const r = await fetch(
    "https://hermes.pyth.network/v2/updates/price/latest?ids[]=0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d&parsed=true"
  );
  const b: any = await r.json();
  const p = b.parsed[0].price;
  return Number(p.price) * Math.pow(10, p.expo);
}

// Live oracle feed per collectible: Magic Eden floor for NFTs (5 min
// cache), configured USD price via Pyth for cards. This is the value
// launches initialize with and the refresher pushes; the allowlist
// snapshot is only the fallback when the live source is down.
const meCache = new Map<string, { at: number; floorSol: number | null }>();
export async function meFloor(symbol: string): Promise<number | null> {
  const hit = meCache.get(symbol);
  if (hit && Date.now() - hit.at < 300_000) return hit.floorSol;
  try {
    const r = await fetch(`https://api-mainnet.magiceden.dev/v2/collections/${symbol}/stats`);
    const b: any = await r.json();
    const v = b?.floorPrice > 0 ? b.floorPrice / 1e9 : null;
    meCache.set(symbol, { at: Date.now(), floorSol: v });
    return v;
  } catch {
    meCache.set(symbol, { at: Date.now(), floorSol: null });
    return null;
  }
}

/** Oracle feed value in lamports for a catalog entry; null if no source. */
export async function oracleFeedLamports(u: any, solUsdPrice: number): Promise<number | null> {
  if (u.kind === "nft") {
    const live = u.identifier?.startsWith("magiceden:")
      ? await meFloor(u.identifier.split(":")[1])
      : null;
    const sol = live ?? u.snapshot?.floorSol ?? null;
    return sol ? Math.round(sol * LAMPORTS) : null;
  }
  const usd = u.usdPrice ?? u.snapshot?.ccFloorUsd;
  return usd && solUsdPrice > 0 ? Math.round((usd / solUsdPrice) * LAMPORTS) : null;
}

export function catalogByIdentifier(identifier: string): any | undefined {
  const catalog = loadCatalog();
  return catalog.find((c) => c.identifier === identifier);
}

export function loadCatalog(): any[] {
  return JSON.parse(readFileSync(RESOLVED_CATALOG_PATH, "utf8"));
}

export const CC_COLLECTION = "CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac";

const collectionOf = (asset: any): string | undefined =>
  (asset.grouping ?? []).find(
    (group: any) => group.group_key === "collection",
  )?.group_value;

const attributeOf = (asset: any, trait: string): string | undefined =>
  (asset.content?.metadata?.attributes ?? []).find(
    (attribute: any) => attribute.trait_type === trait,
  )?.value;

function cardIdentifierOf(asset: any): string | null {
  const year = attributeOf(asset, "Year");
  const set = attributeOf(asset, "Set");
  const serial = attributeOf(asset, "Serial Number");
  const gradingCompany = attributeOf(asset, "Grading Company");
  const grade = attributeOf(asset, "The Grade");
  if (!year || !set || !serial || !gradingCompany || !grade) return null;
  return `card:${year}|${set}|#${serial}|${gradingCompany}|${grade}`;
}

let cardMintIdentifierCache: Map<string, string> | null = null;

function cardIdentifiersByMint(): Map<string, string> {
  if (cardMintIdentifierCache) return cardMintIdentifierCache;
  try {
    const registry = JSON.parse(
      readFileSync(RESOLVED_CARD_MINTS_PATH, "utf8"),
    ) as {
      cards?: Record<string, Array<{ mint?: string }>>;
    };
    const identifiers = new Map<string, string>();
    for (const [identifier, copies] of Object.entries(registry.cards ?? {})) {
      for (const copy of copies) {
        if (copy.mint) identifiers.set(copy.mint, identifier);
      }
    }
    cardMintIdentifierCache = identifiers;
  } catch {
    cardMintIdentifierCache = new Map();
  }
  return cardMintIdentifierCache;
}

async function assetsByOwner(rpcUrl: string, owner: string): Promise<any[]> {
  const ownerAddress = new PublicKey(owner).toBase58();
  const assets: any[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: page,
        method: "getAssetsByOwner",
        params: { ownerAddress, page, limit: 1_000 },
      }),
    });
    if (!response.ok) {
      throw new Error(`DAS request failed with ${response.status}`);
    }
    const body: any = await response.json();
    if (body.error) {
      throw new Error(body.error.message ?? "DAS getAssetsByOwner failed");
    }
    const items = body.result?.items ?? [];
    assets.push(...items);
    if (items.length < 1_000) break;
  }
  return assets;
}

export async function cardHoldings(
  rpcUrl: string,
  owner: string,
): Promise<{ owner: string; ccCardsHeld: number; held: any[] }> {
  const ownerAddress = new PublicKey(owner).toBase58();
  const catalog = loadCatalog();
  const byIdentifier = new Map(
    catalog.map((underlying) => [underlying.identifier, underlying]),
  );
  const cardIdentifiers = new Set(
    catalog
      .filter((underlying) => underlying.kind === "card")
      .map((underlying) => underlying.identifier),
  );
  const registeredCardByMint = cardIdentifiersByMint();
  const nftByCollection = new Map<string, any>();
  for (const underlying of catalog) {
    if (underlying.kind === "nft" && underlying.verifiedCollection) {
      nftByCollection.set(underlying.verifiedCollection, underlying);
    }
  }

  const assets = await assetsByOwner(rpcUrl, ownerAddress);
  const collectorCryptCards = assets.filter(
    (asset) => collectionOf(asset) === CC_COLLECTION,
  );
  const counts = new Map<string, number>();
  for (const asset of collectorCryptCards) {
    // Prefer the audited mainnet mint registry. Attribute parsing remains a
    // fallback for newly vaulted cards that have not reached the export yet.
    const identifier =
      registeredCardByMint.get(asset.id) ?? cardIdentifierOf(asset);
    if (identifier && cardIdentifiers.has(identifier)) {
      counts.set(identifier, (counts.get(identifier) ?? 0) + 1);
    }
  }
  for (const asset of assets) {
    const collection = collectionOf(asset);
    const underlying = collection
      ? nftByCollection.get(collection)
      : undefined;
    if (underlying) {
      counts.set(
        underlying.identifier,
        (counts.get(underlying.identifier) ?? 0) + 1,
      );
    }
  }

  const held = [...counts.entries()].map(([identifier, copies]) => {
    const underlying = byIdentifier.get(identifier);
    return {
      identifier,
      kind: underlying.kind,
      name: underlying.name,
      grade: underlying.grade,
      category: underlying.category ?? underlying.snapshot?.category,
      market: underlying.market,
      collectionId: underlying.collectionId,
      copies,
    };
  });
  return {
    owner: ownerAddress,
    ccCardsHeld: collectorCryptCards.length,
    held,
  };
}

function normalizeLaunchMeta(
  meta: Omit<ListingMeta, "launchedAt" | "identifier">
): Omit<ListingMeta, "launchedAt" | "identifier"> {
  const launchedBy = new PublicKey(meta.launchedBy).toBase58();
  const rawTicker = String(meta.ticker ?? "").trim();
  const tickerMatch = /^fl([a-z]{1,8})$/i.exec(rawTicker);
  if (!tickerMatch) throw new Error("ticker must be fl followed by 1-8 letters");
  const tickerSuffix = tickerMatch[1].toUpperCase();
  if (RESERVED_TICKERS.has(tickerSuffix)) throw new Error("ticker is reserved");

  const name = String(meta.name ?? "").trim();
  if (!name || name.length > 48) throw new Error("name must be 1-48 characters");

  const receiver = meta.feeReceiver as FeeReceiver | undefined;
  if (!receiver) throw new Error("fee receiver is required");
  let feeReceiver: FeeReceiver;
  if (receiver.kind === "wallet" || receiver.kind === "address") {
    feeReceiver = {
      kind: receiver.kind,
      value: new PublicKey(receiver.value).toBase58(),
    };
  } else if (["x", "youtube", "elitefourum"].includes(receiver.kind)) {
    const handle = String(receiver.value ?? "").trim().replace(/^@/, "");
    if (!handle) throw new Error("fee receiver handle is required");
    if (handle.length > 100) throw new Error("fee receiver handle is too long");
    const escrow = getOrCreateEscrow(receiver.kind as Platform, handle);
    feeReceiver = {
      kind: receiver.kind as Platform,
      value: escrow.handle,
      escrow: escrow.escrowPubkey,
    };
  } else {
    throw new Error("unsupported fee receiver");
  }

  const listings = loadListings();
  if (
    Object.values(listings).some(
      (listing) => listing.ticker.toUpperCase() === `FL${tickerSuffix}`
    )
  ) {
    throw new Error(`fl${tickerSuffix} is already taken`);
  }

  return {
    ...meta,
    ticker: `fl${tickerSuffix}`,
    name,
    launchedBy,
    feeReceiver,
  };
}

type LaunchBody = {
  collectionId?: string;
  identifier?: string;
  feePaymentSig?: string;
  meta: Omit<ListingMeta, "launchedAt" | "identifier">;
};

export async function devLaunch(
  rpcUrl: string,
  programId: string,
  idl: any,
  body: LaunchBody
): Promise<{ market: string; indexLamports: number }> {
  const previousLaunch = launchQueue;
  let releaseQueue!: () => void;
  launchQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previousLaunch;
  try {
    return await executeLaunch(rpcUrl, programId, idl, body);
  } finally {
    releaseQueue();
  }
}

async function executeLaunch(
  rpcUrl: string,
  programId: string,
  idl: any,
  body: LaunchBody
): Promise<{ market: string; indexLamports: number }> {
  const isLocal = rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost");
  if (!isLocal && !rpcUrl.includes("devnet")) {
    throw new Error("dev launch is localnet/devnet-only");
  }
  const catalog = loadCatalog();
  const u = body.identifier
    ? catalog.find((c) => c.identifier === body.identifier)
    : catalog.find((c) => c.collectionId === body.collectionId);
  if (!u) throw new Error("unknown underlying");
  const meta = normalizeLaunchMeta(body.meta);

  // Initial index in lamports, from the live oracle feed (snapshot as
  // fallback inside the feed helper).
  const indexLamports = (await oracleFeedLamports(u, await solUsd()))!;
  if (!indexLamports) throw new Error("no oracle price available for this collectible");

  const admin = loadAdminKeypair();
  const oracle = loadOracleKeypair();
  const connection = new Connection(rpcUrl, "confirmed");

  // Launch fee: 0.1 SOL to the protocol treasury, paid by the launching
  // wallet in a separate tx the UI sends first. Localnet skips it.
  if (!isLocal) {
    const sig = body.feePaymentSig;
    if (!sig) throw new Error("launch fee payment required (0.1 SOL)");
    const prior = loadListings();
    if (Object.values(prior).some((l: any) => l.feePaymentSig === sig)) {
      throw new Error("fee payment already used");
    }
    const ftx = await connection.getTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!ftx || ftx.meta?.err) throw new Error("fee payment tx not found");
    if (ftx.blockTime && Date.now() / 1000 - ftx.blockTime > 900) {
      throw new Error("fee payment too old");
    }
    const keys = ftx.transaction.message.getAccountKeys().staticAccountKeys;
    const ti = keys.findIndex((k) => k.toBase58() === FEE_TREASURY);
    if (ti < 0) throw new Error("fee payment does not pay the treasury");
    const delta = ftx.meta!.postBalances[ti] - ftx.meta!.preBalances[ti];
    if (delta < LAUNCH_FEE_LAMPORTS) throw new Error("fee payment below 0.1 SOL");
    if (keys[0].toBase58() !== meta.launchedBy) {
      throw new Error("fee paid by a different wallet than the launcher");
    }
  }
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
    commitment: "confirmed",
  });
  const program = new anchor.Program(idl, provider);
  const pid = new PublicKey(programId);
  // Every launch gets its own market, even for the same underlying: the
  // on-chain collection id is a fresh hash of identifier + entropy, and
  // the underlying association lives in the listing metadata.
  const collection = new PublicKey(
    createHash("sha256")
      .update(`${u.identifier}|${Date.now()}|${randomBytes(8).toString("hex")}`)
      .digest()
  );
  const [globalPda] = PublicKey.findProgramAddressSync([Buffer.from("global")], pid);
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), collection.toBuffer()],
    pid
  );
  const [itemReservePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("items"), marketPda.toBuffer()],
    pid
  );

  // Every launch prices identically, like any launchpad: 1B token
  // supply, 25 SOL market cap open, migration once the curve has raised
  // 100 SOL so the AMM pool starts with 100 SOL inside it. The
  // underlying's price never touches the curve. vSol = 25 SOL virtual
  // against the full 1B supply sells 800M tokens over the 100 SOL raise
  // and closes at 0.625 SOL per 1M tokens (~625 SOL market cap). The
  // oracle index is LAUNCH-SCALED: one unit (1M tokens) is defined as
  // worth 0.625 SOL (the migration price) at launch and moves with the
  // collectible from there, so premium, funding and the breaker stay
  // meaningful and the AMM seeds at premium zero. unitsPerItemMicro
  // carries the item's real size for item swaps.
  const UNIT_LAMPORTS_AT_LAUNCH = 625_000_000; // 0.625 SOL per 1M tokens
  const unitsPerItemMicro = Math.max(
    1,
    Math.round((indexLamports / UNIT_LAMPORTS_AT_LAUNCH) * 1e6)
  );
  {
    const vSol = 25n * BigInt(LAMPORTS);
    const vTok = 1_000_000_000n * 1_000_000n; // full 1B supply on the curve
    const params = {
      indexWindowSecs: 30,
      minPushIntervalSecs: 0,
      breakerBps: 3000,
      maxIndexAgeSecs: 3600,
      markWindowSecs: 60,
      fundingKBps: 10000,
      maxFundingBpsPerDay: 10000,
      minCrankIntervalSecs: 1,
      initialCrBps: 15000,
      maintenanceCrBps: 12000,
      liqBonusBps: 500,
      maxOpenInterest: new BN("400000000000000"),
      // Room for 25 deposited items at launch scale.
      itemReserve: new BN(String(BigInt(unitsPerItemMicro) * 1_000_000n * 25n)),
      unitsPerItemMicro: new BN(String(unitsPerItemMicro)),
      curveFeeBps: 70,
      ammFeeBps: 70,
      graduationTargetSol: new BN(100).mul(new BN(LAMPORTS)),
      // The full raise seeds the pool: migration means 100 SOL inside it.
      insuranceShareBps: 0,
      curveVirtualSol: new BN(vSol.toString()),
      curveVirtualTokens: new BN(vTok.toString()),
    };
    await program.methods
      .createMarket(collection, params as any)
      .accountsPartial({
        global: globalPda,
        admin: admin.publicKey,
        market: marketPda,
        itemReserve: itemReservePda,
      })
      .rpc();
    await program.methods
      .pushIndex(new BN(UNIT_LAMPORTS_AT_LAUNCH))
      .accountsPartial({
        global: globalPda,
        oracleAuthority: oracle.publicKey,
        market: marketPda,
      })
      .signers([oracle])
      .rpc();
  }

  // Demo copies of the underlying: three item NFTs minted to the
  // launcher's wallet and registered for the market, standing in for
  // vaulted-card / collection NFTs until collection verification.
  const itemMints: string[] = [];
  const pace = () => new Promise((r) => setTimeout(r, rpcUrl.includes("devnet") ? 1_500 : 0));
  try {
    const spl = await import("@solana/spl-token");
    const adminKp = loadAdminKeypair();
    const owner = new PublicKey(meta.launchedBy);
    for (let i = 0; i < 3; i++) {
      await pace();
      const mint = await spl.createMint(connection, adminKp, adminKp.publicKey, null, 0);
      const ata = await spl.getOrCreateAssociatedTokenAccount(connection, adminKp, mint, owner);
      await spl.mintTo(connection, adminKp, mint, ata.address, adminKp, 1);
      const [reg] = PublicKey.findProgramAddressSync(
        [Buffer.from("item"), marketPda.toBuffer(), mint.toBuffer()],
        pid
      );
      await program.methods
        .registerItem()
        .accountsPartial({
          global: globalPda,
          admin: admin.publicKey,
          market: marketPda,
          itemMint: mint,
          registration: reg,
        })
        .rpc();
      itemMints.push(mint.toBase58());
    }
  } catch (e) {
    console.log("demo item setup failed:", String((e as any).message).slice(0, 80));
  }

  const listings = loadListings();
  listings[marketPda.toBase58()] = {
    ...meta,
    identifier: u.identifier,
    feePaymentSig: body.feePaymentSig ?? null,
    itemMints,
    indexAtLaunchLamports: indexLamports,
    unitsPerItemMicro,
    launchedAt: Math.floor(Date.now() / 1000),
  } as any;
  writeFileSync(LISTINGS_PATH, JSON.stringify(listings, null, 2));
  return { market: marketPda.toBase58(), indexLamports };
}
