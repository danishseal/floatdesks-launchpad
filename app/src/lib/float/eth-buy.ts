/**
 * Buying a launched token with native ETH.
 *
 * The curve only knows dollars. `CurveFunder.buy(token, usdgIn, minTokensOut)`
 * pulls USDG with `transferFrom`, and a graduated token is bought through its
 * two v4 pools with USDG as the input currency. Native ETH has no allowance to
 * pull, so it cannot be the input to either. An ETH purchase is therefore two
 * hops, in two transactions:
 *
 *     ETH --(v4 ETH/USDG pool, EthSwapper)--> USDG --(curve or pools)--> TOKEN
 *
 * ## The half-done state is the whole problem
 *
 * Two transactions means there is a state between them. If the swap lands and
 * the buy does not, the buyer is holding USDG they never asked for, and every
 * naive version of this flow reports that as "buy failed" while their ETH is
 * gone. That reads as the curve eating someone's money.
 *
 * So this module treats it as a first-class outcome rather than an error:
 * `runEthBuy` RESOLVES with `{ kind: "stranded" }` carrying the swap hash, the
 * exact USDG now in the wallet and why the second hop refused. It throws only
 * when the first hop itself failed, which is the case where nothing moved. The
 * record is also written to localStorage, so closing the tab does not erase the
 * fact that a buy is half-finished, and `resumeEthBuy` finishes it from the
 * USDG without touching ETH again.
 *
 * Everything that can be checked before the ETH moves is checked before the ETH
 * moves: `plan.blocked` mirrors the conditions the second hop enforces (the
 * launcher knows the token, the underlying market is tradable, the Desk will
 * take the stock leg), because the cheapest way to handle a partial failure is
 * not to start one.
 *
 * ## Honest quoting
 *
 * Both legs are priced by the chain, not by a formula here. Hop one goes
 * through the canonical v4 Quoter at the user's ACTUAL size, against every
 * standard pool shape, and takes the best; the same quoter is asked for a small
 * reference trade in the winning pool so the price impact shown is the real
 * cost of the size rather than a guess. Hop two is `previewBuy` on the curve,
 * or the quoter across both pools once the curve is spent.
 *
 * Nothing about the ETH/USDG pool is assumed. Its fee and tick spacing are
 * discovered by quoting candidates and keeping the ones the chain answers, in
 * the same spirit as pools.ts verifying a reconstructed PoolKey against the id
 * the chain gave it. There are five live ETH/USDG pools on 4663 and the deepest
 * is not the cheapest at every size.
 *
 * ## Slippage
 *
 * Each hop carries its own minimum, never zero. Hop one's floor is the quote
 * less the tolerance. Hop two's floor is priced at hop one's FLOOR rather than
 * at its quote and discounted again, so `plan.minTokensOut` is what the buyer
 * is actually guaranteed across both legs, not a per-leg number that quietly
 * compounds.
 */

import { decodeEventLog, parseAbi, type Address, type Hex } from "viem";
import {
  publicClient, walletClient, floatChain, waitFor, balanceOf, deskBuyRefusal, ERC20_ABI,
} from "./chain";
import { CURVEFUNDER_ABI, REGISTRY_ABI } from "./abi";
import { registryKey, resolve } from "./registry";
import { activeNetwork } from "./networks";
import { isRateLimited, mapLimited } from "./retry";
import { cfCurve, cfPreviewBuy, cfTx } from "./curve-funder";
import { buyGraduated, quoteGraduated, type SwapRoute } from "./v4-router";
import { readableError } from "./errors";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * EthSwapper per chain, used only when the Registry names none.
 *
 * It is a permissionless, ownerless callback with no state between calls, and
 * it is not in the Registry because nothing registers it. Treated the way
 * pools.ts treats the canonical StateView and v4-router.ts the canonical
 * UniversalRouter: the Registry wins if anyone ever adds an ETH_SWAPPER key,
 * and the address below is checked against the chain before it is used, so a
 * wrong or absent one disables the ETH option instead of building a call that
 * would send value into nothing.
 */
