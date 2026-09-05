/**
 * Prints the calldata for the failing graduated-token swap, so it can be sent
 * to a fork with a fixed gas limit and traced. See the STATUS block in
 * src/lib/float/v4-router.ts for what the trace showed and what is ruled out.
 *
 *   ACTIONS=0x070c0f bun scripts/fork-calldata.ts
 */
import { encodeFunctionData, parseAbi, encodeAbiParameters, type Address, type Hex } from "viem";
import { routeFor } from "../src/lib/float/v4-router";
const DOZE = "0xa34F722073E0935F2BB9946A8d34Ed955511f663" as Address;
const r = await routeFor(DOZE);
if ("error" in r) { console.log(r.error); process.exit(1); }
const PATH = { type: "tuple[]", components: [
  { name: "intermediateCurrency", type: "address" }, { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }, { name: "hookData", type: "bytes" },
]} as const;
const path = [
  { intermediateCurrency: r.fshare, fee: r.quotePool.key.fee, tickSpacing: r.quotePool.key.tickSpacing, hooks: r.quotePool.key.hooks, hookData: "0x" },
  { intermediateCurrency: r.token, fee: r.memePool.key.fee, tickSpacing: r.memePool.key.tickSpacing, hooks: r.memePool.key.hooks, hookData: "0x" },
];
const swap = encodeAbiParameters([{ type: "tuple", components: [
  { name: "currencyIn", type: "address" }, { name: "path", ...PATH },
  { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" },
]}], [{ currencyIn: r.usdg, path, amountIn: 500000n, amountOutMinimum: 0n }] as never);
const settle = encodeAbiParameters([{type:"address"},{type:"uint256"}], [r.usdg, 500000n]);
const take = encodeAbiParameters([{type:"address"},{type:"uint256"}], [r.token, 0n]);
const ACTIONS = (process.env.ACTIONS ?? "0x070c0f") as Hex;
const input = encodeAbiParameters([{type:"bytes"},{type:"bytes[]"}], [ACTIONS, [swap, settle, take]]);
const data = encodeFunctionData({
  abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
  functionName: "execute",
  args: ["0x10" as Hex, [input], BigInt(Math.floor(Date.now()/1000)+3600)],
});
console.log(data);
