import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplCore, fetchAsset } from "@metaplex-foundation/mpl-core";
import { publicKey } from "@metaplex-foundation/umi";
const umi = createUmi("https://api.mainnet-beta.solana.com").use(mplCore());
for (const a of ["7iMMDFqAp2W5S4SiYKQWVC4QksDGvGRFQarzrpyZqA9N","CQEWqnUSwn9RNFjwmeYXon8zKH6pztQuyoth2qWm55Ep","DYSHhuajQG3iD87jBhbkGU5gyndaZAnxT5WVmkLM4EVa"]) {
  const asset = await fetchAsset(umi, publicKey(a));
  console.log(asset.name, "->", asset.uri);
  const r = await fetch(asset.uri);
  const j = await r.json().catch(() => null);
  console.log("  json ok:", !!j, "| image:", j?.image?.slice(0, 55));
  if (j?.image) {
    const ir = await fetch(j.image, { method: "HEAD" });
    console.log("  image status:", ir.status, ir.headers.get("content-type"));
  }
}
