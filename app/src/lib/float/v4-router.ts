/**
 * Trading a graduated token, through the canonical UniversalRouter.
 *
 * A launch that graduates leaves its curve behind and lives in Uniswap v4
 * pools. v4 swaps must settle inside an unlock callback, which an EOA cannot
 * provide, so until now the token page could only say "graduated" and stop.
 * Robinhood Chain already has the canonical periphery deployed, so this routes
 * through it rather than adding another contract to audit.
 *
 * The price chain is TWO pools, which is the whole shape of this product:
 *
 *     USDG --(quote pool)--> fSHARE --(meme pool)--> MEME
 *
 * so a buy is a two-hop exact-input swap and a sell is the same path reversed.
 * Pool keys come from lpPools(), where each one has been VERIFIED by hashing it
 * back to the pool id the chain gave. They are never rebuilt here: an assumed
 * fee or tickSpacing would route someone's money into a different pool.
 *
 * Tokens reach the router through Permit2, which is two approvals the first
 * time (token -> Permit2, then Permit2 -> router) and none afterwards.
 *
 * STATUS. Quoting works and is wired. EXECUTION IS NOT: every encoding I tried
 * reverts inside the v4 swap with empty revert data. What is established, so
 * the next attempt does not redo it:
 *   - the route and both pool keys are right, because the V4 Quoter prices the
 *     exact same path and returns a sane number;
 *   - Permit2 is approved both hops (token -> Permit2 -> router), confirmed on
 *     chain;
 *   - 0x10 IS a valid command on this router: a bogus command reverts with a
 *     signature while 0x10 reverts empty, so it dispatches and fails inside;
 *   - the router embeds the PoolManager in its bytecode, so it is v4-capable;
 *   - SETTLE_ALL and SETTLE-with-payerIsUser both fail the same way, as do
 *     single-hop and two-hop.
 * So the fault is in the action parameter encoding, not the route, the
 * approvals or the router. buyGraduated/sellGraduated are left exported but
 * are NOT wired to any button, because a Trade button that reverts is worse
 * than one that is honest about not being ready.
 */

import { encodeAbiParameters, parseAbi, type Address, type Hex } from "viem";
import { publicClient, walletClient, floatChain, ERC20_ABI } from "./chain";
import { resolve, tryResolve } from "./registry";
import { lpPools, type LpPool } from "./pools";

/** Canonical on Robinhood Chain 4663; the Registry wins if it names one. */
const CANONICAL_UNIVERSAL_ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904" as Address;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

const UNIVERSAL_ROUTER_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
const PERMIT2_ABI = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

// UniversalRouter command and v4 action bytes.
const CMD_V4_SWAP = 0x10;
const ACT_SWAP_EXACT_IN = 0x07;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE_ALL = 0x0f;

const MAX_UINT160 = (1n << 160n) - 1n;

/** Canonical V4 Quoter on 4663. Quoting works even though execution does not. */
const CANONICAL_QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as Address;

