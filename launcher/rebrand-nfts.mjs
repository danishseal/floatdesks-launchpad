/**
 * Rebrand the three mainnet Last Supper panels from floorlaunch to commas.
 * Names and images are unchanged; only the description wording and the
 * external_url are updated. Re-uploads metadata JSON via Turbo (free) and
 * updates each Core asset's uri on chain.
 */
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { TurboFactory } from "@ardrive/turbo-sdk";
import { update, fetchAsset, mplCore } from "@metaplex-foundation/mpl-core";
import { keypairIdentity, publicKey } from "@metaplex-foundation/umi";
import { readFileSync } from "node:fs";
import bs58 from "bs58";

const keyPath = process.argv[2];
if (!keyPath) throw new Error("usage: node rebrand-nfts.mjs <keyfile>");

const lines = readFileSync(keyPath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
let secret = null;
for (const l of lines) {
  if (l.startsWith("[")) { secret = Uint8Array.from(JSON.parse(l)); break; }
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(l)) { secret = bs58.decode(l); break; }
}
if (!secret) throw new Error("no key found in file");

const umi = createUmi("https://api.mainnet-beta.solana.com").use(mplCore());
umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(secret)));
const turbo = TurboFactory.authenticated({ privateKey: bs58.encode(secret), token: "solana" });

async function uploadJson(obj) {
  const bytes = Buffer.from(JSON.stringify(obj));
  const res = await turbo.uploadFile({
    fileStreamFactory: () => bytes,
    fileSizeFactory: () => bytes.length,
    dataItemOpts: { tags: [{ name: "Content-Type", value: "application/json" }] },
  });
  return `https://arweave.net/${res.id}`;
}

const ASSETS = [
  "7iMMDFqAp2W5S4SiYKQWVC4QksDGvGRFQarzrpyZqA9N",
  "CQEWqnUSwn9RNFjwmeYXon8zKH6pztQuyoth2qWm55Ep",
  "DYSHhuajQG3iD87jBhbkGU5gyndaZAnxT5WVmkLM4EVa",
];

for (const a of ASSETS) {
  const asset = await fetchAsset(umi, publicKey(a));
  const cur = await (await fetch(asset.uri)).json();
  const next = {
    ...cur,
    description: (cur.description ?? "").replace(/floorlaunch/g, "commas"),
    external_url: "https://commas.art",
  };
  const jsonUri = await uploadJson(next);
  const sig = await update(umi, { asset, uri: jsonUri }).sendAndConfirm(umi);
  console.log(`${a.slice(0, 6)} "${asset.name}"`);
  console.log(`   desc: ${next.description}`);
  console.log(`   json: ${jsonUri}`);
  console.log(`   tx:   ${bs58.encode(sig.signature)}`);
}
console.log("done");