const CANONICAL_ETH_SWAPPER: Record<number, Address> = {
  4663: "0xbD7136C158F1Ce990C2bD3b7602326f1e23cA355",
};

/** Canonical v4 Quoter per chain, the same one v4-router.ts prices hops with. */
const CANONICAL_QUOTER: Record<number, Address> = {
  4663: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
};

/**
 * Pool shapes to look for an ETH/USDG pool in. A shape that is not initialised
 * reverts PoolNotInitialized in the quoter and is dropped; the rest are priced
 * at the user's size and the best output wins. Standard v4 shapes plus the
 * 200/4 one this chain actually carries.
 */
const POOL_SHAPES: ReadonlyArray<{ fee: number; spacing: number }> = [
  { fee: 100, spacing: 1 },
  { fee: 200, spacing: 4 },
  { fee: 500, spacing: 10 },
  { fee: 3000, spacing: 60 },
  { fee: 10000, spacing: 200 },
];

const ETH_SWAPPER_ABI = parseAbi([
  "function poolManager() view returns (address)",
  "function swapEthFor(address token, uint24 fee, int24 tickSpacing, uint256 minOut, address to) payable returns (uint256 amountOut)",
  "event Swapped(uint256 ethIn, uint256 tokenOut)",
]);

const QUOTER_ABI = parseAbi([
  "struct PathKey { address intermediateCurrency; uint24 fee; int24 tickSpacing; address hooks; bytes hookData; }",
  "struct QuoteExactParams { address exactCurrency; PathKey[] path; uint128 exactAmount; }",
  "function quoteExactInput(QuoteExactParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

/** CurveFunder views that abi.ts predates. Read-only, used for the pre-flight. */
const CURVE_PREFLIGHT_ABI = parseAbi([
  "function tradable(address token) view returns (bool)",
  "function splitBpsOf(bytes32 assetId) view returns (uint256)",
  "function TOTAL_SUPPLY() view returns (uint256)",
]);

const BPS = 10_000n;

/** A bigint discounted by a fractional tolerance, in basis points. */
function less(value: bigint, fraction: number): bigint {
  const keep = BigInt(Math.max(0, Math.round((1 - fraction) * 10_000)));
  return (value * keep) / BPS;
}

/**
 * Did the chain answer, or could we not ask?
 *
 * The distinction is the whole safety of the route below. A quoter revert is an
 * ANSWER: the pool is not initialised, or it cannot fill this size. A transport
 * fault is not, and reading one as "this pool is out" ranks a live pool out of
 * the comparison and routes the trade through a worse one. That was not
 * hypothetical: with a plain `catch` the first browser run of this quoted
 * 0.05 ETH through the 1% pool at 2,427 USDG per ETH while the 0.01% pool was
 * paying 2,478, because three of the five quotes lost a race with the public
 * node's rate limiter and nothing said so.
 *
 * Same name-walk as pools.ts: viem wraps the transport error as a `cause`, and
 * a name is an interface where the message prose is not.
 */
const TRANSPORT_ERRORS = new Set([
  "HttpRequestError", "RpcRequestError", "TimeoutError", "UnknownRpcError",
  "InternalRpcError", "LimitExceededRpcError", "SocketClosedError",
  "WebSocketRequestError",
]);

function couldNotAsk(e: unknown): boolean {
  if (isRateLimited(e)) return true;
  for (let x = e as { name?: string; cause?: unknown } | undefined; x; x = x.cause as typeof x) {
    if (typeof x.name === "string" && TRANSPORT_ERRORS.has(x.name)) return true;
  }
  return false;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------ addresses

let swapperCache: { chainId: number; address: Address | null } | null = null;

/**
 * The EthSwapper for the active chain, or null when this chain has none.
 *
 * Verified rather than trusted: it must have code, and its `poolManager` must
 * be the PoolManager the Registry names. A helper pointed at a different
 * singleton would take the value and swap in a pool nobody here is quoting.
 */
export async function ethSwapperAddress(): Promise<Address | null> {
  const net = activeNetwork();
  if (swapperCache && swapperCache.chainId === net.chainId) return swapperCache.address;

  const address = await (async (): Promise<Address | null> => {
    const pc = publicClient();
    const registered = (await pc
      .readContract({
        address: net.registry,
        abi: REGISTRY_ABI,
        functionName: "addrs",
        args: [registryKey("ETH_SWAPPER")],
      })
      .catch(() => ZERO)) as Address;
    const candidate =
      registered && registered.toLowerCase() !== ZERO
        ? registered
        : CANONICAL_ETH_SWAPPER[net.chainId];
    if (!candidate) return null;

    const [code, manager, expected] = await Promise.all([
      pc.getCode({ address: candidate }).catch(() => undefined),
      pc
        .readContract({ address: candidate, abi: ETH_SWAPPER_ABI, functionName: "poolManager" })
        .catch(() => null) as Promise<Address | null>,
      resolve("V4_POOL_MANAGER").catch(() => null),
    ]);
    if (!code || code === "0x") return null;
    if (!manager || !expected) return null;
    if (manager.toLowerCase() !== expected.toLowerCase()) return null;
    return candidate;
  })().catch(() => null);

  swapperCache = { chainId: net.chainId, address };
  return address;
}

function quoterAddress(): Address | null {
  return CANONICAL_QUOTER[activeNetwork().chainId] ?? null;
}

let usdgCache: { chainId: number; address: Address; decimals: number } | null = null;

/**
 * USDG and its decimals, read rather than assumed. Defaulting decimals on this
 * chain is a silent 1e12 error in every number derived from it, which the
 * liquidity board has already paid for once.
 */
export async function usdgToken(): Promise<{ address: Address; decimals: number }> {
  const net = activeNetwork();
  if (usdgCache && usdgCache.chainId === net.chainId) return usdgCache;
  const address = await resolve("USDG");
  const decimals = Number(
    (await publicClient().readContract({
      address, abi: ERC20_ABI, functionName: "decimals",
    })) as number,
  );
  usdgCache = { chainId: net.chainId, address, decimals };
  return usdgCache;
}

// ------------------------------------------------------------------ the plan

/** Hop one: native ETH sold for USDG in one v4 pool. */
export interface EthLeg {
  swapper: Address;
  usdg: Address;
  usdgDecimals: number;
  fee: number;
  spacing: number;
  ethIn: bigint;
  /** What the chain's quoter says this size fetches right now. */
  usdgOut: bigint;
  /** The floor this hop is signed with. Never zero. */
  minUsdgOut: bigint;
  /** USDG per whole ETH at this size, and at a small reference size. */
  rate: number;
  /** Null when the reference trade would not price. */
  refRate: number | null;
  /** Fraction of the reference rate given up to size, or null when unknown. */
  priceImpact: number | null;
}

/** Hop two, which is a different venue before and after graduation. */
export type BuyLeg =
  | { kind: "curve"; token: Address }
  | { kind: "pool"; route: SwapRoute };

export interface EthBuyPlan {
  hop1: EthLeg;
  hop2: BuyLeg;
  slippage: number;
  /** Tokens for the QUOTED USDG. What the buyer should expect. */
  tokensOut: bigint;
  /** Tokens for the FLOOR USDG, discounted again. What they are guaranteed. */
  minTokensOut: bigint;
  /** The curve's own fee on hop two, in USDG. Null on the pool route. */
  curveFeeUsdg: bigint | null;
  /** Why hop two would refuse today, checked before any ETH moves. */
  blocked: string | null;
}

/**
 * One quoted candidate pool for the ETH leg.
 *
 * Returns null only when the CHAIN said no. A transport fault is retried, and
 * if it still will not answer it is thrown, because a pool we could not price
 * is not a pool we know is worse.
 */
async function quoteEthLeg(
  quoter: Address, usdg: Address, fee: number, spacing: number, ethIn: bigint,
): Promise<bigint | null> {
  const ATTEMPTS = 3;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { result } = await publicClient().simulateContract({
        address: quoter, abi: QUOTER_ABI, functionName: "quoteExactInput",
        args: [{
          exactCurrency: ZERO,
          path: [{ intermediateCurrency: usdg, fee, tickSpacing: spacing, hooks: ZERO, hookData: "0x" }],
          exactAmount: ethIn,
        }] as never,
      });
      const out = (result as readonly bigint[])[0];
      return out > 0n ? out : null;
    } catch (e) {
      // Not initialised, or too thin to fill this size without hitting the
      // price limit. Either way this pool cannot be the route.
      if (!couldNotAsk(e)) return null;
      if (attempt >= ATTEMPTS - 1) {
        throw new Error(
          "Could not price every ETH pool just now, so the best route is not known. Try again.",
        );
      }
      await sleep(300 * 2 ** attempt + Math.random() * 200);
    }
  }
}

/**
 * The ETH leg, priced across every candidate pool at the real size.
 *
 * Sizing against a successful full-size quote is also what keeps EthSwapper's
 * one trap shut. It has no owner and no sweep, and if the swap's price limit
 * binds the unconsumed ETH stays in the contract for good. A quote that fills
 * the whole amount says the pool can take it, and the floor below is enforced
 * on the output, so a partial fill would land under the minimum and revert
 * rather than leave ETH behind.
 */
export async function planEthLeg(ethIn: bigint, slippage: number): Promise<EthLeg> {
  if (ethIn <= 0n) throw new Error("Enter an amount of ETH above zero.");
  const quoter = quoterAddress();
  const swapper = await ethSwapperAddress();
  if (!quoter) throw new Error("This chain has no v4 quoter we can price ETH with.");
  if (!swapper) throw new Error("This chain has no ETH swapper, so ETH cannot be the input here.");
  const { address: usdg, decimals: usdgDecimals } = await usdgToken();

  // Through the same concurrency gate the rest of this app's reads use, since
  // firing five simulations at a node that rate-limits is what caused the
  // mis-routing described above.
  const quotes = await mapLimited(
    [...POOL_SHAPES],
    async (s) => ({ ...s, out: await quoteEthLeg(quoter, usdg, s.fee, s.spacing, ethIn) }),
  );
  const priced = quotes.filter((q): q is typeof q & { out: bigint } => q.out !== null);
  if (priced.length === 0) {
    throw new Error("No ETH pool on this chain can fill that size right now.");
  }
  const best = priced.reduce((a, b) => (b.out > a.out ? b : a));

  // A small trade in the SAME pool is the baseline the impact is measured
  // against. Both quotes pay the same pool fee, so the difference between them
  // is what the size itself costs, which is the number a buyer is owed. If that
  // reference will not price, the impact is unknown rather than zero: printing
  // 0.000% over an unmeasured number is the one answer worse than a dash.
  const reference = ethIn / 1000n > 10n ** 13n ? ethIn / 1000n : 10n ** 13n;
  const refOut = reference < ethIn
    ? await quoteEthLeg(quoter, usdg, best.fee, best.spacing, reference).catch(() => null)
    : null;

  const unit = 10 ** usdgDecimals;
  const rate = (Number(best.out) / unit) / (Number(ethIn) / 1e18);
  const refRate = refOut ? (Number(refOut) / unit) / (Number(reference) / 1e18) : null;
  return {
    swapper, usdg, usdgDecimals,
    fee: best.fee, spacing: best.spacing,
    ethIn,
    usdgOut: best.out,
    minUsdgOut: less(best.out, slippage),
    rate,
    refRate,
    priceImpact: refRate && refRate > 0 ? Math.max(0, (refRate - rate) / refRate) : null,
  };
}

/**
 * Would hop two refuse this today?
 *
 * `CurveFunder.buy` does more than move tokens: it deposits the vault share
 * through VaultFunder and buys the stock leg from the Desk, so it inherits
 * every condition the Desk enforces. `previewBuy` checks none of them, which is
 * exactly the shape of bug that lets a UI offer a trade the chain then refuses,
 * and here refusing costs a swap that has already happened.
 */
async function curveBlocked(
  token: Address, underlying: `0x${string}`, usdgIn: bigint,
): Promise<string | null> {
  try {
    const cf = await resolve("CURVE_FUNDER");
    const pc = publicClient();
    const curve = await cfCurve(token, cf);
    if (!curve.creator || curve.creator.toLowerCase() === ZERO) {
      return "the launcher this app buys through does not know this token";
    }
    if (curve.poolId && curve.poolId !== `0x${"0".repeat(64)}`) {
      return "this curve has graduated, so it no longer sells its own token";
    }

    const tradable = (await pc
      .readContract({ address: cf, abi: CURVE_PREFLIGHT_ABI, functionName: "tradable", args: [token] })
      .catch(() => null)) as boolean | null;
    if (tradable === false) {
      return "the market behind this token cannot trade right now, so the curve would refuse the buy";
    }

    const [out, fee] = await cfPreviewBuy(token, usdgIn);

    // What actually reaches the Desk: the buy nets off the curve fee, sends the
    // vault share to VaultFunder, and spends the rest on the stock.
    const net = usdgIn > fee ? usdgIn - fee : 0n;
    const splitBps = (await pc
      .readContract({ address: cf, abi: CURVE_PREFLIGHT_ABI, functionName: "splitBpsOf", args: [underlying] })
      .catch(() => null)) as bigint | null;
    // Not knowing the split is not knowing the stock leg, so measure the Desk
    // against the whole net rather than against a number we invented. That errs
    // toward refusing early, never toward promising a fill.
    const toShare = splitBps === null ? net : net - (net * splitBps) / BPS;
    // The market-wide reasons come first: they hold at every size, so telling
    // someone to trade smaller when nothing would fill is the wrong advice.
    const deskSaysNo = toShare > 0n ? await deskBuyRefusal(underlying, toShare) : null;
    if (deskSaysNo) return deskSaysNo;

    // previewBuy prices the curve formula and stops there, so it happily quotes
    // more tokens than exist: 0.5 ETH on the live mainnet curve previews
    // 1,054,098,503 tokens against a 1,000,000,000 supply, which buy() reverts
    // SupplyExhausted. Quoting that and letting the swap run first would strand
    // the dollars every time.
    const total = (await pc
      .readContract({ address: cf, abi: CURVE_PREFLIGHT_ABI, functionName: "TOTAL_SUPPLY" })
      .catch(() => null)) as bigint | null;
    if (total !== null && curve.sold + out > total) {
      return "the curve has fewer tokens left than a buy that size would take, so try a smaller amount";
    }
    return null;
  } catch {
    // Not knowing is not the same as refusing.
    return null;
  }
}

export interface PlanArgs {
  token: Address;
  /** The curve's underlying assetId. Only used on the curve route. */
  underlying: `0x${string}`;
  ethIn: bigint;
  slippage: number;
  /** Set once the curve is spent and the token trades in its two v4 pools. */
  route?: SwapRoute | null;
}

/** Price the whole ETH route, both hops, before anything is signed. */
export async function planEthBuy(args: PlanArgs): Promise<EthBuyPlan> {
  const { token, underlying, ethIn, slippage, route } = args;
  const hop1 = await planEthLeg(ethIn, slippage);
  const hop2: BuyLeg = route ? { kind: "pool", route } : { kind: "curve", token };

  if (hop2.kind === "pool") {
    const [expected, floor] = await Promise.all([
      quoteGraduated(hop2.route, hop1.usdgOut, "buy"),
      quoteGraduated(hop2.route, hop1.minUsdgOut, "buy"),
    ]);
    if (expected === null) {
      throw new Error("This token's pools would not price that size.");
    }
    return {
      hop1, hop2, slippage,
      tokensOut: expected,
      minTokensOut: less(floor ?? expected, slippage),
      curveFeeUsdg: null,
      blocked: null,
    };
  }

  const [[expected, fee], [floor], blocked] = await Promise.all([
    cfPreviewBuy(token, hop1.usdgOut),
    cfPreviewBuy(token, hop1.minUsdgOut),
    curveBlocked(token, underlying, hop1.usdgOut),
  ]);
  return {
    hop1, hop2, slippage,
    tokensOut: expected,
    minTokensOut: less(floor, slippage),
    curveFeeUsdg: fee,
    blocked,
  };
}

// ------------------------------------------------------------------ execution

export type EthBuyStep = "swapping" | "buying";

export interface EthBuyFilled {
  kind: "filled";
  swapHash: Hex;
  buyHash: Hex;
  /** USDG the swap actually produced and the buy actually spent. */
  usdgIn: bigint;
  tokensOut: bigint;
}

/**
 * Hop one landed, hop two did not. The buyer is holding USDG. This is a result,
 * not an exception: the caller has to show it, and it has to survive a reload.
 */
export interface EthBuyStranded {
  kind: "stranded";
  swapHash: Hex;
  usdgIn: bigint;
  reason: string;
}

export type EthBuyOutcome = EthBuyFilled | EthBuyStranded;

/** How much USDG the swap really produced, from the swapper's own event. */
function swappedUsdg(logs: readonly { address: string; topics: readonly string[]; data: string }[], swapper: Address): bigint | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== swapper.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: ETH_SWAPPER_ABI,
        topics: log.topics as [signature: Hex, ...args: Hex[]],
        data: log.data as Hex,
      });
      if (decoded.eventName === "Swapped") {
        return (decoded.args as unknown as { tokenOut: bigint }).tokenOut;
      }
    } catch {
      /* not ours */
    }
  }
  return null;
}

