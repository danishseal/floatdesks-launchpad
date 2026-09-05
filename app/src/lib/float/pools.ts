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

/// The contracts that seed a pool when a launch graduates. Their positions ARE
/// the liquidity a launch generated, as distinct from anything a person later
/// added, which is the number worth showing separately.
const SEEDERS: Record<number, Address[]> = {
  4663: ["0xDA87e3EBD03Ba51748bF5056A5cc204078083087"], // RangeSeeder
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
    name: "getPositionInfo",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "address" }, { type: "int24" }, { type: "int24" }, { type: "bytes32" }],
    outputs: [{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }],
  },
  {
    type: "function",
    name: "getTickLiquidity",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "int24" }],
    outputs: [{ type: "uint128" }, { type: "int128" }],
  },
  {
    type: "function",
    name: "getTickBitmap",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "int16" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * Did this fail because the chain said no, or because we could not ask?
 *
 * viem wraps the transport error as a `cause`, so the useful name can sit a
 * couple of levels down. Matching on names rather than message text on
 * purpose: a substring test proves containment, not identity, and the prose
 * of these messages is not an interface.
 */
const TRANSPORT_ERRORS = new Set([
  "HttpRequestError",
  "RpcRequestError",
  "TimeoutError",
  "UnknownRpcError",
  "InternalRpcError",
  "LimitExceededRpcError",
  "SocketClosedError",
  "WebSocketRequestError",
]);

function isTransportFailure(e: unknown): boolean {
  for (let x = e as { name?: string; cause?: unknown } | undefined; x; x = x.cause as typeof x) {
    if (typeof x.name === "string" && TRANSPORT_ERRORS.has(x.name)) return true;
  }
  return false;
}

/**
 * The tick range the pool's ACTIVE liquidity actually spans.
 *
 * Active liquidity is constant between INITIALISED ticks, and those are
 * multiples of the spacing but not adjacent ones. Valuing it over a single
 * spacing therefore describes a narrower band than the one the liquidity
 * occupies, and understates what is quoting: on the DOZE quote pool the active
 * L runs 237000 to 237600, three spacings, and pricing it over one reported
 * 5.23 USDG where the pool's own seeded position holds 19.84.
 *
 * The bitmap answers it in one read almost always: a word covers 256 spacings
 * each way, which at a 200 spacing is about 167 percent of price.
 */
export async function activeRange(
  poolId: `0x${string}`,
  tick: number,
  spacing: number,
): Promise<
  | { kind: "found"; lower: number; upper: number }
  | { kind: "none-nearby" }
  | { kind: "error"; message: string }
> {
  const stateView = await stateViewAddress();
  if (!stateView) return { kind: "error", message: "no state view for this chain" };
  const pc = publicClient();

  const word = async (wordPos: number) =>
    (await pc.readContract({
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: "getTickBitmap",
      args: [poolId, wordPos],
    })) as bigint;

  const compressed = Math.floor(tick / spacing);
  const wordPos = Math.floor(compressed / 256);
  const bitPos = compressed - wordPos * 256;

  const highestBelow = (w: bigint, upto: number) => {
    for (let b = upto; b >= 0; b--) if ((w >> BigInt(b)) & 1n) return b;
    return -1;
  };
  const lowestAbove = (w: bigint, from: number) => {
    for (let b = from; b < 256; b++) if ((w >> BigInt(b)) & 1n) return b;
    return -1;
  };

  try {
    const here = await word(wordPos);

    let lowBit = highestBelow(here, bitPos);
    let lowWord = wordPos;
    if (lowBit < 0) {
      lowWord = wordPos - 1;
      lowBit = highestBelow(await word(lowWord), 255);
    }

    let upBit = lowestAbove(here, bitPos + 1);
    let upWord = wordPos;
    if (upBit < 0) {
      upWord = wordPos + 1;
      upBit = lowestAbove(await word(upWord), 0);
    }

    // Outside the two words searched, say so rather than guess a bound. This
    // is a different fact from a failed read and must not share its answer:
    // returning one null for both was the same mute correctness this function
    // exists to fix, reappearing inside the fix.
    // Distinct from a failed read, and the distinction is load bearing: it
    // means liquidity is CONSTANT across a very wide band, which makes a
    // narrow depth figure exact rather than unmeasurable. Collapsing the two
    // into one answer was the same mute correctness this function fixes,
    // reappearing inside the fix.
    if (lowBit < 0 || upBit < 0) return { kind: "none-nearby" };

    return {
      kind: "found",
      lower: (lowWord * 256 + lowBit) * spacing,
      upper: (upWord * 256 + upBit) * spacing,
    };
  } catch (e) {
    // Unmeasured, not zero, and it says which. The caller renders the
    // difference and an operator can see the reason.
    const m = e instanceof Error ? `${e.name}: ${e.message.split("\n")[0]}` : String(e);
    return { kind: "error", message: m.slice(0, 140) };
  }
}

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
    } catch (e) {
      // "Not a launcher on this chain" and "the RPC would not answer" are
      // different facts, and this used to collapse them into a silent skip.
      // The cost was measured, not theorised: with both launchers throttled,
      // lpPools() returned 0 pools and 0 unreadable, the route answered 200
      // with empty arrays, and the section removed itself from the page. About
      // one load in three showed no liquidity pools at all, with nothing said
      // anywhere. A feature that is absent a third of the time and silent about
      // it is worse than one that is down.
      //
      // Classify on viem's error NAMES walking the cause chain, not on the
      // prose of a message. A contract that is not a launcher reverts; a
      // transport failure is a different type, and only that one is worth
      // reporting.
      if (isTransportFailure(e)) {
        unreadable.push({
          poolId: cf,
          reason: `launcher ${cf.slice(0, 10)} did not answer, so its pools are unlisted rather than absent`,
        });
      }
      continue; // genuinely not a launcher on this chain
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


/**
 * The token amounts a liquidity figure actually represents.
 *
 * `liquidity` (L) is not an amount of anything. It lives in sqrt-price space,
 * and printing it raw is badly misleading: the DOZE quote pool reads as
 * 104,591,698,281,867, which looks like 104 trillion of something on a protocol
 * whose entire history is about $418. The same position is 19.51 USDG and
 * 0.0506 fNTDO3. Always convert before showing it to anyone.
 */
export function amountsFor(
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
  currentTick: number,
): { amount0: number; amount1: number } {
  const L = Number(liquidity);
  const sa = Math.pow(1.0001, tickLower / 2);
  const sb = Math.pow(1.0001, tickUpper / 2);
  const sp = Math.pow(1.0001, currentTick / 2);
  if (currentTick <= tickLower) return { amount0: (L * (sb - sa)) / (sa * sb), amount1: 0 };
  if (currentTick >= tickUpper) return { amount0: 0, amount1: L * (sb - sa) };
  return { amount0: (L * (sb - sp)) / (sp * sb), amount1: L * (sp - sa) };
}

export interface SeededLiquidity {
  /** Liquidity in this pool that a launch put there, by owner. */
  byOwner: Array<{ owner: Address; label: string; liquidity: string; ranges: number }>;
  total: string;
  /** What that liquidity is, in tokens, at the current price. */
  amount0: number;
  amount1: number;
}

/**
 * How much of a pool's liquidity came from the launch itself.
 *
 * A graduated launch seeds its own pools: the Graduator opens them and the
 * RangeSeeder concentrates the quote side at the peg. Those positions are the
 * protocol's, not a depositor's, and telling the two apart is the difference
 * between "this pool is deep" and "this pool is deep because we put it there".
 *
 * Read by asking the pool what each seeding contract owns across the ranges the
 * depth profile already found, rather than by scanning events, because a public
 * RPC will refuse a full-history log scan and a position read will not.
 */
export async function launchSeeded(
  poolId: `0x${string}`,
  depth: DepthBar[],
  tickSpacing: number,
  currentTick: number,
): Promise<SeededLiquidity> {
  const stateView = await stateViewAddress();
  const empty: SeededLiquidity = { byOwner: [], total: "0", amount0: 0, amount1: 0 };
  if (!stateView || depth.length === 0) return empty;

  const owners: Array<{ owner: Address; label: string }> = [];
  const grad = await tryResolve("GRADUATOR" as never).catch(() => null);
  if (grad) owners.push({ owner: grad as Address, label: "Graduator" });
  for (const a of SEEDERS[activeNetwork().chainId] ?? []) owners.push({ owner: a, label: "RangeSeeder" });
  if (owners.length === 0) return empty;

  // contiguous runs of equal liquidity are the position boundaries
  const runs: Array<[number, number]> = [];
  let start = depth[0].tick;
  for (let i = 1; i <= depth.length; i++) {
    const changed = i === depth.length || depth[i].liquidity !== depth[i - 1].liquidity;
    if (changed) {
      runs.push([start, depth[i - 1].tick + tickSpacing]);
      if (i < depth.length) start = depth[i].tick;
    }
  }

  // The REAL current tick, not the first ask bar's tick. Deriving it from the
  // bars puts the price exactly on a range boundary, and amountsFor then
  // reports the position as entirely one token: the seeded band came out as
  // 22.08 USDG and zero fNTDO3 when it is really 19.64 and 0.0509.
  const pc = publicClient();
  const out: SeededLiquidity["byOwner"] = [];
  let total = 0n;
  let amount0 = 0;
  let amount1 = 0;
  for (const { owner, label } of owners) {
    let sum = 0n;
    let ranges = 0;
    for (const [lo, hi] of runs) {
      try {
        const [liq] = (await pc.readContract({
          address: stateView,
          abi: STATE_VIEW_ABI,
          functionName: "getPositionInfo",
          args: [poolId, owner, lo, hi, "0x0000000000000000000000000000000000000000000000000000000000000000"],
        })) as [bigint, bigint, bigint];
        if (liq > 0n) {
          sum += liq;
          ranges += 1;
          const a = amountsFor(liq, lo, hi, currentTick);
          amount0 += a.amount0;
          amount1 += a.amount1;
        }
      } catch {
        // one unreadable range is not a reason to misreport the rest; it can
        // only understate, which is the safe direction for this number
      }
    }
    if (sum > 0n) {
      out.push({ owner, label, liquidity: sum.toString(), ranges });
      total += sum;
    }
  }
  return { byOwner: out, total: total.toString(), amount0, amount1 };
}