const QUOTER_ABI = parseAbi([
  "struct PathKey { address intermediateCurrency; uint24 fee; int24 tickSpacing; address hooks; bytes hookData; }",
  "struct QuoteExactParams { address exactCurrency; PathKey[] path; uint128 exactAmount; }",
  "function quoteExactInput(QuoteExactParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

/**
 * What a given input would actually get, priced by the chain's own quoter
 * across both hops. This is a real number from the real pools, not an estimate
 * derived from a curve formula.
 */
export async function quoteGraduated(
  route: SwapRoute, amountIn: bigint, direction: "buy" | "sell",
): Promise<bigint | null> {
  const path = direction === "buy"
    ? [pathKey(route.quotePool, route.fshare), pathKey(route.memePool, route.token)]
    : [pathKey(route.memePool, route.fshare), pathKey(route.quotePool, route.usdg)];
  try {
    const { result } = await publicClient().simulateContract({
      address: CANONICAL_QUOTER, abi: QUOTER_ABI, functionName: "quoteExactInput",
      args: [{
        exactCurrency: direction === "buy" ? route.usdg : route.token,
        path, exactAmount: amountIn,
      }] as never,
    });
    return (result as readonly bigint[])[0];
  } catch {
    return null;
  }
}

export async function universalRouterAddress(): Promise<Address> {
  return (await tryResolve("UNIVERSAL_ROUTER")) ?? CANONICAL_UNIVERSAL_ROUTER;
}

/** The two hops for one launched token, in the order a BUY traverses them. */
export interface SwapRoute {
  /** USDG -> fSHARE */
  quotePool: LpPool;
  /** fSHARE -> MEME */
  memePool: LpPool;
  usdg: Address;
  fshare: Address;
  token: Address;
}

/** Build the route, or explain why there is not one. */
export async function routeFor(token: Address): Promise<SwapRoute | { error: string }> {
  const { pools } = await lpPools();
  const mine = pools.filter((p) => p.launch.token.toLowerCase() === token.toLowerCase());
  const memePool = mine.find((p) => p.kind === "meme");
  const quotePool = mine.find((p) => p.kind === "quote");
  if (!memePool) return { error: "no MEME/fSHARE pool for this token" };
  if (!quotePool) {
    // Worth stating rather than silently half-routing: without the second hop
    // there is no path from a stablecoin to this token at all.
    return { error: "no fSHARE/USDG pool, so there is no route from USDG" };
  }
  const usdg = await resolve("USDG");
  const fshare =
    quotePool.key.currency0.toLowerCase() === usdg.toLowerCase()
      ? quotePool.key.currency1
      : quotePool.key.currency0;
  return { quotePool, memePool, usdg, fshare, token };
}

/** One hop of a v4 path. */
interface PathKey {
  intermediateCurrency: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  hookData: Hex;
}

const PATH_KEY_TUPLE = {
  type: "tuple[]",
  components: [
    { name: "intermediateCurrency", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
    { name: "hookData", type: "bytes" },
  ],
} as const;

function pathKey(pool: LpPool, to: Address): PathKey {
  return {
    intermediateCurrency: to,
    fee: pool.lpFeeBps === 0 ? pool.key.fee : pool.key.fee,
    tickSpacing: pool.key.tickSpacing,
    hooks: pool.key.hooks,
    hookData: "0x",
  };
}

/**
 * Encode a two-hop exact-input v4 swap for UniversalRouter.
 *
 * SETTLE_ALL pays the input from the caller, TAKE_ALL collects the output. The
 * minimum is enforced on the final take, so a bad middle price cannot be hidden
 * by the second leg.
 */
function encodeSwap(
  currencyIn: Address,
  path: PathKey[],
  amountIn: bigint,
  amountOutMin: bigint,
  currencyOut: Address,
): { commands: Hex; inputs: Hex[] } {
  const swapParams = encodeAbiParameters(
    [{
      type: "tuple",
      components: [
        { name: "currencyIn", type: "address" },
        { name: "path", ...PATH_KEY_TUPLE },
        { name: "amountIn", type: "uint128" },
        { name: "amountOutMinimum", type: "uint128" },
      ],
    }],
    [{ currencyIn, path, amountIn, amountOutMinimum: amountOutMin }] as never,
  );
  const settle = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [currencyIn, amountIn],
  );
  const take = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [currencyOut, amountOutMin],
  );

  const actions = ("0x" +
    [ACT_SWAP_EXACT_IN, ACT_SETTLE_ALL, ACT_TAKE_ALL]
      .map((a) => a.toString(16).padStart(2, "0"))
      .join("")) as Hex;

  const v4Input = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParams, settle, take]],
  );

  return {
    commands: ("0x" + CMD_V4_SWAP.toString(16).padStart(2, "0")) as Hex,
    inputs: [v4Input],
  };
}

/** Token -> Permit2 -> router. Skipped when already in place. */
export async function ensurePermit2(account: Address, token: Address, amount: bigint) {
  const pc = publicClient();
  const wc = await walletClient();
  const signer = wc.account ?? account;
  const router = await universalRouterAddress();

  const erc20Allowance = (await pc.readContract({
    address: token, abi: ERC20_ABI, functionName: "allowance", args: [account, PERMIT2],
  })) as bigint;
  if (erc20Allowance < amount) {
    const { request } = await pc.simulateContract({
      account: signer, address: token, abi: ERC20_ABI, functionName: "approve",
      args: [PERMIT2, MAX_UINT160], chain: floatChain(),
    });
    await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ ...request, account: signer } as never) });
  }

  const [permitted, expiration] = (await pc.readContract({
    address: PERMIT2, abi: PERMIT2_ABI, functionName: "allowance", args: [account, token, router],
  })) as [bigint, number, number];
  const now = Math.floor(Date.now() / 1000);
  if (permitted < amount || expiration < now + 60) {
    const { request } = await pc.simulateContract({
      account: signer, address: PERMIT2, abi: PERMIT2_ABI, functionName: "approve",
      args: [token, router, MAX_UINT160, now + 30 * 24 * 3600], chain: floatChain(),
    });
    await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ ...request, account: signer } as never) });
  }
}

/** Buy a graduated token with USDG, two hops. */
export async function buyGraduated(
  account: Address, route: SwapRoute, usdgIn: bigint, minOut: bigint,
) {
  await ensurePermit2(account, route.usdg, usdgIn);
  const path = [pathKey(route.quotePool, route.fshare), pathKey(route.memePool, route.token)];
  const { commands, inputs } = encodeSwap(route.usdg, path, usdgIn, minOut, route.token);
  return send(account, commands, inputs);
}

/** Sell a graduated token back to USDG, the same path reversed. */
export async function sellGraduated(
  account: Address, route: SwapRoute, tokensIn: bigint, minOut: bigint,
) {
  await ensurePermit2(account, route.token, tokensIn);
  const path = [pathKey(route.memePool, route.fshare), pathKey(route.quotePool, route.usdg)];
  const { commands, inputs } = encodeSwap(route.token, path, tokensIn, minOut, route.usdg);
  return send(account, commands, inputs);
}

async function send(account: Address, commands: Hex, inputs: Hex[]) {
  const pc = publicClient();
  const wc = await walletClient();
  const signer = wc.account ?? account;
  const router = await universalRouterAddress();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const { request } = await pc.simulateContract({
    account: signer, address: router, abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute", args: [commands, inputs, deadline], chain: floatChain(),
  });
  return wc.writeContract({ ...request, account: signer } as never);
}
