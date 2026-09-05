/**
 * Providing and withdrawing liquidity on the real v4 pools.
 *
 * You put USDG (or the other side) into a pool, you earn the fee on everything
 * that trades through it, and you take it out when you want. No lockup, no
 * epoch, no shares in someone else's balance sheet. That is the difference
 * between this and the Desk vault.
 *
 * v4 does not take tokens directly. A mint goes through the PositionManager,
 * which pulls funds via Permit2, so a deposit is three approvals deep:
 *
 *     token.approve(permit2)  ->  permit2.approve(token, positionManager)
 *         ->  positionManager.modifyLiquidities([MINT_POSITION, SETTLE_PAIR])
 *
 * Both are live on Robinhood Chain: Permit2 at its canonical address and the
 * PositionManager at the one `V4Addresses.sol` names. Every address here still
 * prefers the Registry and only falls back to canonical chain infrastructure,
 * the same way the StateView does in pools.ts.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodePacked,
  maxUint160,
  maxUint256,
  parseEventLogs,
  type Address,
} from "viem";
import {
  publicClient,
  walletClient,
  waitFor,
  balanceOf,
  getListing,
  listingIds,
  deskPreviewBuy,
  deskPreviewSell,
  deskBuyRefusal,
  tx,
  ERC20_ABI,
} from "./chain";
import { resolve, tryResolve } from "./registry";
import { activeNetwork } from "./networks";
import type { LpPool } from "./pools";

/** Canonical across every chain Permit2 has been deployed to. */
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

const CANONICAL_POSITION_MANAGER: Record<number, Address> = {
  4663: "0x58daec3116aae6D93017bAAea7749052E8a04fA7",
};

/** v4-periphery Actions. Only the ones this file uses. */
const MINT_POSITION = 0x02;
const DECREASE_LIQUIDITY = 0x01;
const SETTLE_PAIR = 0x0d;
const TAKE_PAIR = 0x11;

const PERMIT2_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint160" }, { type: "uint48" }],
    outputs: [],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "address" }],
    outputs: [{ type: "uint160" }, { type: "uint48" }, { type: "uint48" }],
  },
] as const;

const POSM_ABI = [
  {
    type: "function",
    name: "modifyLiquidities",
    stateMutability: "payable",
    inputs: [{ type: "bytes" }, { type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getPositionLiquidity",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint128" }],
  },
  // The periphery's own errors, so a failed mint decodes to a name instead of
  // four anonymous bytes. Without these viem reports "reverted with the
  // following reason:" and then nothing useful.
  {
    type: "error",
    name: "MaximumAmountExceeded",
    inputs: [{ name: "maximumAmount", type: "uint128" }, { name: "amount", type: "uint128" }],
  },
  {
    type: "error",
    name: "MinimumAmountInsufficient",
    inputs: [{ name: "minimumAmount", type: "uint128" }, { name: "amount", type: "uint128" }],
  },
  { type: "error", name: "DeadlinePassed", inputs: [{ name: "deadline", type: "uint256" }] },
  { type: "error", name: "NotApproved", inputs: [{ name: "caller", type: "address" }] },
  { type: "error", name: "DeltaNotPositive", inputs: [{ name: "currency", type: "address" }] },
  { type: "error", name: "DeltaNotNegative", inputs: [{ name: "currency", type: "address" }] },
  { type: "error", name: "UnsupportedAction", inputs: [{ name: "action", type: "uint256" }] },
  { type: "error", name: "InputLengthMismatch", inputs: [] },
  { type: "error", name: "ContractLocked", inputs: [] },
] as const;

export async function positionManager(): Promise<Address | null> {
  return (
    (await tryResolve("V4_POSITION_MANAGER" as never).catch(() => null)) ??
    CANONICAL_POSITION_MANAGER[activeNetwork().chainId] ??
    null
  );
}

function keyTuple(k: LpPool["key"]) {
  return {
    currency0: k.currency0 as Address,
    currency1: k.currency1 as Address,
    fee: k.fee,
    tickSpacing: k.tickSpacing,
    hooks: k.hooks as Address,
  };
}

const POOL_KEY_ABI = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

/**
 * Make sure the PositionManager can pull `amount` of `token` on the account's
 * behalf. Two hops, and both are idempotent, so an account that has provided
 * liquidity before pays for neither.
 *
 * Each approval is WAITED FOR before the next read, and waited for with
 * waitFor, which throws on a reverted receipt. Firing the ERC-20 approve and
 * immediately simulating the mint against `latest` reads state that does not
 * contain the approval yet, and the mint then simulates as an allowance
 * failure that has nothing to do with the position being built.
 *
 * Returns the hashes it actually sent, so a caller assembling a multi-step
 * flow can report which approvals it paid for.
 */
async function ensurePermit2(
  account: Address, token: Address, spender: Address, amount: bigint,
): Promise<`0x${string}`[]> {
  const pc = publicClient();
  const wc = await walletClient();
  const sent: `0x${string}`[] = [];

  const erc20Allowance = (await pc.readContract({
    address: token, abi: ERC20_ABI, functionName: "allowance", args: [account, PERMIT2],
  })) as bigint;
  if (erc20Allowance < amount) {
    const { request } = await pc.simulateContract({
      address: token, abi: ERC20_ABI, functionName: "approve", args: [PERMIT2, maxUint256], account,
    });
    const hash = await wc.writeContract({ ...request, account } as never);
    await waitFor(hash);
    sent.push(hash);
  }

  const [allowed, expiration] = (await pc.readContract({
    address: PERMIT2, abi: PERMIT2_ABI, functionName: "allowance", args: [account, token, spender],
  })) as [bigint, number, number];
  const now = Math.floor(Date.now() / 1000);
  if (allowed < amount || expiration < now + 60) {
    const { request } = await pc.simulateContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: "approve",
      // uint48 expiration; 30 days is the usual periphery default
      args: [token, spender, maxUint160, now + 30 * 24 * 3600],
      account,
    });
    const hash = await wc.writeContract({ ...request, account } as never);
    await waitFor(hash);
    sent.push(hash);
  }
  return sent;
}

