/**
 * The LP surface: the real Uniswap v4 pools a graduated launch leaves behind.
 *
 * This is the part of the product a liquidity page is actually about. A launch
 * raises USDG on a bonding curve, and at graduation it opens TWO v4 pools:
 *
 *     MEME --(meme pool)--> fSHARE --(quote pool)--> USDG
 *
 * Both are ordinary public pools with no hook, so anyone can mint and burn
 * their own position and collect the fee. That is the "add and remove as you
 * please" venue. It is NOT the Desk vault, which is a single shared balance
 * sheet with pro-rata shares and a one day exit, and it is not the funding
 * queue.
 *
 * Two things about this data are worth knowing before trusting it:
 *
 * 1. A PoolKey cannot be read back from a pool id, because the id is its hash.
 *    The Graduator takes fee and tickSpacing as arguments rather than fixing
 *    them, so they cannot simply be assumed either. Every key here is therefore
 *    RECONSTRUCTED from candidates and then VERIFIED by hashing it back to the
 *    id the chain gave us. A key that does not hash correctly is dropped rather
 *    than guessed at, because an unverified key would send a deposit into the
 *    wrong pool.
 *
 * 2. Launches are spread across more than one launcher. The registry points at
 *    the current CurveFunder only, and three of the four mainnet launches live
 *    on a superseded one that nothing points at any more. Those pools still
 *    hold real liquidity, so enumeration spans both.
 */

import { encodeAbiParameters, keccak256, type Address } from "viem";
import { publicClient, ERC20_ABI } from "./chain";
import { resolve, tryResolve } from "./registry";
import { activeNetwork } from "./networks";

/// Launchers that no registry key points at any more but whose graduated pools
/// still hold liquidity. These are HISTORICAL and immutable: a superseded
/// contract never changes address, so listing it here is not the build-time
/// address pinning this repo forbids, which is about pinning things that can
/// still move. Anything current resolves from the Registry.
const RETIRED_LAUNCHERS: Record<number, Address[]> = {
  4663: ["0xD55E56BeaC9527Ace861a788BaAE82e5347c6495"],
};

/// Canonical v4 StateView per chain, used only when the Registry has no
/// V4_STATE_VIEW key, which today it does not on either network. This is the
/// same treatment `contracts/src/v4/V4Addresses.sol` already gives the
/// PoolManager: chain infrastructure that we did not deploy and cannot rotate,
/// with the Registry still winning if somebody ever registers it.
const CANONICAL_STATE_VIEW: Record<number, Address> = {
  4663: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
};

async function stateViewAddress(): Promise<Address | null> {
  return (await tryResolve("V4_STATE_VIEW")) ?? CANONICAL_STATE_VIEW[activeNetwork().chainId] ?? null;
}

const CURVE_FUNDER_ABI = [
  { type: "function", name: "tokenCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allTokens", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "sharePoolFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "sharePoolSpacing", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  { type: "function", name: "stockPoolOf", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  {
    type: "function",
    name: "curves",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "underlying", type: "bytes32" },
          { name: "creator", type: "address" },
          { name: "share", type: "address" },
          { name: "vQuote", type: "uint128" },
          { name: "rQuote", type: "uint128" },
          { name: "vToken", type: "uint128" },
          { name: "sold", type: "uint128" },
          { name: "fShareReserve", type: "uint128" },
          { name: "gradTarget", type: "uint128" },
          { name: "graduated", type: "bool" },
          { name: "poolId", type: "bytes32" },
        ],
      },
    ],
  },
] as const;

const STATE_VIEW_ABI = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }],
  },
  { type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint128" }] },
  {
    type: "function",
    name: "getTickLiquidity",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "int24" }],
    outputs: [{ type: "uint128" }, { type: "int128" }],
  },
] as const;

export interface DepthBar {
  tick: number;
  /** Liquidity active across [tick, tick + spacing). */
  liquidity: string;
  /** Which side of the current price this sits on. */
  side: "bid" | "ask";
}

/**
 * The pool's real liquidity distribution, for the depth chart.
 *
 * A v4 pool stores liquidityNet at each initialised tick, not a level per
 * range, so the profile has to be walked out from the middle: start at the
 * active liquidity the pool reports for the current tick, then add each net as
 * you step up, and subtract each net as you step down. That reconstruction is
 * what makes this an actual reading of the book rather than a shape drawn to
 * look like one.
 *
 * Reads only tick multiples of the spacing, because a position can only ever
 * start or end on one.
 */