/** Tokens the curve actually delivered, from its own event. */
function boughtTokens(
  logs: readonly { address: string; topics: readonly string[]; data: string }[], launcher: Address,
): bigint | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== launcher.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: CURVEFUNDER_ABI,
        topics: log.topics as [signature: Hex, ...args: Hex[]],
        data: log.data as Hex,
      });
      if (decoded.eventName === "CurveBuy") {
        return (decoded.args as unknown as { tokensOut: bigint }).tokensOut;
      }
    } catch {
      /* not ours */
    }
  }
  return null;
}

/**
 * Hop one on its own. Throws on failure, because a failure here means nothing
 * moved: EthSwapper either fills the whole size or reverts, and the floor is
 * enforced on its output.
 */
async function swapEthForUsdg(account: Address, hop1: EthLeg): Promise<{ hash: Hex; usdg: bigint }> {
  const pc = publicClient();
  const wc = await walletClient();
  const signer = wc.account ?? account;
  const before = await balanceOf(hop1.usdg, account);
  const { request } = await pc.simulateContract({
    account: signer,
    address: hop1.swapper,
    abi: ETH_SWAPPER_ABI,
    functionName: "swapEthFor",
    args: [hop1.usdg, hop1.fee, hop1.spacing, hop1.minUsdgOut, account],
    value: hop1.ethIn,
    chain: floatChain(),
  });
  const hash = await wc.writeContract({ ...request, account: signer } as never);
  const receipt = await waitFor(hash);

  // Prefer the swapper's own event over a balance delta: the delta is only
  // right if nothing else touched this wallet's USDG in between, and being
  // wrong here means signing hop two for the wrong amount.
  const fromEvent = swappedUsdg(receipt.logs, hop1.swapper);
  if (fromEvent !== null && fromEvent > 0n) return { hash, usdg: fromEvent };
  const after = await balanceOf(hop1.usdg, account);
  return { hash, usdg: after > before ? after - before : 0n };
}