export interface AddLiquidityArgs {
  account: Address;
  pool: LpPool;
  tickLower: number;
  tickUpper: number;
  /** Liquidity units to mint. Callers size this from the amounts they hold. */
  liquidity: bigint;
  /** Caps on what may be pulled. Protects against a price move mid-transaction. */
  amount0Max: bigint;
  amount1Max: bigint;
}

export async function addLiquidity(a: AddLiquidityArgs): Promise<`0x${string}`> {
  return (await addLiquidityDetailed(a)).hash;
}

/**
 * The same mint, but reporting the approvals it had to send on the way.
 *
 * A mint is not one transaction. It is up to two approvals per side plus the
 * modifyLiquidities call, and a caller that wants to tell a user what it did
 * needs the hashes of all of them, not only the last.
 */
export async function addLiquidityDetailed(
  a: AddLiquidityArgs,
): Promise<{ approvals: `0x${string}`[]; hash: `0x${string}` }> {
  const posm = await positionManager();
  if (!posm) throw new Error("no v4 PositionManager for this network");

  // Approvals only for the sides that will actually move.
  const approvals: `0x${string}`[] = [];
  if (a.amount0Max > 0n) {
    approvals.push(...await ensurePermit2(a.account, a.pool.key.currency0 as Address, posm, a.amount0Max));
  }
  if (a.amount1Max > 0n) {
    approvals.push(...await ensurePermit2(a.account, a.pool.key.currency1 as Address, posm, a.amount1Max));
  }

  const actions = encodePacked(["uint8", "uint8"], [MINT_POSITION, SETTLE_PAIR]);
  const mintParams = encodeAbiParameters(
    [
      POOL_KEY_ABI,
      { type: "int24" }, { type: "int24" }, { type: "uint256" },
      { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" },
    ],
    [
      keyTuple(a.pool.key), a.tickLower, a.tickUpper, a.liquidity,
      a.amount0Max, a.amount1Max, a.account, "0x",
    ],
  );
  const settleParams = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }],
    [a.pool.key.currency0 as Address, a.pool.key.currency1 as Address],
  );
  const unlockData = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [mintParams, settleParams]]);

  const pc = publicClient();
  const wc = await walletClient();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const { request } = await pc.simulateContract({
    address: posm, abi: POSM_ABI, functionName: "modifyLiquidities", args: [unlockData, deadline], account: a.account,
  });
  const hash = await wc.writeContract({ ...request, account: a.account } as never);
  return { approvals, hash };
}

export interface RemoveLiquidityArgs {
  account: Address;
  pool: LpPool;
  tokenId: bigint;
  /** How much of the position to pull. Use its full liquidity to exit. */
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
}

export async function removeLiquidity(a: RemoveLiquidityArgs): Promise<`0x${string}`> {
  const posm = await positionManager();
  if (!posm) throw new Error("no v4 PositionManager for this network");

  const actions = encodePacked(["uint8", "uint8"], [DECREASE_LIQUIDITY, TAKE_PAIR]);
  const decreaseParams = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
    [a.tokenId, a.liquidity, a.amount0Min, a.amount1Min, "0x"],
  );
  const takeParams = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }],
    [a.pool.key.currency0 as Address, a.pool.key.currency1 as Address, a.account],
  );
  const unlockData = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [decreaseParams, takeParams]],
  );

  const pc = publicClient();
  const wc = await walletClient();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const { request } = await pc.simulateContract({
    address: posm, abi: POSM_ABI, functionName: "modifyLiquidities", args: [unlockData, deadline], account: a.account,
  });
  return wc.writeContract({ ...request, account: a.account } as never);
}

/** Liquidity currently in a position, so a full exit can be sized exactly. */
export async function positionLiquidity(tokenId: bigint): Promise<bigint> {
  const posm = await positionManager();
  if (!posm) return 0n;
  return (await publicClient().readContract({
    address: posm, abi: POSM_ABI, functionName: "getPositionLiquidity", args: [tokenId],
  })) as bigint;
}

const POSM_NFT_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "id", type: "uint256", indexed: true },
    ],
  },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "getPoolAndPositionInfo",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { type: "uint256" },
    ],
  },
] as const;

export interface OwnedPosition {
  tokenId: string;
  liquidity: string;
  tickLower: number;
  tickUpper: number;
}

/** int24 out of the packed PositionInfo word. */
function toInt24(v: bigint): number {
  const n = Number(v & 0xffffffn);
  return n >= 0x800000 ? n - 0x1000000 : n;
}

/**
 * The caller's own positions in one pool.
 *
 * The PositionManager is an ERC-721 with no per-owner enumeration, so the only
 * way to find someone's positions is their Transfer log history. A token can
 * have moved on since, so ownership is re-checked on chain rather than trusted
 * from the log, and a position drained to zero liquidity is dropped: it still
 * exists as an NFT but there is nothing in it to withdraw.
 */
