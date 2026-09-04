/**
 * DeskHook: the sole-LP Uniswap v4 dealer pools.
 *
 * A DeskHook pool is not a two-sided AMM pool and must not be read like one.
 * The hook is the ONLY liquidity provider: it holds an ask ladder of stock
 * above the oracle and a bid ladder of USDG below it, and its inventory lives
 * inside the PoolManager as ERC-6909 claims. So "TVL" here is the desk's own
 * book marked at the oracle, not deposits from the public, and there is
 * nothing for an outside LP to deposit into. Anything this file returns is a
 * chain read; nothing is modelled.
 *
 * Absent DESK_HOOK in the registry means the feature is simply off, and every
 * export here returns empty rather than throwing, so a deployment without the
 * hook renders no section at all.
 *
 * Owned by session 01LqS83j (the desk-acquire lane in ~/float). The DeskHook
 * ABI lives here rather than in abi.ts because the hook is not part of the
 * main-line deploy yet.
 */

import type { Address } from "viem";
import { publicClient } from "./chain";
import { LISTINGS_ABI } from "./abi";
import { tryResolve, resolve } from "./registry";

export const DESK_HOOK_ABI = [{"type":"function","name":"acq","inputs":[{"name":"id","type":"bytes32","internalType":"PoolId"}],"outputs":[{"name":"","type":"tuple","internalType":"struct DeskHook.Acquire","components":[{"name":"enabled","type":"bool","internalType":"bool"},{"name":"deskLinked","type":"bool","internalType":"bool"},{"name":"targetAssetBps","type":"uint16","internalType":"uint16"},{"name":"minEdgeTicks","type":"uint16","internalType":"uint16"},{"name":"maxScarcityTicks","type":"uint16","internalType":"uint16"},{"name":"bandBps","type":"uint16","internalType":"uint16"},{"name":"maxCostBps","type":"uint16","internalType":"uint16"},{"name":"cooldown","type":"uint32","internalType":"uint32"},{"name":"maxTradeQuote","type":"uint128","internalType":"uint128"}]}],"stateMutability":"view"},{"type":"function","name":"acquireNeeded","inputs":[{"name":"id","type":"bytes32","internalType":"PoolId"}],"outputs":[{"name":"needed","type":"bool","internalType":"bool"},{"name":"isBuy","type":"bool","internalType":"bool"},{"name":"sizeQuote","type":"uint256","internalType":"uint256"},{"name":"shortfallBps","type":"uint16","internalType":"uint16"},{"name":"replacementTicks","type":"uint16","internalType":"uint16"}],"stateMutability":"view"},{"type":"function","name":"book","inputs":[{"name":"id","type":"bytes32","internalType":"PoolId"}],"outputs":[{"name":"","type":"tuple","internalType":"struct DeskHook.Book","components":[{"name":"assetTotal","type":"uint128","internalType":"uint128"},{"name":"quoteTotal","type":"uint128","internalType":"uint128"},{"name":"assetDeployed","type":"uint128","internalType":"uint128"},{"name":"quoteDeployed","type":"uint128","internalType":"uint128"},{"name":"anchorTick","type":"int24","internalType":"int24"},{"name":"askEdge","type":"int24","internalType":"int24"},{"name":"bidEdge","type":"int24","internalType":"int24"},{"name":"night","type":"bool","internalType":"bool"},{"name":"built","type":"bool","internalType":"bool"},{"name":"volumeQuote","type":"uint128","internalType":"uint128"},{"name":"protocolOwed","type":"uint128","internalType":"uint128"},{"name":"nodeOwed","type":"uint128","internalType":"uint128"},{"name":"feeAssetLifetime","type":"uint128","internalType":"uint128"},{"name":"feeQuoteLifetime","type":"uint128","internalType":"uint128"},{"name":"askScarcityTicks","type":"uint16","internalType":"uint16"},{"name":"bidScarcityTicks","type":"uint16","internalType":"uint16"},{"name":"lastAcquireAt","type":"uint64","internalType":"uint64"},{"name":"acquiredQuoteLifetime","type":"uint128","internalType":"uint128"},{"name":"acquiredAssetLifetime","type":"uint128","internalType":"uint128"},{"name":"unwoundAssetLifetime","type":"uint128","internalType":"uint128"},{"name":"unwoundQuoteLifetime","type":"uint128","internalType":"uint128"}]}],"stateMutability":"view"},{"type":"function","name":"cfg","inputs":[{"name":"id","type":"bytes32","internalType":"PoolId"}],"outputs":[{"name":"","type":"tuple","internalType":"struct DeskHook.Cfg","components":[{"name":"assetId","type":"bytes32","internalType":"bytes32"},{"name":"assetIsToken0","type":"bool","internalType":"bool"},{"name":"set","type":"bool","internalType":"bool"},{"name":"paused","type":"bool","internalType":"bool"},{"name":"priceScale","type":"uint256","internalType":"uint256"},{"name":"band","type":"tuple","internalType":"struct DeskHook.Band","components":[{"name":"dayHalfSpreadTicks","type":"uint16","internalType":"uint16"},{"name":"nightHalfSpreadTicks","type":"uint16","internalType":"uint16"},{"name":"rungWidthTicks","type":"uint16","internalType":"uint16"},{"name":"rungs","type":"uint8","internalType":"uint8"},{"name":"recenterTicks","type":"uint16","internalType":"uint16"},{"name":"pullbackTicks","type":"uint16","internalType":"uint16"},{"name":"dayFeePips","type":"uint24","internalType":"uint24"},{"name":"nightFeePips","type":"uint24","internalType":"uint24"},{"name":"skewPipsPerTick","type":"uint16","internalType":"uint16"},{"name":"nightCapAsset","type":"uint128","internalType":"uint128"},{"name":"nightCapQuote","type":"uint128","internalType":"uint128"},{"name":"maxStaleness","type":"uint32","internalType":"uint32"}]}]}],"stateMutability":"view"},{"type":"function","name":"equityQuote","inputs":[{"name":"id","type":"bytes32","internalType":"PoolId"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"key","inputs":[{"name":"id","type":"bytes32","internalType":"PoolId"}],"outputs":[{"name":"","type":"tuple","internalType":"struct PoolKey","components":[{"name":"currency0","type":"address","internalType":"Currency"},{"name":"currency1","type":"address","internalType":"Currency"},{"name":"fee","type":"uint24","internalType":"uint24"},{"name":"tickSpacing","type":"int24","internalType":"int24"},{"name":"hooks","type":"address","internalType":"contract IHooks"}]}],"stateMutability":"view"},{"type":"function","name":"ladder","inputs":[{"name":"id","type":"bytes32","internalType":"PoolId"}],"outputs":[{"name":"","type":"tuple[]","internalType":"struct DeskHook.Rung[]","components":[{"name":"lower","type":"int24","internalType":"int24"},{"name":"upper","type":"int24","internalType":"int24"},{"name":"liquidity","type":"uint128","internalType":"uint128"},{"name":"salt","type":"bytes32","internalType":"bytes32"}]}],"stateMutability":"view"},{"type":"function","name":"oracleTick","inputs":[{"name":"id","type":"bytes32","internalType":"PoolId"}],"outputs":[{"name":"","type":"int24","internalType":"int24"}],"stateMutability":"view"},{"type":"function","name":"poolTick","inputs":[{"name":"id","type":"bytes32","internalType":"PoolId"}],"outputs":[{"name":"tick","type":"int24","internalType":"int24"}],"stateMutability":"view"},{"type":"function","name":"scarcity","inputs":[{"name":"id","type":"bytes32","internalType":"PoolId"}],"outputs":[{"name":"askAdd","type":"uint16","internalType":"uint16"},{"name":"bidAdd","type":"uint16","internalType":"uint16"}],"stateMutability":"view"},{"type":"function","name":"shortfall","inputs":[{"name":"id","type":"bytes32","internalType":"PoolId"}],"outputs":[{"name":"assetShort","type":"bool","internalType":"bool"},{"name":"shortfallBps","type":"uint16","internalType":"uint16"},{"name":"gapQuote","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"event","name":"PoolOpened","inputs":[{"name":"id","type":"bytes32","indexed":true,"internalType":"PoolId"},{"name":"assetId","type":"bytes32","indexed":true,"internalType":"bytes32"},{"name":"assetIsToken0","type":"bool","indexed":false,"internalType":"bool"},{"name":"tick","type":"int24","indexed":false,"internalType":"int24"}],"anonymous":false}] as const;

/** Ticks are basis points to within rounding; the hook's own unit. */
const TICK_BPS = 1;

export interface HookPool {
  poolId: `0x${string}`;
  assetId: `0x${string}`;
  ticker: string;
  displayName: string;
  asset: Address;
  assetIsToken0: boolean;

  /** The desk's own book, marked at the oracle, in quote units. */
  tvlQuote: string;
  inventoryAsset: string;
  inventoryQuote: string;
  deployedAsset: string;
  deployedQuote: string;

  /**
   * Lifetime, NOT a 24h window: the hook counts volume in its own book and
   * nothing indexes its Fill events yet. Labelled honestly so no column can
   * quietly present it as a daily number.
   */
  volumeQuoteLifetime: string;
  feeQuoteLifetime: string;
  feeAssetLifetime: string;
  protocolOwed: string;
  nodeOwed: string;

  /** What the pool is quoting right now, in bps either side of the oracle. */
  askSpreadBps: number;
  bidSpreadBps: number;
  /** The acquire lane's scarcity premium on each side, in ticks. */
  scarcityAskTicks: number;
  scarcityBidTicks: number;
  /** What replacing a share at the Desk costs right now, in ticks. */
  replacementTicks: number;

  /** How far the book is from its target inventory split. */
  assetShort: boolean;
  shortfallBps: number;
  gapQuote: string;
  acquireArmed: boolean;
  acquireNeeded: boolean;

  night: boolean;
  built: boolean;
  paused: boolean;
  anchorTick: number;
  poolTick: number;
  oracleTick: number;
  rungs: number;
}

const POOL_OPENED_EVENT = {
  type: "event",
  name: "PoolOpened",
  inputs: [
    { name: "id", type: "bytes32", indexed: true, internalType: "PoolId" },
    { name: "assetId", type: "bytes32", indexed: true, internalType: "bytes32" },
    { name: "assetIsToken0", type: "bool", indexed: false, internalType: "bool" },
    { name: "tick", type: "int24", indexed: false, internalType: "int24" },
  ],
} as const;

/** The hook address, or null when this deployment has no DeskHook. */
export async function deskHookAddress(): Promise<Address | null> {
  return tryResolve("DESK_HOOK");
}

/**
 * Which pools the hook has opened. Read from PoolOpened logs rather than an
 * on-chain array: the hook is already past the EIP-170 runtime limit, so it
 * does not get to carry an enumeration it does not need on chain.
 */
async function openedPools(hook: Address) {
  const logs = await publicClient().getLogs({
    address: hook,
    event: POOL_OPENED_EVENT,
    fromBlock: 0n,
    toBlock: "latest",
  });
  const seen = new Map<string, { poolId: `0x${string}`; assetId: `0x${string}` }>();
  for (const l of logs) {
    const poolId = l.args.id as `0x${string}` | undefined;
    const assetId = l.args.assetId as `0x${string}` | undefined;
    if (poolId && assetId) seen.set(poolId, { poolId, assetId });
  }
  return [...seen.values()];
}

/** A view that may revert (stale oracle, halted listing) resolved to a default. */
async function soft<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

/** A pool the hook says it opened but that could not be read, and why. */
export interface UnreadablePool {
  poolId: `0x${string}`;
  assetId: `0x${string}`;
  reason: string;
}

export interface HookPoolsResult {
  pools: HookPool[];
  /**
   * Dropping a bad row keeps the board up, but a row that vanishes silently
   * is indistinguishable from a pool that never existed, so the reader is told
   * what is missing instead of quietly being shown less than the truth.
   */
  unreadable: UnreadablePool[];
}

export async function hookPools(): Promise<HookPoolsResult> {
  const hook = await deskHookAddress();
  if (!hook) return { pools: [], unreadable: [] };

  const pc = publicClient();
  const listings = await resolve("LISTINGS");
  const opened = await openedPools(hook);
  if (opened.length === 0) return { pools: [], unreadable: [] };

  const read = (functionName: string, args: unknown[]) =>
    pc.readContract({ address: hook, abi: DESK_HOOK_ABI, functionName, args } as never);

  // One unreadable pool must not take the board down with it, and a pool the
  // hook does not actually know must not render as a row of zeros. Solidity
  // mappings answer an unknown key with an all-zero struct rather than
  // reverting, so `set` is the only thing that distinguishes "this pool exists"
  // from "you asked about nothing": treat a zero struct as absent, not as data.
  const rows = await Promise.all(
    opened.map(async ({ poolId, assetId }): Promise<HookPool | UnreadablePool> => {
      try {
      const [book, cfg, acq, listing] = await Promise.all([
        read("book", [poolId]) as Promise<Record<string, bigint | number | boolean>>,
        read("cfg", [poolId]) as Promise<Record<string, unknown>>,
        read("acq", [poolId]) as Promise<Record<string, unknown>>,
        pc.readContract({
          address: listings,
          abi: LISTINGS_ABI,
          functionName: "get",
          args: [assetId],
        }) as Promise<Record<string, unknown>>,
      ]);

      // These four touch the oracle or the Desk and can legitimately revert on
      // a stale feed or a halted listing. A pool that cannot quote is still a
      // pool worth showing, so they degrade rather than fail the row.
      const [tvl, shortfall, scarcity, needed, poolTick, oracleTick, ladder] = await Promise.all([
        soft(read("equityQuote", [poolId]) as Promise<bigint>, 0n),
        soft(read("shortfall", [poolId]) as Promise<[boolean, number, bigint]>, [false, 0, 0n] as [boolean, number, bigint]),
        soft(read("scarcity", [poolId]) as Promise<[number, number]>, [0, 0] as [number, number]),
        soft(
          read("acquireNeeded", [poolId]) as Promise<[boolean, boolean, bigint, number, number]>,
          [false, false, 0n, 0, 0] as [boolean, boolean, bigint, number, number],
        ),
        soft(read("poolTick", [poolId]) as Promise<number>, 0),
        soft(read("oracleTick", [poolId]) as Promise<number>, 0),
        soft(read("ladder", [poolId]) as Promise<unknown[]>, []),
      ]);

      // a poolId from an older hook at this registry key: absent, not broken
      if (!cfg.set) return { poolId, assetId, reason: "not known to this hook" };
      const band = cfg.band as Record<string, number>;
      const night = Boolean(book.night);
      const halfTicks = night ? band.nightHalfSpreadTicks : band.dayHalfSpreadTicks;
      const [scarcityAsk, scarcityBid] = scarcity;

      return {
        poolId,
        assetId,
        ticker: String(listing.ticker ?? ""),
        displayName: String(listing.displayName ?? ""),
        asset: listing.token as Address,
        assetIsToken0: Boolean(cfg.assetIsToken0),

        tvlQuote: tvl.toString(),
        inventoryAsset: String(book.assetTotal),
        inventoryQuote: String(book.quoteTotal),
        deployedAsset: String(book.assetDeployed),
        deployedQuote: String(book.quoteDeployed),

        volumeQuoteLifetime: String(book.volumeQuote),
        feeQuoteLifetime: String(book.feeQuoteLifetime),
        feeAssetLifetime: String(book.feeAssetLifetime),
        protocolOwed: String(book.protocolOwed),
        nodeOwed: String(book.nodeOwed),

        askSpreadBps: (halfTicks + scarcityAsk) * TICK_BPS,
        bidSpreadBps: (halfTicks + scarcityBid) * TICK_BPS,
        scarcityAskTicks: scarcityAsk,
        scarcityBidTicks: scarcityBid,
        replacementTicks: needed[4],

        assetShort: shortfall[0],
        shortfallBps: shortfall[1],
        gapQuote: shortfall[2].toString(),
        acquireArmed: Boolean((acq as { enabled?: boolean }).enabled),
        acquireNeeded: needed[0],

        night,
        built: Boolean(book.built),
        paused: Boolean(cfg.paused),
        anchorTick: Number(book.anchorTick),
        poolTick: Number(poolTick),
        oracleTick: Number(oracleTick),
        rungs: ladder.length,
      } satisfies HookPool;
      } catch (e) {
        // a delisted asset, a replaced Listings, an RPC that dropped the call:
        // keep the rest of the board, and say which one went and why
        return { poolId, assetId, reason: reasonOf(e) };
      }
    }),
  );
  return {
    pools: rows.filter((r): r is HookPool => "ticker" in r),
    unreadable: rows.filter((r): r is UnreadablePool => !("ticker" in r)),
  };
}

/**
 * The useful part of a viem revert is not on the first line, so taking
 * `message` alone captures the preamble and throws away the signature while
 * looking like it kept it. Prefer the named error, then the short message.
 */
function reasonOf(e: unknown): string {
  const err = e as { shortMessage?: string; metaMessages?: string[]; message?: string };
  const named = err?.metaMessages?.find((m) => /Error:/.test(m))?.replace(/^\s*Error:\s*/, "");
  return (named ?? err?.shortMessage ?? err?.message ?? String(e)).replace(/\s+/g, " ").trim().slice(0, 200);
}
