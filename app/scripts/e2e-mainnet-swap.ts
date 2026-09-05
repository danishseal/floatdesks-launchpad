/**
 * Buy a GRADUATED token on mainnet through the UniversalRouter, two hops.
 * The path is USDG -> fSHARE -> MEME, with keys verified by lpPools().
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { setWalletClientFactory, floatChain, publicClient, waitFor, balanceOf } from "../src/lib/float/chain";
import { routeFor, buyGraduated, universalRouterAddress } from "../src/lib/float/v4-router";
import { activeNetwork } from "../src/lib/float/networks";

const raw = readFileSync(`${homedir()}/.float/mainnet-deployer`, "utf8").trim().split("\n");
const pk = (raw.find((l) => l.startsWith("0x") && l.length === 66) ?? raw[1]) as `0x${string}`;
const account = privateKeyToAccount(pk);
const USER = account.address as Address;
setWalletClientFactory(async () =>
  createWalletClient({ account, chain: floatChain(), transport: http(floatChain().rpcUrls.default.http[0]) }),
);

const net = activeNetwork();
if (net.chainId !== 4663) { console.log("not mainnet"); process.exit(1); }
const DOZE = "0xa34F722073E0935F2BB9946A8d34Ed955511f663" as Address;

console.log(`router ${await universalRouterAddress()}`);
const route = await routeFor(DOZE);
if ("error" in route) { console.log("no route:", route.error); process.exit(1); }

const before = await balanceOf(DOZE, USER);
const usdgBefore = await balanceOf(route.usdg, USER);
const gas0 = await publicClient().getBalance({ address: USER });
console.log(`before: ${Number(before) / 1e18} DOZE, ${Number(usdgBefore) / 1e6} USDG, ${Number(gas0) / 1e18} ETH`);

const IN = 500_000n; // $0.50
console.log(`\nbuying with ${Number(IN) / 1e6} USDG (minOut 0, this is a probe)…`);
const hash = await buyGraduated(USER, route, IN, 0n);
const rc = await waitFor(hash);
console.log(`  landed block ${rc.blockNumber}, gas ${rc.gasUsed}, status ${rc.status}`);

const after = await balanceOf(DOZE, USER);
const usdgAfter = await balanceOf(route.usdg, USER);
const gas1 = await publicClient().getBalance({ address: USER });
console.log(`after:  ${Number(after) / 1e18} DOZE, ${Number(usdgAfter) / 1e6} USDG`);
console.log(`got ${Number(after - before) / 1e18} DOZE for ${Number(usdgBefore - usdgAfter) / 1e6} USDG`);
console.log(`gas spent ${Number(gas0 - gas1) / 1e18} ETH`);