export async function positionsIn(pool: LpPool, owner: Address): Promise<OwnedPosition[]> {
  const posm = await positionManager();
  if (!posm) return [];
  const pc = publicClient();

  const logs = await pc.getLogs({
    address: posm,
    event: POSM_NFT_ABI[0],
    args: { to: owner },
    fromBlock: 0n,
    toBlock: "latest",
  });
  const ids = [...new Set(logs.map((l) => (l.args as { id?: bigint }).id).filter((v): v is bigint => v !== undefined))];
  if (ids.length === 0) return [];

  const out: OwnedPosition[] = [];
  for (const tokenId of ids) {
    try {
      const [holder, poolAndInfo, liquidity] = await Promise.all([
        pc.readContract({ address: posm, abi: POSM_NFT_ABI, functionName: "ownerOf", args: [tokenId] }) as Promise<Address>,
        pc.readContract({ address: posm, abi: POSM_NFT_ABI, functionName: "getPoolAndPositionInfo", args: [tokenId] }) as Promise<
          [{ currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }, bigint]
        >,
        positionLiquidity(tokenId),
      ]);
      if (holder.toLowerCase() !== owner.toLowerCase()) continue;
      if (liquidity === 0n) continue;
      const [k, info] = poolAndInfo;
      const samePool =
        k.currency0.toLowerCase() === pool.key.currency0.toLowerCase() &&
        k.currency1.toLowerCase() === pool.key.currency1.toLowerCase() &&
        Number(k.fee) === pool.key.fee &&
        Number(k.tickSpacing) === pool.key.tickSpacing &&
        k.hooks.toLowerCase() === pool.key.hooks.toLowerCase();
      if (!samePool) continue;
      out.push({
        tokenId: tokenId.toString(),
        liquidity: liquidity.toString(),
        tickLower: toInt24(info >> 8n),
        tickUpper: toInt24(info >> 32n),
      });
    } catch {
      // a burnt token reverts on ownerOf; it is simply not a position any more
    }
  }
  return out;
}

// --------------------------------------------------- single sided USDG zap

/**
 * Putting USDG alone into a quote pool.
 *
 * A v4 position wants BOTH sides of the pair. Somebody holding only USDG who
 * wants to LP the fSHARE/USDG hop therefore has to get hold of fSHARE first,
 * and where that fSHARE comes from matters: buying it out of the pool moves the
 * price you are about to quote against, and minting it from nothing is not
 * something this protocol does. It comes from the DESK, which mints fSHARE
 * against USDG paid into the dealer vault at the oracle price. The share the
 * position holds is backed the same way every other fSHARE in existence is.
 *
 * THIS IS NOT ONE TRANSACTION AND IT IS NOT ATOMIC. In the worst case it is
 * five: a USDG approval for the Desk, the Desk buy, a USDG approval for
 * Permit2, a Permit2 approval for the PositionManager, the same pair again for
 * the fSHARE, and the mint. Each lands in its own block and anyone can trade
 * between them.
 *
 * The hazard that creates is specific and worth naming. Between the Desk buy
 * and the mint:
 *
 *   - the POOL price can move, so the ratio the split was derived at is no
 *     longer the ratio the mint needs, and the mint either consumes less of
 *     one side than planned or asks for more than the account holds;
 *   - the Desk price can move, so the buy returns fewer fSHARE than the plan
 *     was built on.
 *
 * What this code does about it:
 *
 *   1. The Desk leg carries a real slippage bound (`minSharesOut`), so it
 *      reverts rather than filling at a price the caller did not agree to.
 *   2. The mint is sized from the fSHARE that ACTUALLY ARRIVED, measured as a
 *      balance delta, never from the preview.
 *   3. The mint's amountMax caps are set to what the account holds, so a pool
 *      price move makes it revert instead of quietly pulling more.
 *   4. When the mint fails anyway the result reports `strandedShares`: the
 *      fSHARE this flow bought and could not deposit. That is a real position
 *      the caller now holds and did not ask for, and `unwindZapShares` sells
 *      it straight back to the Desk. A UI must surface it. Reporting only a
 *      transaction hash here would hide it completely.
 *
 * None of that is theoretical. `scripts/fork-zap.ts` reproduces it against a
 * fork of 4663: a $20 buy through the MARIO quote pool moved it from tick
 * 233619 to 222802, a $5 zap handed the pre-move snapshot then bought
 * 0.03895713 fNINTENDO at the Desk and failed the mint with
 * MaximumAmountExceeded(2734428, 5817396), and unwindZapShares sold that
 * fSHARE back for $2.164078.
 */

const Q96 = 1n << 96n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;

