/**
 * Executes a real buy and a real sell of a graduated token against a fork of
 * 4663, through the SAME encoder the app ships (swapCalldata), and checks the
 * balances that moved against what the chain's own V4 Quoter said they would.
 *
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8471
 *   NEXT_PUBLIC_FLOAT_NETWORK=float-mainnet bun scripts/fork-swap.ts
 *
 * The account is impersonated, so this needs no key and spends nothing real.
 * Point it at a fresh fork block: the public RPC is not an archive node, so a
 * fork pinned to an old block cannot fetch token storage and fails with
 * "metadata is not found" rather than anything to do with the swap.
 */
import { encodeFunctionData, decodeFunctionResult, parseAbi, type Address, type Hex } from "viem";
import { routeFor, swapCalldata, quoteGraduated, universalRouterAddress } from "../src/lib/float/v4-router";

const FORK = process.env.FORK_RPC ?? "http://127.0.0.1:8471";
const WHO = (process.env.ACCOUNT ?? "0x4C9fE79EcA3B34b95944449EF126fAd3fe5a9061") as Address;
const TOKEN = (process.env.TOKEN ?? "0xa34F722073E0935F2BB9946A8d34Ed955511f663") as Address;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const MAX_UINT160 = (1n << 160n) - 1n;

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const P2 = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);

let id = 0;
async function rpc(method: string, params: unknown[]): Promise<string> {
  const r = await fetch(FORK, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const call = (to: Address, data: Hex) => rpc("eth_call", [{ to, data }, "latest"]);

async function send(to: Address, data: Hex, gas = "0x2dc6c0") {
  const hash = await rpc("eth_sendTransaction", [{ from: WHO, to, data, gas }]);
  // anvil automines, but the receipt is not always there on the very next call
  for (let i = 0; i < 60; i++) {
    const rcpt = (await rpc("eth_getTransactionReceipt", [hash])) as unknown as
      { status: string; gasUsed: string } | null;
    if (rcpt) return { status: parseInt(rcpt.status, 16), gas: parseInt(rcpt.gasUsed, 16) };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no receipt for ${hash}`);
}

async function balance(token: Address): Promise<bigint> {
  const out = await call(token, encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [WHO] }));
  return decodeFunctionResult({ abi: ERC20, functionName: "balanceOf", data: out as Hex }) as bigint;
}

const found = await routeFor(TOKEN);
// throw rather than process.exit: it narrows the union for everything below.
if ("error" in found) throw new Error(found.error);
const route = found;
const router = await universalRouterAddress();

await rpc("anvil_impersonateAccount", [WHO]);
await rpc("anvil_setBalance", [WHO, "0xde0b6b3a7640000"]);

// The quoter is read from the live chain, so each leg has to run against
// pristine forked state or the comparison is meaningless: a buy moves the price
// the sell would then be quoted at. Snapshot before, revert after.
async function leg(direction: "buy" | "sell", amountIn: bigint) {
  const snap = await rpc("evm_snapshot", []);
  try {
    return await runLeg(direction, amountIn);
  } finally {
    await rpc("evm_revert", [snap]);
  }
}

async function runLeg(direction: "buy" | "sell", amountIn: bigint) {
  const inTok = direction === "buy" ? route.usdg : route.token;
  const outTok = direction === "buy" ? route.token : route.usdg;

  await send(inTok, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [PERMIT2, MAX_UINT160] }));
  await send(PERMIT2, encodeFunctionData({
    abi: P2, functionName: "approve", args: [inTok, router, MAX_UINT160, 2 ** 48 - 1],
  }));

  const expected = await quoteGraduated(route, amountIn, direction);
  const before = await balance(outTok);
  const { commands, inputs } = swapCalldata(route, direction, amountIn, 0n);
  const data = encodeFunctionData({
    abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
    functionName: "execute",
    args: [commands, inputs, BigInt(Math.floor(Date.now() / 1000) + 3600)],
  });
  const r = await send(router, data);
  const got = (await balance(outTok)) - before;

  const agrees = expected !== null && expected === got;
  console.log(`${direction.padEnd(4)} in ${amountIn}  status ${r.status}  gas ${r.gas}`);
  console.log(`     out      ${got}`);
  console.log(`     quoted   ${expected ?? "(quote failed)"}   ${agrees ? "match" : "MISMATCH"}`);
  return r.status === 1 && agrees;
}

const ok = [await leg("buy", 500_000n), await leg("sell", 1_000_000_000_000_000_000_000n)];
console.log(ok.every(Boolean) ? "\nboth legs executed and matched the quoter" : "\nFAILED");
process.exit(ok.every(Boolean) ? 0 : 1);