export async function poolDepth(
  poolId: `0x${string}`,
  tickSpacing: number,
  currentTick: number,
  activeLiquidity: bigint,
  steps = 24,
): Promise<DepthBar[]> {
  const stateView = await stateViewAddress();
  if (!stateView) return [];
  const pc = publicClient();
  const base = Math.floor(currentTick / tickSpacing) * tickSpacing;

  const ticks: number[] = [];
  for (let i = -steps; i <= steps; i++) ticks.push(base + i * tickSpacing);

  // A failed tick read must NOT be treated as "no liquidity here". Zeroing a
  // failure produces a perfectly flat profile that looks like a valid reading
  // of a pool with uniform depth, which is exactly what it did the first time:
  // 49 identical bars for a pool whose liquidity actually sits in one 600 tick
  // band. If a read fails the chart is wrong and has to say so.
  //
  // Read in small serial batches rather than firing every tick at once: a
  // public RPC throttles a 49-way parallel burst, and throttling was the
  // original cause of the failures being swallowed.
  const nets = new Map<number, bigint>();
  const failed: number[] = [];
  const BATCH = 8;
  for (let i = 0; i < ticks.length; i += BATCH) {
    const slice = ticks.slice(i, i + BATCH);
    const got = await Promise.all(
      slice.map(async (t) => {
        try {
          const [, net] = (await pc.readContract({
            address: stateView, abi: STATE_VIEW_ABI, functionName: "getTickLiquidity", args: [poolId, t],
          })) as [bigint, bigint];
          return [t, net] as const;
        } catch {
          return [t, null] as const;
        }
      }),
    );
    for (const [t, net] of got) {
      if (net === null) failed.push(t);
      else nets.set(t, net);
    }
  }
  // Any gap makes the reconstruction wrong from that tick outward, because the
  // walk accumulates. Better no chart than a confident flat one.
  if (failed.length > 0) throw new Error(`tick liquidity unreadable for ${failed.length} of ${ticks.length} ticks`);

  const bars: DepthBar[] = [];
  // upward from the active range: crossing a tick ADDS its net
  let l = activeLiquidity;
  for (let t = base; t <= base + steps * tickSpacing; t += tickSpacing) {
    if (t !== base) l += nets.get(t) ?? 0n;
    if (l < 0n) l = 0n;
    bars.push({ tick: t, liquidity: l.toString(), side: "ask" });
  }
  // downward: stepping below a tick REMOVES its net
  l = activeLiquidity;
  for (let t = base; t >= base - steps * tickSpacing; t -= tickSpacing) {
    if (t !== base) {
      l -= nets.get(t + tickSpacing) ?? 0n;
      if (l < 0n) l = 0n;
      bars.push({ tick: t, liquidity: l.toString(), side: "bid" });
    }
  }
  return bars.sort((a, b) => a.tick - b.tick);
}

export interface LpPool {
  poolId: `0x${string}`;
  /** meme = MEME/fSHARE, quote = fSHARE/USDG. The two hops of the price chain. */
  kind: "meme" | "quote";
  launch: { token: Address; symbol: string; launcher: Address; retired: boolean };
  /** Verified: this key hashes to poolId. Safe to build a position against. */
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  sqrtPriceX96: string;
  tick: number;
  /** Active liquidity at the current tick. NOT TVL: see the note in the route. */
  liquidity: string;
  lpFeeBps: number;
  /**
   * Which currency is USDG, or null on a pool that holds none.
   *
   * Never infer this from the index. Currencies are ordered by address, so USDG
   * is currency0 in some pools and currency1 in others, and a deposit form that
   * assumes token1 asks for the wrong asset half the time. It asked for fNTDO3
   * when it should have asked for USDG exactly once before this existed.
   */
  usdgSide: 0 | 1 | null;
}

/** poolId is keccak of the abi-encoded PoolKey, so a key can be checked. */
export function poolIdOf(k: LpPool["key"]): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Find the (fee, tickSpacing) that actually opened this pool by hashing
 * candidates until one matches. Returns null when none does, which is the
 * honest answer: better no row than a row pointing at the wrong pool.
 */
