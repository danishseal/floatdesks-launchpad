/** What the graduated pools actually are: which currencies, and what is shared. */
import { lpPools } from "../src/lib/float/pools";
import { resolve } from "../src/lib/float/registry";

const usdg = (await resolve("USDG")).toLowerCase();
const { pools } = await lpPools();
console.log(`USDG ${usdg}\n`);
const quoteIds = new Set<string>();
const fshares = new Set<string>();
for (const p of pools) {
  const c0 = p.key.currency0.toLowerCase(), c1 = p.key.currency1.toLowerCase();
  if (p.kind === "quote") {
    quoteIds.add(p.poolId.toLowerCase());
    fshares.add((c0 === usdg ? c1 : c0).toLowerCase());
  }
  console.log(
    `${p.kind.padEnd(5)} ${p.launch.symbol?.padEnd(8) ?? "?".padEnd(8)} ` +
    `pool ${p.poolId.slice(0, 10)}  ${c0.slice(0, 10)} / ${c1.slice(0, 10)}  fee ${p.key.fee}`
  );
}
console.log(`\n${pools.length} pools, ${quoteIds.size} DISTINCT quote pool(s), ${fshares.size} distinct fSHARE(s)`);
console.log(fshares.size === 1
  ? "-> one shared fSHARE/USDG hop: every meme's flow crosses the same pool"
  : "-> separate hops: an LP in one quote pool sees only that launch's flow");