/**
 * Hop two on its own, priced fresh against the USDG actually in hand.
 *
 * The floor is recomputed here rather than reused from the plan because the
 * amount is whatever hop one really produced, and a minimum derived from a
 * different amount is not a minimum.
 */
export async function finishEthBuy(
  account: Address, leg: BuyLeg, usdgIn: bigint, slippage: number,
): Promise<{ hash: Hex; tokensOut: bigint }> {
  if (usdgIn <= 0n) throw new Error("There is no USDG to finish the buy with.");

  if (leg.kind === "pool") {
    const quoted = await quoteGraduated(leg.route, usdgIn, "buy");
    if (quoted === null || quoted === 0n) {
      throw new Error("This token's pools would not price that size.");
    }
    const min = less(quoted, slippage);
    const hash = await buyGraduated(account, leg.route, usdgIn, min);
    await waitFor(hash);
    return { hash, tokensOut: quoted };
  }

  const cf = await resolve("CURVE_FUNDER");
  const [quoted] = await cfPreviewBuy(leg.token, usdgIn);
  if (quoted === 0n) throw new Error("The curve would return nothing for that size.");
  const min = less(quoted, slippage);
  const hash = await cfTx.buy(account, leg.token, usdgIn, min);
  const receipt = await waitFor(hash);
  return { hash, tokensOut: boughtTokens(receipt.logs, cf) ?? quoted };
}