function verifyKey(a: Address, b: Address, poolId: `0x${string}`, preferred: Array<[number, number]>) {
  const [currency0, currency1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  const candidates: Array<[number, number]> = [
    ...preferred,
    [10_000, 200],
    [3_000, 60],
    [500, 10],
    [100, 1],
  ];
  for (const [fee, tickSpacing] of candidates) {
    const key = { currency0, currency1, fee, tickSpacing, hooks: ZERO };
    if (poolIdOf(key).toLowerCase() === poolId.toLowerCase()) return key;
  }
  return null;
}

async function launchers(): Promise<Array<{ address: Address; retired: boolean }>> {
  const out: Array<{ address: Address; retired: boolean }> = [];
  const current = await tryResolve("CURVE_FUNDER");
  if (current) out.push({ address: current, retired: false });
  for (const a of RETIRED_LAUNCHERS[activeNetwork().chainId] ?? []) {
    if (a.toLowerCase() !== current?.toLowerCase()) out.push({ address: a, retired: true });
  }
  return out;
}

/** Cheap ERC-20 identity, tolerant of a token that will not answer. */
async function meta(token: Address) {
  const pc = publicClient();
  const read = (functionName: string) =>
    pc.readContract({ address: token, abi: ERC20_ABI, functionName } as never);
  const [symbol, decimals] = await Promise.all([
    read("symbol").catch(() => "?") as Promise<string>,
    read("decimals").catch(() => 18) as Promise<number>,
  ]);
  return { symbol: String(symbol), decimals: Number(decimals) };
}

export interface LpPoolsResult {
  pools: LpPool[];
  /** Pools the chain named but that could not be described, and why. */
  unreadable: Array<{ poolId: string; reason: string }>;
}

export async function lpPools(): Promise<LpPoolsResult> {
  const pc = publicClient();
  const pools: LpPool[] = [];
  const unreadable: LpPoolsResult["unreadable"] = [];

  const [stateView, usdg, listings] = await Promise.all([
    stateViewAddress(),
    resolve("USDG"),
    resolve("LISTINGS"),
  ]);
  if (!stateView) {
    unreadable.push({ poolId: "-", reason: "no V4_STATE_VIEW in the registry and no canonical one for this chain" });
    return { pools, unreadable };
  }

  for (const { address: cf, retired } of await launchers()) {
    let count = 0n;
    let preferred: Array<[number, number]> = [];
    try {
      const [n, fee, spacing] = await Promise.all([
        pc.readContract({ address: cf, abi: CURVE_FUNDER_ABI, functionName: "tokenCount" }) as Promise<bigint>,
        pc.readContract({ address: cf, abi: CURVE_FUNDER_ABI, functionName: "sharePoolFee" }) as Promise<number>,
        pc.readContract({ address: cf, abi: CURVE_FUNDER_ABI, functionName: "sharePoolSpacing" }) as Promise<number>,
      ]);
      count = n;
      preferred = [[Number(fee), Number(spacing)]];
    } catch {
      continue; // not a launcher on this chain
    }

    for (let i = 0n; i < count; i++) {
      let token: Address | null = null;
      try {
        token = (await pc.readContract({
          address: cf, abi: CURVE_FUNDER_ABI, functionName: "allTokens", args: [i],
        })) as Address;
        const curve = (await pc.readContract({
          address: cf, abi: CURVE_FUNDER_ABI, functionName: "curves", args: [token],
        })) as { share: Address; underlying: `0x${string}`; graduated: boolean; poolId: `0x${string}` };
        if (!curve.graduated) continue; // no pools until it graduates

        const quotePoolId = (await pc.readContract({
          address: cf, abi: CURVE_FUNDER_ABI, functionName: "stockPoolOf", args: [curve.underlying],
        })) as `0x${string}`;

        const [memeMeta, shareMeta, usdgMeta] = await Promise.all([
          meta(token), meta(curve.share), meta(usdg),
        ]);
        const launch = { token, symbol: memeMeta.symbol, launcher: cf, retired };

        for (const [kind, poolId, a, b, ma, mb] of [
          ["meme", curve.poolId, token, curve.share, memeMeta, shareMeta],
          ["quote", quotePoolId, curve.share, usdg, shareMeta, usdgMeta],
        ] as const) {
          if (!poolId || /^0x0+$/.test(poolId)) continue;
          const key = verifyKey(a, b, poolId, preferred);
          if (!key) {
            unreadable.push({ poolId, reason: "no (fee, tickSpacing) reproduces this pool id" });
            continue;
          }
          const [slot0, liquidity] = await Promise.all([
            pc.readContract({ address: stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] }) as Promise<
              [bigint, number, number, number]
            >,
            pc.readContract({ address: stateView, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [poolId] }) as Promise<bigint>,
          ]);
          const zeroIsA = key.currency0.toLowerCase() === a.toLowerCase();
          const usdgLower = usdg.toLowerCase();
          const usdgSide: 0 | 1 | null =
            key.currency0.toLowerCase() === usdgLower ? 0
            : key.currency1.toLowerCase() === usdgLower ? 1
            : null;
          pools.push({
            poolId,
            kind,
            launch,
            key,
            symbol0: zeroIsA ? ma.symbol : mb.symbol,
            symbol1: zeroIsA ? mb.symbol : ma.symbol,
            decimals0: zeroIsA ? ma.decimals : mb.decimals,
            decimals1: zeroIsA ? mb.decimals : ma.decimals,
            sqrtPriceX96: slot0[0].toString(),
            tick: Number(slot0[1]),
            liquidity: liquidity.toString(),
            lpFeeBps: key.fee / 100,
            usdgSide,
          });
        }
      } catch (e) {
        unreadable.push({
          poolId: token ?? `index ${i}`,
          reason: (e as { shortMessage?: string; message?: string })?.shortMessage
            ?? (e as Error)?.message ?? String(e),
        });
      }
    }
  }
  listings; // reserved: per-market naming once the board groups by stock
  return { pools, unreadable };
}