/**
 * Uniswap's TickMath.getSqrtRatioAtTick, in bigint.
 *
 * The float form (1.0001 ** (tick / 2)) is what pools.ts uses for DISPLAY and
 * it is fine there. It is not fine here: these numbers size a transfer, and a
 * relative error of 1e-16 against a Q96 fixed point is the difference between
 * a mint that settles and one that asks for a wei the account does not have.
 */
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`tick ${tick} out of range`);
  }
  const abs = BigInt(Math.abs(tick));
  let r = (abs & 0x1n) !== 0n
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  const mul = (m: bigint) => { r = (r * m) >> 128n; };
  if (abs & 0x2n) mul(0xfff97272373d413259a46990580e213an);
  if (abs & 0x4n) mul(0xfff2e50f5f656932ef12357cf3c7fdccn);
  if (abs & 0x8n) mul(0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if (abs & 0x10n) mul(0xffcb9843d60f6159c9db58835c926644n);
  if (abs & 0x20n) mul(0xff973b41fa98c081472e6896dfb254c0n);
  if (abs & 0x40n) mul(0xff2ea16466c96a3843ec78b326b52861n);
  if (abs & 0x80n) mul(0xfe5dee046a99a2a811c461f1969c3053n);
  if (abs & 0x100n) mul(0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if (abs & 0x200n) mul(0xf987a7253ac413176f2b074cf7815e54n);
  if (abs & 0x400n) mul(0xf3392b0822b70005940c7a398e4b70f3n);
  if (abs & 0x800n) mul(0xe7159475a2c29b7443b29c7fa6e889d9n);
  if (abs & 0x1000n) mul(0xd097f3bdfd2022b8845ad8f792aa5825n);
  if (abs & 0x2000n) mul(0xa9f746462d870fdf8a65dc1f90e061e5n);
  if (abs & 0x4000n) mul(0x70d869a156d2a1b890bb3df62baf32f7n);
  if (abs & 0x8000n) mul(0x31be135f97d08fd981231505542fcfa6n);
  if (abs & 0x10000n) mul(0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if (abs & 0x20000n) mul(0x5d6af8dedb81196699c329225ee604n);
  if (abs & 0x40000n) mul(0x2216e584f5fa1ea926041bedfe98n);
  if (abs & 0x80000n) mul(0x48a170391f7dc42444e8fa2n);
  if (tick > 0) r = maxUint256 / r;
  // Q128.128 down to Q64.96, rounding up, exactly as TickMath does.
  return (r >> 32n) + (r % (1n << 32n) === 0n ? 0n : 1n);
}

function order(a: bigint, b: bigint): [bigint, bigint] {
  return a > b ? [b, a] : [a, b];
}

/** LiquidityAmounts.getLiquidityForAmount0. */
function liquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  const [a, b] = order(sqrtA, sqrtB);
  if (b === a) return 0n;
  return (amount0 * ((a * b) / Q96)) / (b - a);
}

/** LiquidityAmounts.getLiquidityForAmount1. */
function liquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  const [a, b] = order(sqrtA, sqrtB);
  if (b === a) return 0n;
  return (amount1 * Q96) / (b - a);
}

/**
 * The liquidity a pair of balances actually supports in a range. The binding
 * side is whichever runs out first, which is exactly why a zap has to derive
 * its split rather than assume one: pick the split wrong and half of what the
 * user brought sits idle in their wallet.
 */