/**
 * The whole route. Resolves `stranded` when hop one landed and hop two did not;
 * throws only when hop one failed and nothing moved.
 */
export async function runEthBuy(
  account: Address,
  plan: EthBuyPlan,
  onStep?: (step: EthBuyStep) => void,
): Promise<EthBuyOutcome> {
  onStep?.("swapping");
  const { hash: swapHash, usdg } = await swapEthForUsdg(account, plan.hop1);

  if (usdg <= 0n) {
    return {
      kind: "stranded",
      swapHash,
      usdgIn: 0n,
      reason: "the swap reported no USDG, so the second half was not attempted",
    };
  }

  onStep?.("buying");
  try {
    const { hash: buyHash, tokensOut } = await finishEthBuy(account, plan.hop2, usdg, plan.slippage);
    return { kind: "filled", swapHash, buyHash, usdgIn: usdg, tokensOut };
  } catch (e) {
    return { kind: "stranded", swapHash, usdgIn: usdg, reason: readableError(e) };
  }
}

/**
 * Finish a stranded buy from the USDG already in the wallet. No ETH is touched.
 *
 * The amount is clamped to the balance actually there: a buyer who spent some
 * of it elsewhere should get the rest of the buy, not a revert.
 */
export async function resumeEthBuy(
  account: Address, leg: BuyLeg, recorded: bigint, slippage: number,
): Promise<{ hash: Hex; tokensOut: bigint; usdgIn: bigint }> {
  const { address: usdg } = await usdgToken();
  const held = await balanceOf(usdg, account);
  const usdgIn = held < recorded ? held : recorded;
  if (usdgIn <= 0n) {
    throw new Error("That USDG is no longer in this wallet, so there is nothing to finish.");
  }
  const done = await finishEthBuy(account, leg, usdgIn, slippage);
  return { ...done, usdgIn };
}

