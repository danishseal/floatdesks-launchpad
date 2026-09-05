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

import { encodeAbiParameters, encodePacked, maxUint160, maxUint256, type Address } from "viem";
import { publicClient, walletClient, ERC20_ABI } from "./chain";
import { tryResolve } from "./registry";
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
 */
async function ensurePermit2(account: Address, token: Address, spender: Address, amount: bigint) {
  const pc = publicClient();
  const wc = await walletClient();

  const erc20Allowance = (await pc.readContract({
    address: token, abi: ERC20_ABI, functionName: "allowance", args: [account, PERMIT2],
  })) as bigint;
  if (erc20Allowance < amount) {
    const { request } = await pc.simulateContract({
      address: token, abi: ERC20_ABI, functionName: "approve", args: [PERMIT2, maxUint256], account,
    });
    await wc.writeContract({ ...request, account } as never);
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
    await wc.writeContract({ ...request, account } as never);
  }
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
  const posm = await positionManager();
  if (!posm) throw new Error("no v4 PositionManager for this network");

  // Approvals only for the sides that will actually move.
  if (a.amount0Max > 0n) await ensurePermit2(a.account, a.pool.key.currency0 as Address, posm, a.amount0Max);
  if (a.amount1Max > 0n) await ensurePermit2(a.account, a.pool.key.currency1 as Address, posm, a.amount1Max);

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
  return wc.writeContract({ ...request, account: a.account } as never);
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