export function liquidityForAmounts(
  sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, amount0: bigint, amount1: bigint,
): bigint {
  const [a, b] = order(sqrtA, sqrtB);
  if (sqrtP <= a) return liquidityForAmount0(a, b, amount0);
  if (sqrtP < b) {
    const l0 = liquidityForAmount0(sqrtP, b, amount0);
    const l1 = liquidityForAmount1(a, sqrtP, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return liquidityForAmount1(a, b, amount1);
}

/** The exact bigint form of what pools.ts `amountsFor` computes in floats. */
export function amountsForLiquidity(
  sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  const [a, b] = order(sqrtA, sqrtB);
  const amt0 = (lo: bigint, hi: bigint) => ((liquidity << 96n) * (hi - lo)) / hi / lo;
  const amt1 = (lo: bigint, hi: bigint) => (liquidity * (hi - lo)) / Q96;
  if (sqrtP <= a) return { amount0: amt0(a, b), amount1: 0n };
  if (sqrtP < b) return { amount0: amt0(sqrtP, b), amount1: amt1(a, sqrtP) };
  return { amount0: 0n, amount1: amt1(a, b) };
}

/**
 * A tick range centred on the pool's current tick, snapped to its spacing.
 *
 * Offered because the range is what decides the split, so a caller that has
 * not thought about it should at least get an aligned one. `spacings` is the
 * half width in tick spacings.
 */
export function centredRange(pool: LpPool, spacings: number): { tickLower: number; tickUpper: number } {
  const s = pool.key.tickSpacing;
  const base = Math.floor(pool.tick / s) * s;
  const half = Math.max(1, Math.floor(spacings)) * s;
  return {
    tickLower: Math.max(Math.ceil(MIN_TICK / s) * s, base - half),
    tickUpper: Math.min(Math.floor(MAX_TICK / s) * s, base + half),
  };
}

/**
 * The listing behind a pool's fSHARE, resolved on chain.
 *
 * A pool key only carries token addresses, and the Desk is addressed by
 * assetId, so something has to relate the two. Listings is that relation: it
 * holds `token` per assetId and is the contract that minted the fSHARE in the
 * first place. Walk it and match.
 *
 * Note which hash is which, because the two live side by side in this repo and
 * are not interchangeable. REGISTRY keys are an ASCII name right padded to 32
 * bytes. ASSET IDs are keccak256 of the ticker (Listings.list does
 * `assetId = keccak256(bytes(ticker))`). Reading the id back off the listing
 * rather than recomputing it means a renamed or migrated market still resolves.
 */
const fshareListingCache = new Map<string, { assetId: `0x${string}`; ticker: string }>();

export async function listingForFshare(
  token: Address,
): Promise<{ assetId: `0x${string}`; ticker: string } | null> {
  const cacheKey = `${activeNetwork().chainId}:${token.toLowerCase()}`;
  const hit = fshareListingCache.get(cacheKey);
  if (hit) return hit;

  const ids = await listingIds();
  for (const assetId of ids) {
    try {
      const l = await getListing(assetId);
      if (l.token.toLowerCase() === token.toLowerCase()) {
        const found = { assetId: l.assetId, ticker: l.ticker };
        fshareListingCache.set(cacheKey, found);
        return found;
      }
    } catch {
      // one unreadable listing is not a reason to give up on the rest
    }
  }
  return null;
}

/**
 * Name the Desk's own reverts.
 *
 * `previewBuy` is not a dry run of `buy`. It reverts on Halted, because
 * `_market` does, but it applies NEITHER the settle-only rule NOR the OI cap,
 * so it happily quotes trades the Desk then refuses. `deskBuyRefusal` in
 * chain.ts checks all three ahead of time; this is the second net, for the
 * case where the state changes between that check and the block the buy lands
 * in, and it turns a bare four byte selector into the sentence a user needs.
 */
function revertedError(e: unknown): ContractFunctionRevertedError | null {
  if (!(e instanceof BaseError)) return null;
  const found = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return found instanceof ContractFunctionRevertedError ? found : null;
}

/**
 * Everything a failed call actually said.
 *
 * `message.split("\n")[0]` was throwing away the only informative line: viem
 * puts "The contract function X reverted with the following reason:" first and
 * the reason on the NEXT line, so the first line alone reads as a mystery. A
 * fork whose upstream has aged out of the RPC's state window reports itself
 * here too ("metadata is not found"), and that is not a revert at all.
 */
function callFailure(e: unknown): string {
  const reverted = revertedError(e);
  if (reverted?.data?.errorName) {
    const args = reverted.data.args?.map(String).join(", ");
    return args ? `${reverted.data.errorName}(${args})` : reverted.data.errorName;
  }
  const err = e as { shortMessage?: string; details?: string; message?: string };
  return [err?.shortMessage, err?.details].filter(Boolean).join(" ")
    || err?.message?.split("\n").slice(0, 4).join(" ")
    || String(e);
}

function mintFailure(e: unknown): string {
  const name = revertedError(e)?.data?.errorName;
  switch (name) {
    case "MaximumAmountExceeded":
      return `the pool wanted more than the zap agreed to pay: ${callFailure(e)}. `
        + "The pool price moved between the split and the mint.";
    case "DeadlinePassed":
      return "the mint sat unconfirmed past its deadline. Nothing was minted.";
    case "NotApproved":
      return "the PositionManager is not approved to pull one of the two tokens.";
    case "ContractLocked":
      return "the PoolManager was already unlocked by something else in this call.";
    default:
      return callFailure(e);
  }
}

function deskFailure(e: unknown): string {
  const name = revertedError(e)?.data?.errorName;
  switch (name) {
    case "SettleOnly":
      return "the Desk is settle-only on this market, so it will not mint new fSHARE right now. It can still be sold back.";
    case "OiCapExceeded":
      return "this buy would push the market past its open-interest cap. Try a smaller amount or a range that needs less fSHARE.";
    case "Halted":
      return "this market is halted, so the Desk is not trading it at all.";
    case "Slippage":
      return "the Desk price moved past the slippage bound before the buy landed. Nothing was spent.";
    case "UnderReserved":
      return "secure mint is on and this market is not fully reserved, so the Desk will not issue more fSHARE.";
    case "InsufficientLiquidity":
      return "the Desk vault does not have the USDG to stand behind this trade.";
    case "ZeroAmount":
      return "the amount routed to the Desk rounds to zero. Zap a larger amount.";
    default:
      return callFailure(e);
  }
}

export interface ZapStep {
  name: "resolve" | "plan" | "desk-buy" | "mint";
  ok: boolean;
  detail: string;
  /** Every transaction this step sent, in order. There can be more than one. */
  hashes: `0x${string}`[];
}

export interface ZapPlan {
  usdg: Address;
  fshare: Address;
  /** Which currency of the pair is USDG. Read, never inferred from the index. */
  usdgSide: 0 | 1;
  assetId: `0x${string}`;
  ticker: string;
  tickLower: number;
  tickUpper: number;
  /** The price the split was derived against. */
  sqrtPriceX96: bigint;
  tick: number;
  /** USDG that buys fSHARE at the Desk. */
  usdgToDesk: bigint;
  /** USDG that goes into the position as itself. */
  usdgToPool: bigint;
  /** usdgToDesk / usdgIn. 0 or 1 for a one sided range, and never assumed. */
  deskFraction: number;
  /** What the Desk says that buy is worth, and the floor put on it. */
  previewShares: bigint;
  minSharesOut: bigint;
  /** The position this would mint if nothing moved. */
  expectedLiquidity: bigint;
  expectedAmount0: bigint;
  expectedAmount1: bigint;
  /** Non-null when the Desk would refuse the buy, in words. */
  deskRefusal: string | null;
}

export interface ZapResult {
  ok: boolean;
  plan: ZapPlan | null;
  steps: ZapStep[];
  failedAt: ZapStep["name"] | null;
  error: string | null;
  /** Measured as a balance delta, not taken from the preview. */
  deskSharesBought: bigint;
  usdgSpent: bigint;
  position: {
    tokenId: string;
    liquidity: bigint;
    amount0: bigint;
    amount1: bigint;
  } | null;
  /**
   * fSHARE this flow bought and did not deposit.
   *
   * Read it together with `ok`. On a FAILED zap it is the whole hazard of
   * doing this in several transactions: the Desk leg landed, the mint did not,
   * and the account is now holding an fSHARE position it did not ask for.
   * `unwindZapShares` sells it back. On a SUCCESSFUL zap it should be zero or
   * near it, because the split is biased to make the fSHARE side bind and land
   * the leftover in USDG instead; anything more than dust here on a successful
   * zap means that bias was not enough and is worth surfacing.
   */
  strandedShares: bigint;
  balances: {
    before: { usdg: bigint; fshare: bigint };
    after: { usdg: bigint; fshare: bigint };
  };
}

export interface ZapArgs {
  account: Address;
  /** A quote hop pool (fSHARE/USDG). `usdgSide` must not be null. */
  pool: LpPool;
  /** Raw USDG units the account is putting in. */
  usdgIn: bigint;
  tickLower: number;
  tickUpper: number;
  /**
   * Bound on the Desk fill AND on the mint. Defaults to 100 (1%).
   *
   * It genuinely applies to both now. It was documented as covering the mint
   * while being read once, for the Desk floor, so a caller asking for 5% of
   * headroom on the position got one wei of it.
   */
  slippageBps?: number;
}

/**
 * Work out the split without sending anything.
 *
 * The ratio is INVERTED out of the position maths, not assumed. For a range
 * around spot the two sides are worth roughly the same and the split lands
 * near half, but that is a consequence, never an input: a range entirely on
 * one side of the current price needs one token and none of the other, and
 * this returns deskFraction 0 or 1 accordingly.
 *
 * Per unit of liquidity a range needs a fixed amount of each token, call them
 * aU (USDG) and aS (fSHARE). The Desk turns USDG into fSHARE at some rate r,
 * so splitting `usdgIn` into a Desk part D and a pool part P has to satisfy
 *
 *     P / (D * r) = aU / aS      with  P = usdgIn - D
 *     =>  D = usdgIn * aS / (r * aU + aS)
 *
 * r is not quite constant: the Desk's impact term grows with the resulting
 * skew, so a bigger buy prices slightly worse. The rate is therefore re-priced
 * against the size the previous pass produced, twice, which is enough to
 * settle it at these sizes.
 */
export async function planZapUsdg(a: ZapArgs): Promise<ZapPlan> {
  const { pool, usdgIn } = a;
  if (usdgIn <= 0n) throw new Error("nothing to zap");
  if (pool.usdgSide === null) throw new Error(`pool ${pool.poolId.slice(0, 10)} holds no USDG`);
  const s = pool.key.tickSpacing;
  if (a.tickLower % s !== 0 || a.tickUpper % s !== 0) {
    throw new Error(`ticks must be multiples of this pool's spacing (${s})`);
  }
  if (a.tickLower >= a.tickUpper) throw new Error("tickLower must be below tickUpper");

  const usdgSide = pool.usdgSide;
  const usdg = (usdgSide === 0 ? pool.key.currency0 : pool.key.currency1) as Address;
  const fshare = (usdgSide === 0 ? pool.key.currency1 : pool.key.currency0) as Address;

  const registryUsdg = await resolve("USDG");
  if (registryUsdg.toLowerCase() !== usdg.toLowerCase()) {
    throw new Error("the pool's USDG side is not the registry's USDG");
  }
  const listing = await listingForFshare(fshare);
  if (!listing) throw new Error(`no listing relates ${fshare} to an assetId`);

  const sqrtP = BigInt(pool.sqrtPriceX96);
  const sqrtA = sqrtRatioAtTick(a.tickLower);
  const sqrtB = sqrtRatioAtTick(a.tickUpper);

  // Per unit of liquidity. A reference L large enough that neither leg rounds
  // to nothing; the ratio is what matters, not the magnitude.
  const L_REF = 1n << 96n;
  const ref = amountsForLiquidity(sqrtP, sqrtA, sqrtB, L_REF);
  const aU = Number(usdgSide === 0 ? ref.amount0 : ref.amount1);
  const aS = Number(usdgSide === 0 ? ref.amount1 : ref.amount0);

  let usdgToDesk: bigint;
  if (aS <= 0) {
    usdgToDesk = 0n; // range entirely on the USDG side of spot
  } else if (aU <= 0) {
    usdgToDesk = usdgIn; // range entirely on the fSHARE side of spot
  } else {
    let probe = usdgIn;
    usdgToDesk = usdgIn / 2n; // a starting point only, refined below
    for (let i = 0; i < 3; i++) {
      const [out] = await deskPreviewBuy(listing.assetId, probe);
      const rate = Number(out) / Number(probe); // fSHARE raw per USDG raw
      const d = (Number(usdgIn) * aS) / (rate * aU + aS);
      usdgToDesk = BigInt(Math.max(0, Math.min(Number(usdgIn), Math.floor(d))));
      if (usdgToDesk === 0n) break;
      probe = usdgToDesk;
    }
    // Deliberately buy a hair LESS fSHARE than the exact solve calls for.
    //
    // One side of the pair always binds and whatever is left of the other side
    // stays in the wallet. Which side that is, is this function's choice, and
    // the two leftovers are not equally harmless: USDG left over is the asset
    // the user brought, while fSHARE left over is a position they did not ask
    // for and now have to sell back. The exact solve carries about a hundredth
    // of a percent of error from the float ratio and the Desk's size-dependent
    // rate, measured on a mainnet fork, and it landed on the fSHARE side. Five
    // hundredths of a percent is comfortably more than that error, so the
    // fSHARE binds and the dust lands in USDG instead.
    usdgToDesk -= usdgToDesk / 2_000n;
  }
  const usdgToPool = usdgIn - usdgToDesk;

  const previewShares = usdgToDesk > 0n ? (await deskPreviewBuy(listing.assetId, usdgToDesk))[0] : 0n;
  const slippageBps = BigInt(a.slippageBps ?? 100);
  const minSharesOut = (previewShares * (10_000n - slippageBps)) / 10_000n;

  const amount0 = usdgSide === 0 ? usdgToPool : previewShares;
  const amount1 = usdgSide === 0 ? previewShares : usdgToPool;
  const expectedLiquidity = liquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1);
  const expected = amountsForLiquidity(sqrtP, sqrtA, sqrtB, expectedLiquidity);

  return {
    usdg,
    fshare,
    usdgSide,
    assetId: listing.assetId,
    ticker: listing.ticker,
    tickLower: a.tickLower,
    tickUpper: a.tickUpper,
    sqrtPriceX96: sqrtP,
    tick: pool.tick,
    usdgToDesk,
    usdgToPool,
    deskFraction: Number(usdgToDesk) / Number(usdgIn),
    previewShares,
    minSharesOut,
    expectedLiquidity,
    expectedAmount0: expected.amount0,
    expectedAmount1: expected.amount1,
    // previewBuy is not a dry run of buy, so ask the thing that mirrors buy's
    // own guards before spending anything.
    deskRefusal: usdgToDesk > 0n ? await deskBuyRefusal(listing.assetId, usdgToDesk) : null,
  };
}

/**
 * Do it. Several transactions, in this order:
 *
 *   1. USDG approval for the Desk, if the account has not given one
 *   2. Desk.buy, minting the fSHARE against USDG at the oracle price
 *   3. USDG and fSHARE approvals for Permit2 and the PositionManager
 *   4. PositionManager.modifyLiquidities, the mint
 *
 * Every receipt goes through waitFor, which THROWS on a reverted one. viem
 * resolves waitForTransactionReceipt on a revert, so awaiting a raw receipt
 * and carrying on treats "mined" as "worked" and the next step then builds on
 * a buy that never happened.
 *
 * Never throws for a chain-side refusal. The result carries what happened at
 * each step, including whatever fSHARE is left stranded if the mint fails
 * after the buy landed.
 */
export async function zapUsdgIntoQuotePool(a: ZapArgs): Promise<ZapResult> {
  const steps: ZapStep[] = [];
  const step = (name: ZapStep["name"], ok: boolean, detail: string, hashes: `0x${string}`[] = []) => {
    steps.push({ name, ok, detail, hashes });
    return steps[steps.length - 1];
  };
  const zero = { usdg: 0n, fshare: 0n };
  const fail = (
    at: ZapStep["name"], error: string, plan: ZapPlan | null, extra: Partial<ZapResult> = {},
  ): ZapResult => ({
    ok: false,
    plan,
    steps,
    failedAt: at,
    error,
    deskSharesBought: 0n,
    usdgSpent: 0n,
    position: null,
    strandedShares: 0n,
    balances: { before: zero, after: zero },
    ...extra,
  });

  let plan: ZapPlan;
  try {
    plan = await planZapUsdg(a);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    step("plan", false, msg);
    return fail("plan", msg, null);
  }
  step(
    "resolve",
    true,
    `${plan.ticker} assetId ${plan.assetId.slice(0, 10)}, fSHARE ${plan.fshare}, `
      + `USDG is currency${plan.usdgSide}`,
  );
  step(
    "plan",
    true,
    `${(plan.deskFraction * 100).toFixed(2)}% of the USDG buys fSHARE at the Desk `
      + `(${plan.usdgToDesk} of ${a.usdgIn} raw), ${plan.usdgToPool} goes in as USDG`,
  );

  const before = {
    usdg: await balanceOf(plan.usdg, a.account),
    fshare: await balanceOf(plan.fshare, a.account),
  };
  if (before.usdg < a.usdgIn) {
    const msg = `account holds ${before.usdg} raw USDG, needs ${a.usdgIn}`;
    step("desk-buy", false, msg);
    return fail("desk-buy", msg, plan, { balances: { before, after: before } });
  }

  // ------------------------------------------------------------ the Desk leg
  let bought = 0n;
  const deskHashes: `0x${string}`[] = [];
  if (plan.usdgToDesk > 0n) {
    if (plan.deskRefusal) {
      step("desk-buy", false, plan.deskRefusal);
      return fail("desk-buy", plan.deskRefusal, plan, { balances: { before, after: before } });
    }
    try {
      const hash = await tx.deskBuy(a.account, plan.assetId, plan.usdgToDesk, plan.minSharesOut);
      deskHashes.push(hash);
      await waitFor(hash);
    } catch (e) {
      const msg = deskFailure(e);
      step("desk-buy", false, msg, deskHashes);
      const after = {
        usdg: await balanceOf(plan.usdg, a.account),
        fshare: await balanceOf(plan.fshare, a.account),
      };
      return fail("desk-buy", msg, plan, { balances: { before, after } });
    }
    // What ARRIVED, not what was quoted. The mint is sized from this.
    bought = (await balanceOf(plan.fshare, a.account)) - before.fshare;
    step(
      "desk-buy",
      true,
      `bought ${bought} raw ${plan.ticker} fSHARE for ${plan.usdgToDesk} raw USDG `
        + `(quoted ${plan.previewShares}, floor ${plan.minSharesOut})`,
      deskHashes,
    );
  } else {
    step("desk-buy", true, "range needs no fSHARE, so the Desk is not touched", []);
  }

  // ------------------------------------------------------------- the mint
  // Sized from real balances. The pool price is read from the same snapshot
  // the split came from: a mint against a moved price needs a different ratio,
  // and the amountMax caps below make that revert rather than overpay.
  const sqrtA = sqrtRatioAtTick(plan.tickLower);
  const sqrtB = sqrtRatioAtTick(plan.tickUpper);
  const haveUsdg = plan.usdgToPool;
  const haveShare = bought;
  const amount0 = plan.usdgSide === 0 ? haveUsdg : haveShare;
  const amount1 = plan.usdgSide === 0 ? haveShare : haveUsdg;
  let liquidity = liquidityForAmounts(plan.sqrtPriceX96, sqrtA, sqrtB, amount0, amount1);
  // The pool rounds the amounts it pulls UP; this file rounds them down. On a
  // one sided $2 mint the difference was exactly one wei, and one wei more
  // than the account holds is a reverted transfer, so shave the liquidity
  // until both sides have a wei of headroom.
  let need = amountsForLiquidity(plan.sqrtPriceX96, sqrtA, sqrtB, liquidity);
  const headroom = () =>
    need.amount0 + (amount0 > 0n ? 1n : 0n) <= amount0
    && need.amount1 + (amount1 > 0n ? 1n : 0n) <= amount1;
  for (let i = 0; i < 8 && liquidity > 0n && !headroom(); i++) {
    liquidity = liquidity - liquidity / 1_000_000n - 1n;
    if (liquidity < 0n) liquidity = 0n;
    need = amountsForLiquidity(plan.sqrtPriceX96, sqrtA, sqrtB, liquidity);
  }
  if (liquidity <= 0n) {
    const msg = "the amounts on hand support no liquidity in this range";
    step("mint", false, msg);
    const after = {
      usdg: await balanceOf(plan.usdg, a.account),
      fshare: await balanceOf(plan.fshare, a.account),
    };
    return fail("mint", msg, plan, { deskSharesBought: bought, strandedShares: bought, balances: { before, after } });
  }
  // Cap at what is on hand, with real slippage headroom in between.
  //
  // This used to read `(want > have ? have : want) + 1`, and the loop above
  // guarantees want < have, so it always resolved to want + ONE WEI. The
  // comment said "cap at what is on hand" and the code capped at what was
  // wanted. Measured across all four live quote pools, that tolerated a price
  // move of about 3e-16 percent: any trade landing between the plan and the
  // mint reverted it, with the Desk's fSHARE already bought and stranded. One
  // tick is 0.01 percent, so the bound was roughly twelve orders of magnitude
  // tighter than the smallest move the pool can make.
  //
  // The app's own add form uses want * 1.01 for exactly this. Use the caller's
  // slippage instead of a constant, so the number they pass is the number that
  // applies, and still never exceed the balance: a mint cannot pull more than
  // the account chose to commit.
  const slip = BigInt(a.slippageBps ?? 100);
  const cap = (want: bigint, have: bigint) => {
    const room = want + (want * slip) / 10_000n + 1n;
    return room > have ? have : room;
  };
  const amount0Max = cap(need.amount0, amount0);
  const amount1Max = cap(need.amount1, amount1);

  try {
    const { approvals, hash } = await addLiquidityDetailed({
      account: a.account,
      pool: a.pool,
      tickLower: plan.tickLower,
      tickUpper: plan.tickUpper,
      liquidity,
      amount0Max,
      amount1Max,
    });
    const receipt = await waitFor(hash);
    // ERC-721 and ERC-20 Transfer hash to the same topic0, so filter on the
    // PositionManager's own address as well as on the mint's zero `from`.
    const posm = (await positionManager())?.toLowerCase();
    const minted = parseEventLogs({ abi: POSM_NFT_ABI, eventName: "Transfer", logs: receipt.logs })
      .find((l) =>
        l.address.toLowerCase() === posm
        && (l.args as { from?: Address }).from === "0x0000000000000000000000000000000000000000");
    const tokenId = (minted?.args as { id?: bigint } | undefined)?.id ?? null;
    const onChain = tokenId !== null ? await positionLiquidity(tokenId) : liquidity;

    const after = {
      usdg: await balanceOf(plan.usdg, a.account),
      fshare: await balanceOf(plan.fshare, a.account),
    };
    const stranded = after.fshare - before.fshare;
    // What the position swallowed, measured rather than predicted: total USDG
    // gone minus the part the Desk took, and the fSHARE bought that did not
    // come back out.
    const usdgIntoPool = before.usdg - after.usdg - plan.usdgToDesk;
    const shareIntoPool = bought - (stranded > 0n ? stranded : 0n);
    step(
      "mint",
      true,
      `minted position ${tokenId ?? "(id not in logs)"} with ${onChain} liquidity over `
        + `[${plan.tickLower}, ${plan.tickUpper}]`,
      [...approvals, hash],
    );
    return {
      ok: true,
      plan,
      steps,
      failedAt: null,
      error: null,
      deskSharesBought: bought,
      usdgSpent: before.usdg - after.usdg,
      position: {
        tokenId: tokenId === null ? "?" : tokenId.toString(),
        liquidity: onChain,
        amount0: plan.usdgSide === 0 ? usdgIntoPool : shareIntoPool,
        amount1: plan.usdgSide === 0 ? shareIntoPool : usdgIntoPool,
      },
      strandedShares: stranded > 0n ? stranded : 0n,
      balances: { before, after },
    };
  } catch (e) {
    const msg = mintFailure(e);
    step("mint", false, msg);
    const after = {
      usdg: await balanceOf(plan.usdg, a.account),
      fshare: await balanceOf(plan.fshare, a.account),
    };
    const stranded = after.fshare - before.fshare;
    return fail("mint", msg, plan, {
      deskSharesBought: bought,
      usdgSpent: before.usdg - after.usdg,
      strandedShares: stranded > 0n ? stranded : 0n,
      balances: { before, after },
    });
  }
}

/**
 * Sell fSHARE a failed zap left behind straight back to the Desk.
 *
 * The Desk always buys back, even settle-only, because a skew-reducing trade
 * is exactly what settle-only exists to keep open. This is the recovery path
 * for `strandedShares` and it is why the result reports that number at all.
 */
export async function unwindZapShares(
  account: Address, plan: ZapPlan, shares: bigint, slippageBps = 100,
): Promise<{ hash: `0x${string}`; usdgOut: bigint }> {
  const [quoted] = await deskPreviewSell(plan.assetId, shares);
  const floor = (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
  const usdgBefore = await balanceOf(plan.usdg, account);
  const hash = await tx.deskSell(account, plan.assetId, shares, floor, plan.fshare);
  await waitFor(hash);
  return { hash, usdgOut: (await balanceOf(plan.usdg, account)) - usdgBefore };
}
