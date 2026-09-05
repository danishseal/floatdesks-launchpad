/**
 * The two v4 pools behind ONE token, asked for by name rather than found by
 * enumerating every pool on the deployment.
 *
 * `pools.ts` already enumerates the whole board, and that is the right shape for
 * the liquidity page. It is the wrong shape for a per-token question, and
 * measurably so: three consecutive calls to it returned 6, then 8, then 2 pools
 * on an unchanged chain, because it fans out a large number of reads and the
 * public RPC drops some under load. Asking it "does SNOOZE have a pool" that
 * third time answers no, and no is indistinguishable from a token that really
 * has none. The contracts grid printed exactly that: "graduated, but no v4 pool
 * was found for it", about a token whose pools are both live.
 *
 * So this asks the contract that knows. The curve stores its own `poolId` at
 * graduation and the launcher maps the underlying to its stock pool, which is
 * two reads for a known token instead of a scan. The pool KEY then comes from
 * the PoolManager's own `Initialize` log for that id, so the currencies are the
 * ones the pool was created with and not a reconstruction that has to be
 * verified afterwards.
 */

import type { Address } from "viem";
import { zeroAddress } from "viem";
import { CURVEFUNDER_ABI } from "./abi";
import { ERC20_ABI, publicClient } from "./chain";
import { resolve } from "./registry";
import { withRetry } from "./retry";

const ZERO_ID = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** v4's Initialize, which carries the whole pool key next to the id. */
const V4_INITIALIZE_EVENT = {
  type: "event",
  name: "Initialize",
  inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "currency0", type: "address", indexed: true },
    { name: "currency1", type: "address", indexed: true },
    { name: "fee", type: "uint24", indexed: false },
    { name: "tickSpacing", type: "int24", indexed: false },
    { name: "hooks", type: "address", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "tick", type: "int24", indexed: false },
  ],
} as const;

export interface TokenPool {
  /** meme = MEME/fSHARE, the pool the token trades in. quote = fSHARE/USDG. */
  kind: "meme" | "quote";
  poolId: `0x${string}`;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  /** Which currency is USDG, or null. Never infer this from the index. */
  usdgSide: 0 | 1 | null;
  /**
   * The price the pool was created at, and the block it happened in.
   *
   * A pool that has never been swapped still HAS a price: the one it was
   * initialised with. Without this, a token whose USDG/fSHARE pool has seen no
   * trades has no cross-rate at all, and its meme-pool swaps get dropped for
   * want of a dollar price. SLEEPY is exactly that case.
   */
  initSqrtPriceX96: string;
  initBlock: number;
}

export interface TokenPoolsResult {
  pools: TokenPool[];
  unreadable: string[];
}

const metaCache = new Map<string, { symbol: string; decimals: number }>();

async function tokenMeta(address: Address): Promise<{ symbol: string; decimals: number }> {
  const key = address.toLowerCase();
  const hit = metaCache.get(key);
  if (hit) return hit;
  const pc = publicClient();
  const [symbol, decimals] = await Promise.all([
    withRetry(
      () => pc.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }),
      `symbol(${address})`,
    ) as Promise<string>,
    withRetry(
      () => pc.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }),
      `decimals(${address})`,
    ) as Promise<number>,
  ]);
  const meta = { symbol, decimals: Number(decimals) };
  metaCache.set(key, meta);
  return meta;
}

/**
 * Both pools for one token.
 *
 * `memePoolId` comes from the caller because it is already on the curve struct
 * every caller has read; passing it avoids a second `curves()` round trip.
 */
export async function poolsForToken(args: {
  launcher: Address;
  underlying: `0x${string}`;
  memePoolId: `0x${string}`;
}): Promise<TokenPoolsResult> {
  const pc = publicClient();
  const unreadable: string[] = [];

  let quotePoolId: `0x${string}` = ZERO_ID;
  try {
    quotePoolId = (await withRetry(
      () =>
        pc.readContract({
          address: args.launcher,
          abi: CURVEFUNDER_ABI,
          functionName: "stockPoolOf",
          args: [args.underlying],
        }),
      "stockPoolOf",
    )) as `0x${string}`;
  } catch (e) {
    unreadable.push(`stockPoolOf: ${message(e)}`);
  }

  const wanted: Array<{ kind: TokenPool["kind"]; id: `0x${string}` }> = [];
  if (args.memePoolId && args.memePoolId !== ZERO_ID) {
    wanted.push({ kind: "meme", id: args.memePoolId });
  }
  if (quotePoolId && quotePoolId !== ZERO_ID) {
    wanted.push({ kind: "quote", id: quotePoolId });
  }
  if (!wanted.length) return { pools: [], unreadable };

  const poolManager = await resolve("V4_POOL_MANAGER").catch(() => null);
  if (!poolManager) {
    unreadable.push("no V4_POOL_MANAGER in the registry");
    return { pools: [], unreadable };
  }

  const usdg = await resolve("USDG").catch(() => null);
  const head = await pc.getBlockNumber();

  // One filter for both ids: `id` is indexed, so the node does the matching.
  // Not annotated with an explicit type: viem infers `args` from the event, and
  // writing the type out by hand throws that inference away and leaves `args`
  // as an unknown property, which is how an ABI-typed log turns into a cast.
  const logs = await withRetry(
    () =>
      pc.getLogs({
        address: poolManager,
        event: V4_INITIALIZE_EVENT,
        args: { id: wanted.map((w) => w.id) },
        fromBlock: 0n,
        toBlock: head,
      }),
    "Initialize logs",
  )
    .catch((e) => {
      unreadable.push(`Initialize logs: ${message(e)}`);
      return null;
    });
  if (!logs) return { pools: [], unreadable };

  const pools: TokenPool[] = [];
  for (const { kind, id } of wanted) {
    const log = logs.find(
      (l) => (l.args as { id?: string }).id?.toLowerCase() === id.toLowerCase(),
    );
    if (!log) {
      unreadable.push(`${kind} pool ${short(id)} has no Initialize log`);
      continue;
    }
    const a = log.args as {
      currency0?: Address;
      currency1?: Address;
      fee?: number;
      tickSpacing?: number;
      hooks?: Address;
      sqrtPriceX96?: bigint;
    };
    if (!a.currency0 || !a.currency1) {
      unreadable.push(`${kind} pool ${short(id)} Initialize carried no currencies`);
      continue;
    }
    try {
      const [m0, m1] = await Promise.all([tokenMeta(a.currency0), tokenMeta(a.currency1)]);
      pools.push({
        kind,
        poolId: id,
        currency0: a.currency0,
        currency1: a.currency1,
        fee: Number(a.fee ?? 0),
        tickSpacing: Number(a.tickSpacing ?? 0),
        hooks: a.hooks ?? zeroAddress,
        decimals0: m0.decimals,
        decimals1: m1.decimals,
        symbol0: m0.symbol,
        symbol1: m1.symbol,
        initSqrtPriceX96: String(a.sqrtPriceX96 ?? 0n),
        initBlock: Number(log.blockNumber ?? 0n),
        usdgSide: !usdg
          ? null
          : a.currency0.toLowerCase() === usdg.toLowerCase()
            ? 0
            : a.currency1.toLowerCase() === usdg.toLowerCase()
              ? 1
              : null,
      });
    } catch (e) {
      unreadable.push(`${kind} pool ${short(id)} currencies: ${message(e)}`);
    }
  }

  return { pools, unreadable };
}

function short(v: string): string {
  return `${v.slice(0, 10)}...`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] : String(e);
}