// ---------------------------------------------------------------- persistence

/**
 * A half-finished buy, remembered across reloads.
 *
 * Kept in localStorage rather than in component state because the failure this
 * describes is exactly the one a person reacts to by refreshing the page, and
 * losing the record there would leave them with unexplained USDG and no way
 * back to the token they were buying.
 */
export interface StrandedBuy {
  chainId: number;
  account: string;
  token: string;
  symbol: string;
  /** USDG in raw units, as a string: JSON has no bigint. */
  usdg: string;
  usdgDecimals: number;
  swapHash: string;
  reason: string;
  at: number;
}

const STORE_KEY = "float-eth-buy-stranded";

function slot(chainId: number, account: string, token: string): string {
  return `${chainId}:${account.toLowerCase()}:${token.toLowerCase()}`;
}

function readStore(): Record<string, StrandedBuy> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, StrandedBuy>) : {};
  } catch {
    return {};
  }
}

function writeStore(next: Record<string, StrandedBuy>) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* private mode: the in-session banner still stands */
  }
}

export function saveStranded(record: StrandedBuy) {
  const store = readStore();
  store[slot(record.chainId, record.account, record.token)] = record;
  writeStore(store);
}

export function loadStranded(chainId: number, account: string, token: string): StrandedBuy | null {
  return readStore()[slot(chainId, account, token)] ?? null;
}

export function clearStranded(chainId: number, account: string, token: string) {
  const store = readStore();
  delete store[slot(chainId, account, token)];
  writeStore(store);
}
