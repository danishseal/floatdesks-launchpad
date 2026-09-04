import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplCore, fetchAsset } from "@metaplex-foundation/mpl-core";
import { publicKey } from "@metaplex-foundation/umi";
const umi = createUmi("https://api.mainnet-beta.solana.com").use(mplCore());
for (const a of ["7iMMDFqAp2W5S4SiYKQWVC4QksDGvGRFQarzrpyZqA9N","CQEWqnUSwn9RNFjwmeYXon8zKH6pztQuyoth2qWm55Ep","DYSHhuajQG3iD87jBhbkGU5gyndaZAnxT5WVmkLM4EVa"]) {
  const asset = await fetchAsset(umi, publicKey(a));
  const j = await (await fetch(asset.uri)).json().catch(() => null);
  console.log(`${a.slice(0,6)} | name: ${asset.name}`);
  console.log(`   uri: ${asset.uri}`);
  console.log(`   json.name: ${j?.name} | desc: ${j?.description} | ext: ${j?.external_url}`);
}
