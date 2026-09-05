/**
 * One real launch on Robinhood Chain mainnet, through the SHIPPED builders.
 *
 * Same principle as the testnet run: exercise lib/float/curve-funder.ts rather
 * than a reimplementation, because simulating only proves the calldata builds.
 * This one also writes token metadata, which only the TokenMetadata owner may
 * do and this key is that owner.
 *
 *   NEXT_PUBLIC_FLOAT_NETWORK=float-mainnet bun scripts/e2e-mainnet-launch.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { setWalletClientFactory, floatChain, publicClient, waitFor, balanceOf } from "../src/lib/float/chain";
import { cfTx, cfLaunchParams, cfCurve, setTokenMeta, readTokenMeta, tokenMetaOwner } from "../src/lib/float/curve-funder";
import { resolve } from "../src/lib/float/registry";
import { activeNetwork } from "../src/lib/float/networks";

const raw = readFileSync(`${homedir()}/.float/mainnet-deployer`, "utf8").trim().split("\n");
const pk = (raw.find((l) => l.startsWith("0x") && l.length === 66) ?? raw[1]) as `0x${string}`;
const account = privateKeyToAccount(pk);
const USER = account.address as Address;

setWalletClientFactory(async () =>
  createWalletClient({ account, chain: floatChain(), transport: http(floatChain().rpcUrls.default.http[0]) }),
);

const net = activeNetwork();
console.log(`launching on ${net.label} (${net.chainId}) as ${USER}`);
if (net.chainId !== 4663) { console.log("not mainnet, aborting"); process.exit(1); }

const usdg = await resolve("USDG");
const gas0 = await publicClient().getBalance({ address: USER });
console.log(`gas ${Number(gas0) / 1e18} ETH, USDG ${Number(await balanceOf(usdg, USER)) / 1e6}`);

const p = await cfLaunchParams();
console.log(`launch fee ${Number(p.launchFee) / 1e6} USDG, trade fee ${p.feeBps / 100}%, creator share ${p.creatorShareBps / 100}%`);
console.log(`metadata owner ${await tokenMetaOwner()} (me: ${USER})`);

// assetId is keccak(ticker), not the padded string.
const { keccak256, toBytes } = await import("viem");
const assetId = keccak256(toBytes("NINTENDO"));
console.log(`underlying NINTENDO -> ${assetId}`);

const SYMBOL = `FDTEST${Date.now().toString().slice(-4)}`;
console.log(`\nlaunching ${SYMBOL}…`);
const hash = await cfTx.launchToken(USER, "Floatdesk Launch Test", SYMBOL, assetId);
const rc = await waitFor(hash);
console.log(`  landed in block ${rc.blockNumber}, gas used ${rc.gasUsed}`);

const TOPIC = "0xa8b3974b09b1de10bb055f1f5d0aa2744ae82c67d97863faf66308126f10d33d";
const log = rc.logs.find((l) => l.topics[0]?.toLowerCase() === TOPIC);
const token = ("0x" + (log?.topics[1] ?? "").slice(26)) as Address;
console.log(`  token ${token}`);

const c = await cfCurve(token);
console.log(`  curve: share ${c.share}, gradTarget ${Number(c.gradTarget) / 1e6} USDG, graduated ${c.graduated}`);

console.log(`\nattaching metadata…`);
const metaHash = await setTokenMeta(USER, token, {
  name: "Floatdesk Launch Test",
  symbol: SYMBOL,
  description: "End to end launch test from the Floatdesk launchpad.",
  image: "https://floatdesk.xyz/sailboat-white.png",
  website: "https://floatdesk.xyz",
});
await waitFor(metaHash);
console.log("  set. reading it back:", JSON.stringify(await readTokenMeta(token)));

const gas1 = await publicClient().getBalance({ address: USER });
console.log(`\ngas left ${Number(gas1) / 1e18} ETH (spent ${Number(gas0 - gas1) / 1e18})`);
console.log(`explorer: ${net.explorer}/address/${token}`);
