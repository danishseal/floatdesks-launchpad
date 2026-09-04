/**
 * Swap Panel I and Panel III naming: the triptych's true left panel is
 * IMG_4368 (minted third) and the right panel is IMG_4365 (minted first).
 * Uploads corrected metadata JSONs (free tier) and updates both Core
 * assets' name + uri on chain. Panel II is untouched.
 */
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { TurboFactory } from "@ardrive/turbo-sdk";
import { update, fetchAsset, mplCore } from "@metaplex-foundation/mpl-core";
import { keypairIdentity, publicKey } from "@metaplex-foundation/umi";
import { readFileSync } from "node:fs";
import bs58 from "bs58";

const keyPath = process.argv[2];
if (!keyPath) throw new Error("usage: node fix-panel-order.mjs <keyfile>");

const raw = readFileSync(keyPath, "utf8");
const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
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

const FIXES = [
  {
    asset: "7iMMDFqAp2W5S4SiYKQWVC4QksDGvGRFQarzrpyZqA9N", // was Panel III (IMG_4368)
    name: "The Last Supper Panel I",
    description: "floorlaunch original: The Last Supper triptych, left panel. 1/1.",
    image: "https://arweave.net/7tPcXyyCLl5dAypXGEBUBM1AhxzLMgMvlf5Xkx5BNdk",
  },
  {
    asset: "DYSHhuajQG3iD87jBhbkGU5gyndaZAnxT5WVmkLM4EVa", // was Panel I (IMG_4365)
    name: "The Last Supper Panel III",
    description: "floorlaunch original: The Last Supper triptych, right panel. 1/1.",
    image: "https://arweave.net/YIvyHbrbGyUfT906LYk9T7aadiyu7VF8XdpKtyW6Qsk",
  },
];

for (const f of FIXES) {
  const jsonUri = await uploadJson({
    name: f.name,
    description: f.description,
    image: f.image,
    external_url: "https://floorlaunch.xyz",
    properties: { files: [{ uri: f.image, type: "image/png" }], category: "image" },
  });
  const asset = await fetchAsset(umi, publicKey(f.asset));
  const sig = await update(umi, { asset, name: f.name, uri: jsonUri }).sendAndConfirm(umi);
  console.log(`${f.asset} -> "${f.name}"`);
  console.log(`  json: ${jsonUri}`);
  console.log(`  tx:   ${bs58.encode(sig.signature)}`);
}
console.log("done");
