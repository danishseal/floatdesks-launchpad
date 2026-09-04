/**
 * Mint 1/1 Metaplex Core NFTs with metadata (no inscriptions): the rail
 * where Solscan renders the artwork on the token page.
 *
 * Flow per image: upload image to Arweave via Irys -> upload metadata JSON
 * (name, description, image) -> mint a Core asset with that URI, owned by
 * the target wallet.
 *
 * Usage:
 *   node mint-core.mjs <cluster> <payerKeypair.json> <ownerPubkey|self> <dir-with-images> [collectionName]
 *
 * cluster: devnet | mainnet
 * Images: every .png/.jpg/.jpeg/.webp in the dir, alphabetical. A file
 * named meta.json in the dir may supply { "<filename>": { name, description } }.
 * Writes mint results to <dir>/mints.json.
 */
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { TurboFactory } from "@ardrive/turbo-sdk";
import { create, mplCore } from "@metaplex-foundation/mpl-core";
import { generateSigner, keypairIdentity, publicKey } from "@metaplex-foundation/umi";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import bs58 from "bs58";

/** Accept a raw keypair JSON, a base58 secret string, or the drop-file
 *  format (instructions header + key below the dashed line, optional
 *  owner pubkey on the following line). */
function parseKeyFile(path) {
  const raw = readFileSync(path, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("PASTE") && !l.startsWith("Accepted") && !l.startsWith("1)") && !l.startsWith("2)") && !l.startsWith("Notes") && !l.startsWith("-") && !l.startsWith("this") && !l.toLowerCase().startsWith("use ") && !l.toLowerCase().startsWith("owner") && !l.includes("machine"));
  const text = lines.join("\n");
  const arr = text.match(/\[[\d,\s]+\]/);
  let secret = null;
  let ownerLine = null;
  if (arr) {
    secret = Uint8Array.from(JSON.parse(arr[0]));
    const after = text.slice(text.indexOf(arr[0]) + arr[0].length).trim().split(/\s+/)[0];
    if (after && after.length >= 32 && after.length <= 44) ownerLine = after;
  } else {
    const candidates = lines.filter((l) => /^[1-9A-HJ-NP-Za-km-z]{60,120}$/.test(l));
    if (candidates.length) {
      secret = bs58.decode(candidates[0]);
      const pub = lines.find((l) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(l) && l !== candidates[0]);
      if (pub) ownerLine = pub;
    }
  }
  if (!secret || secret.length !== 64) throw new Error("no valid 64-byte secret key found in " + path);
  return { secret, ownerOverride: ownerLine };
}

const [cluster, keyPath, ownerArg, dir, collectionName = "floorlaunch originals"] =
  process.argv.slice(2);
if (!cluster || !keyPath || !ownerArg || !dir) {
  console.log("usage: node mint-core.mjs <devnet|mainnet> <payer.json> <ownerPubkey|self> <imageDir> [collectionName]");
  process.exit(1);
}

const RPC =
  cluster === "mainnet"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com";

const umi = createUmi(RPC).use(mplCore());
const parsed = parseKeyFile(keyPath);
const payerKp = umi.eddsa.createKeypairFromSecretKey(parsed.secret);
umi.use(keypairIdentity(payerKp));

// Permanent storage via ArDrive Turbo (Arweave): free under ~100KB per
// file, SOL-payable above. Same wallet signs uploads and mints.
const turbo = TurboFactory.authenticated({
  privateKey: bs58.encode(parsed.secret),
  token: "solana",
});
async function uploadBytes(bytes, contentType) {
  const res = await turbo.uploadFile({
    fileStreamFactory: () => Buffer.from(bytes),
    fileSizeFactory: () => bytes.length,
    dataItemOpts: { tags: [{ name: "Content-Type", value: contentType }] },
  });
  return `https://arweave.net/${res.id}`;
}
// Files above the free tier need Turbo credits: price the batch and top
// up from the payer wallet if the credit balance falls short.
async function ensureCredits(fileSizes) {
  const costs = await turbo.getUploadCosts({ bytes: fileSizes });
  const needed = costs.reduce((a, c) => a + BigInt(c.winc), 0n);
  const bal = BigInt((await turbo.getBalance()).winc);
  console.log(`turbo credits: have ${bal} winc, need ~${needed} winc`);
  if (bal >= needed) return;
  const lamports = 25_000_000; // 0.025 SOL buys comfortable margin
  console.log(`topping up ${lamports / 1e9} SOL of Turbo credits...`);
  const r = await turbo.topUpWithTokens({ tokenAmount: lamports });
  console.log(`top-up id: ${r?.id ?? JSON.stringify(r).slice(0, 120)}`);
  for (let i = 0; i < 30; i++) {
    const nb = BigInt((await turbo.getBalance()).winc);
    if (nb >= needed) { console.log(`credits ready: ${nb} winc`); return; }
    await new Promise((res) => setTimeout(res, 4000));
  }
  throw new Error("turbo top-up did not credit in time");
}

const owner =
  ownerArg === "self"
    ? parsed.ownerOverride
      ? publicKey(parsed.ownerOverride)
      : umi.identity.publicKey
    : publicKey(ownerArg);

console.log(`cluster: ${cluster}`);
console.log(`payer:   ${umi.identity.publicKey}`);
console.log(`owner:   ${owner}`);

const metaPath = join(dir, "meta.json");
const metaMap = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
const images = readdirSync(dir)
  .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
  .sort();
if (!images.length) throw new Error("no images in " + dir);
console.log(`images:  ${images.join(", ")}`);

await ensureCredits(images.map((f) => statSync(join(dir, f)).size).concat(images.map(() => 2048)));

const results = [];
for (const [i, file] of images.entries()) {
  const bytes = readFileSync(join(dir, file));
  const mime = /\.png$/i.test(file) ? "image/png" : /\.webp$/i.test(file) ? "image/webp" : "image/jpeg";
  const imageUri = await uploadBytes(bytes, mime);
  const m = metaMap[file] ?? {};
  const name = m.name ?? `${collectionName} #${i + 1}`;
  const jsonUri = await uploadBytes(
    Buffer.from(
      JSON.stringify({
        name,
        description: m.description ?? `${collectionName}: original artwork by floorlaunch.`,
        image: imageUri,
        external_url: "https://floorlaunch.xyz",
        properties: { files: [{ uri: imageUri, type: mime }], category: "image" },
      })
    ),
    "application/json"
  );

  const asset = generateSigner(umi);
  const tx = await create(umi, {
    asset,
    name,
    uri: jsonUri,
    owner,
  }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });

  const sigB58 = Buffer.from(tx.signature).toString("base64");
  const solscan =
    cluster === "mainnet"
      ? `https://solscan.io/token/${asset.publicKey}`
      : `https://solscan.io/token/${asset.publicKey}?cluster=devnet`;
  console.log(`minted ${name}`);
  console.log(`  asset:   ${asset.publicKey}`);
  console.log(`  image:   ${imageUri}`);
  console.log(`  json:    ${jsonUri}`);
  console.log(`  solscan: ${solscan}`);
  results.push({ file, name, asset: String(asset.publicKey), imageUri, jsonUri, solscan });
  writeFileSync(join(dir, "mints.json"), JSON.stringify(results, null, 2));
}
console.log("\nALL MINTED -> mints.json");
