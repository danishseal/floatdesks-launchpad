/**
 * Buy and sell a GRADUATED token on mainnet through the same builders the
 * Trade button calls. Two hops, USDG through the fSHARE, in real v4 pools.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { setWalletClientFactory, floatChain, publicClient, waitFor, balanceOf } from "../src/lib/float/chain";
import { routeFor, quoteGraduated, buyGraduated, sellGraduated } from "../src/lib/float/v4-router";
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
const r = await routeFor(DOZE);
if ("error" in r) { console.log("no route:", r.error); process.exit(1); }

const wad = (v: bigint) => (Number(v) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 4 });
const usd6 = (v: bigint) => `$${(Number(v) / 1e6).toFixed(4)}`;

const g0 = await publicClient().getBalance({ address: USER });
console.log(`start: ${usd6(await balanceOf(r.usdg, USER))} USDG, ${wad(await balanceOf(DOZE, USER))} DOZE, ${Number(g0)/1e18} ETH`);

const IN = 200_000n; // $0.20
const q = await quoteGraduated(r, IN, "buy");
console.log(`\nbuy ${usd6(IN)} -> quoted ${wad(q ?? 0n)} DOZE`);
const d0 = await balanceOf(DOZE, USER);
const rc1 = await waitFor(await buyGraduated(USER, r, IN, (q ?? 0n) * 95n / 100n));
const d1 = await balanceOf(DOZE, USER);
console.log(`  status ${rc1.status}, gas ${rc1.gasUsed}, received ${wad(d1 - d0)} DOZE`);

const back = (d1 - d0) / 2n;
const q2 = await quoteGraduated(r, back, "sell");
console.log(`\nsell ${wad(back)} DOZE -> quoted ${usd6(q2 ?? 0n)}`);
const u0 = await balanceOf(r.usdg, USER);
const rc2 = await waitFor(await sellGraduated(USER, r, back, (q2 ?? 0n) * 95n / 100n));
const u1 = await balanceOf(r.usdg, USER);
console.log(`  status ${rc2.status}, gas ${rc2.gasUsed}, received ${usd6(u1 - u0)}`);

const g1 = await publicClient().getBalance({ address: USER });
console.log(`\nend: ${usd6(u1)} USDG, ${wad(await balanceOf(DOZE, USER))} DOZE`);
console.log(`gas spent ${Number(g0 - g1) / 1e18} ETH`);
