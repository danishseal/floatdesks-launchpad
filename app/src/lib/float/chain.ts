/**
 * The single place this app talks to the chain. Everything above it works in
 * display units and never sees an ABI, a selector or a bigint.
 */

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  defineChain,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { activeNetwork } from "./networks";
import { resolve } from "./registry";
import {
  DESK_ABI,
  LISTINGS_ABI,
  TOKENLAUNCHPAD_ABI,
  VAULTFUNDER_ABI,
  STAKEVAULTS_ABI,
  ORACLEHUBMEDIAN_ABI,
} from "./abi";

export const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
] as const;

export function floatChain() {
  const net = activeNetwork();
  return defineChain({
    id: net.chainId,
    name: net.label,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [net.rpc] } },
    blockExplorers: { default: { name: "Explorer", url: net.explorer } },
    testnet: net.testnet,
  });
}

let _public: { rpc: string; client: PublicClient } | null = null;

export function publicClient(): PublicClient {
  const net = activeNetwork();
  if (_public && _public.rpc === net.rpc) return _public.client;
  const client = createPublicClient({
    chain: floatChain(),
    transport: http(net.rpc, { batch: true }),
  }) as PublicClient;
  _public = { rpc: net.rpc, client };
  return client;
}

export function resetClients() {
  _public = null;
}

/** Wallet client bound to the injected provider. Throws when none is present. */
export async function walletClient(): Promise<WalletClient> {
  const eth = typeof window !== "undefined" ? (window as { ethereum?: unknown }).ethereum : undefined;
  if (!eth) throw new Error("No wallet found. Install MetaMask or Rabby.");
  return createWalletClient({ chain: floatChain(), transport: custom(eth as never) });
}

// ---------------------------------------------------------------- reads

export type ListingStatus = 0 | 1 | 2; // Live | SettleOnly | Halted

export interface Listing {
  assetId: `0x${string}`;
  token: Address;
  status: ListingStatus;
  spot: boolean;
  baseSpreadBps: number;
  ahSpreadBps: number;
  maxImpactBps: number;
  maxStaleness: bigint;
  oiCapQuote: bigint;
  ticker: string;
  displayName: string;
}

export async function listingIds(): Promise<`0x${string}`[]> {
  const listings = await resolve("LISTINGS");
  const pc = publicClient();
  // assetIds is a plain array getter with no length accessor, so the end is
  // found by a revert. Probing sequentially cost one round trip per listing
  // plus one for the revert; probe a page in parallel and stop at the first
  // gap instead.
  const PAGE = 32;
  const out: `0x${string}`[] = [];
  for (let base = 0; ; base += PAGE) {
    const page = await Promise.all(
      Array.from({ length: PAGE }, (_, k) =>
        pc.readContract({
          address: listings,
          abi: LISTINGS_ABI,
          functionName: "assetIds",
          args: [BigInt(base + k)],
        }).then((v) => v as `0x${string}`).catch(() => null),
      ),
    );
    const upTo = page.findIndex((v) => v === null);
    out.push(...(upTo === -1 ? page : page.slice(0, upTo)) as `0x${string}`[]);
    if (upTo !== -1) break;
  }
  return out;
}

export async function getListing(assetId: `0x${string}`): Promise<Listing> {
  const listings = await resolve("LISTINGS");
  const l = (await publicClient().readContract({
    address: listings,
    abi: LISTINGS_ABI,
    functionName: "get",
    args: [assetId],
  })) as {
    assetId: `0x${string}`; token: Address; status: number; spot: boolean;
    baseSpreadBps: number; ahSpreadBps: number; maxImpactBps: number;
    maxStaleness: bigint; oiCapQuote: bigint; ticker: string; displayName: string;
  };
  return { ...l, status: l.status as ListingStatus };
}

export async function markPx(assetId: `0x${string}`): Promise<bigint> {
  const desk = await resolve("DESK");
  return (await publicClient().readContract({
    address: desk, abi: DESK_ABI, functionName: "markPx", args: [assetId],
  })) as bigint;
}

export async function oracleQuote(assetId: `0x${string}`) {
  const oracle = await resolve("ORACLE");
  const [price, updatedAt, marketOpen] = (await publicClient().readContract({
    address: oracle, abi: ORACLEHUBMEDIAN_ABI, functionName: "getQuote", args: [assetId],
  })) as [bigint, bigint, boolean];
  return { price, updatedAt, marketOpen };
}

/** Desk vault state: what the liquidity page is actually about. */
export async function deskVault() {
  const desk = await resolve("DESK");
  const pc = publicClient();
  const call = <T,>(functionName: string, args: unknown[] = []) =>
    pc.readContract({ address: desk, abi: DESK_ABI, functionName, args } as never) as Promise<T>;

  const [available, equity, totalShares, txFeeBps, stakerFeeBps, withdrawDelay] =
    await Promise.all([
      call<bigint>("availableLiquidity"),
      call<bigint>("equity"),
      call<bigint>("totalShares"),
      call<number>("txFeeBps"),
      call<number>("stakerFeeBps"),
      call<bigint>("withdrawDelay"),
    ]);
  return { address: desk, available, equity, totalShares, txFeeBps, stakerFeeBps, withdrawDelay };
}

export async function deskShares(owner: Address): Promise<bigint> {
  const desk = await resolve("DESK");
  return (await publicClient().readContract({
    address: desk, abi: DESK_ABI, functionName: "shares", args: [owner],
  })) as bigint;
}

export async function netOI(assetId: `0x${string}`): Promise<bigint> {
  const desk = await resolve("DESK");
  return (await publicClient().readContract({
    address: desk, abi: DESK_ABI, functionName: "netOI", args: [assetId],
  })) as bigint;
}

export async function funderQueue() {
  const funder = await resolve("FUNDER");
  const pc = publicClient();
  const [current, length, feeBalance] = await Promise.all([
    pc.readContract({ address: funder, abi: VAULTFUNDER_ABI, functionName: "current" }) as Promise<[`0x${string}`, bigint, bigint]>,
    pc.readContract({ address: funder, abi: VAULTFUNDER_ABI, functionName: "queueLength" }) as Promise<bigint>,
    pc.readContract({ address: funder, abi: VAULTFUNDER_ABI, functionName: "feeBalance" }) as Promise<bigint>,
  ]);
  return { address: funder, assetId: current[0], target: current[1], funded: current[2], length, feeBalance };
}

export interface Curve {
  underlying: `0x${string}`;
  quote: Address;
  creator: Address;
  vQuote: bigint;
  rQuote: bigint;
  vToken: bigint;
  sold: bigint;
  gradTarget: bigint;
  graduated: boolean;
}

export async function tokenCurve(token: Address): Promise<Curve> {
  const pad = await resolve("TOKEN_LAUNCHPAD");
  const r = (await publicClient().readContract({
    address: pad, abi: TOKENLAUNCHPAD_ABI, functionName: "curves", args: [token],
  })) as readonly [`0x${string}`, Address, Address, bigint, bigint, bigint, bigint, bigint, boolean];
  return {
    underlying: r[0], quote: r[1], creator: r[2], vQuote: r[3], rQuote: r[4],
    vToken: r[5], sold: r[6], gradTarget: r[7], graduated: r[8],
  };
}

export async function launchpadParams() {
  const pad = await resolve("TOKEN_LAUNCHPAD");
  const pc = publicClient();
  const call = <T,>(functionName: string) =>
    pc.readContract({ address: pad, abi: TOKENLAUNCHPAD_ABI, functionName } as never) as Promise<T>;
  const [launchFee, feeBps, creatorShareBps, virtualQuoteUsd, graduationUsd, tokenCount] =
    await Promise.all([
      call<bigint>("launchFeeUsdg"),
      call<number>("feeBps"),
      call<number>("creatorShareBps"),
      call<bigint>("virtualQuoteUsd"),
      call<bigint>("graduationUsd"),
      call<bigint>("tokenCount"),
    ]);
  return { address: pad, launchFee, feeBps, creatorShareBps, virtualQuoteUsd, graduationUsd, tokenCount };
}

export async function tokenPreviewBuy(token: Address, quoteIn: bigint) {
  const pad = await resolve("TOKEN_LAUNCHPAD");
  return (await publicClient().readContract({
    address: pad, abi: TOKENLAUNCHPAD_ABI, functionName: "previewBuy", args: [token, quoteIn],
  })) as [bigint, bigint];
}

export async function tokenPreviewSell(token: Address, tokensIn: bigint) {
  const pad = await resolve("TOKEN_LAUNCHPAD");
  return (await publicClient().readContract({
    address: pad, abi: TOKENLAUNCHPAD_ABI, functionName: "previewSell", args: [token, tokensIn],
  })) as [bigint, bigint];
}

export async function deskPreviewBuy(assetId: `0x${string}`, quoteIn: bigint) {
  const desk = await resolve("DESK");
  return (await publicClient().readContract({
    address: desk, abi: DESK_ABI, functionName: "previewBuy", args: [assetId, quoteIn],
  })) as [bigint, bigint];
}

export async function deskPreviewSell(assetId: `0x${string}`, baseIn: bigint) {
  const desk = await resolve("DESK");
  return (await publicClient().readContract({
    address: desk, abi: DESK_ABI, functionName: "previewSell", args: [assetId, baseIn],
  })) as [bigint, bigint];
}

export async function erc20(token: Address, owner?: Address) {
  const pc = publicClient();
  const call = <T,>(functionName: string, args: unknown[] = []) =>
    pc.readContract({ address: token, abi: ERC20_ABI, functionName, args } as never) as Promise<T>;
  const [symbol, decimals, totalSupply] = await Promise.all([
    call<string>("symbol"), call<number>("decimals"), call<bigint>("totalSupply"),
  ]);
  const balance = owner ? await call<bigint>("balanceOf", [owner]) : 0n;
  return { symbol, decimals, totalSupply, balance };
}

export async function balanceOf(token: Address, owner: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [owner],
  })) as bigint;
}

export async function allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender],
  })) as bigint;
}

export async function stakePool(assetId: `0x${string}`) {
  const sv = await resolve("STAKE_VAULTS");
  const r = (await publicClient().readContract({
    address: sv, abi: STAKEVAULTS_ABI, functionName: "pools", args: [assetId],
  })) as readonly [bigint, bigint, bigint];
  return { address: sv, totalStaked: r[0], accPerShare: r[1], unallocated: r[2] };
}

export async function pendingStakeRewards(assetId: `0x${string}`, who: Address): Promise<bigint> {
  const sv = await resolve("STAKE_VAULTS");
  return (await publicClient().readContract({
    address: sv, abi: STAKEVAULTS_ABI, functionName: "pendingRewards", args: [assetId, who],
  })) as bigint;
}

// ---------------------------------------------------------------- writes

async function send(
  account: Address,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: unknown[],
): Promise<`0x${string}`> {
  const wc = await walletClient();
  const pc = publicClient();
  // Simulate first: a revert here is a clear error instead of a wallet popup
  // that fails on chain and burns gas.
  const { request } = await pc.simulateContract({
    account, address, abi: abi as never, functionName, args, chain: floatChain(),
  });
  return wc.writeContract(request as never);
}

export async function waitFor(hash: `0x${string}`) {
  return publicClient().waitForTransactionReceipt({ hash });
}

export async function ensureAllowance(
  account: Address, token: Address, spender: Address, amount: bigint,
): Promise<`0x${string}` | null> {
  const have = await allowance(token, account, spender);
  if (have >= amount) return null;
  const hash = await send(account, token, ERC20_ABI, "approve", [spender, amount]);
  await waitFor(hash);
  return hash;
}

export const tx = {
  async deskDeposit(account: Address, quoteIn: bigint) {
    const desk = await resolve("DESK");
    const usdg = await resolve("USDG");
    await ensureAllowance(account, usdg, desk, quoteIn);
    return send(account, desk, DESK_ABI, "deposit", [quoteIn]);
  },
  async deskRequestWithdraw(account: Address, shareAmount: bigint) {
    const desk = await resolve("DESK");
    return send(account, desk, DESK_ABI, "requestWithdraw", [shareAmount]);
  },
  async deskClaimWithdraw(account: Address, id: bigint) {
    const desk = await resolve("DESK");
    return send(account, desk, DESK_ABI, "claimWithdraw", [id]);
  },
  async deskBuy(account: Address, assetId: `0x${string}`, quoteIn: bigint, minBaseOut: bigint) {
    const desk = await resolve("DESK");
    const usdg = await resolve("USDG");
    await ensureAllowance(account, usdg, desk, quoteIn);
    return send(account, desk, DESK_ABI, "buy", [assetId, quoteIn, minBaseOut, account]);
  },
  async deskSell(account: Address, assetId: `0x${string}`, baseIn: bigint, minQuoteOut: bigint, fshare: Address) {
    const desk = await resolve("DESK");
    await ensureAllowance(account, fshare, desk, baseIn);
    return send(account, desk, DESK_ABI, "sell", [assetId, baseIn, minQuoteOut, account]);
  },
  async launchToken(
    account: Address,
    name: string,
    symbol: string,
    underlying: `0x${string}`,
    meta: { image: string; website: string; twitter: string; telegram: string },
  ) {
    const pad = await resolve("TOKEN_LAUNCHPAD");
    const usdg = await resolve("USDG");
    const { launchFee } = await launchpadParams();
    if (launchFee > 0n) await ensureAllowance(account, usdg, pad, launchFee);
    return send(account, pad, TOKENLAUNCHPAD_ABI, "launchToken", [name, symbol, underlying, meta]);
  },
  async tokenBuy(account: Address, token: Address, quoteIn: bigint, minOut: bigint, quote: Address) {
    const pad = await resolve("TOKEN_LAUNCHPAD");
    await ensureAllowance(account, quote, pad, quoteIn);
    return send(account, pad, TOKENLAUNCHPAD_ABI, "buy", [token, quoteIn, minOut]);
  },
  async tokenSell(account: Address, token: Address, tokensIn: bigint, minOut: bigint) {
    const pad = await resolve("TOKEN_LAUNCHPAD");
    await ensureAllowance(account, token, pad, tokensIn);
    return send(account, pad, TOKENLAUNCHPAD_ABI, "sell", [token, tokensIn, minOut]);
  },
  async contribute(account: Address, assetId: `0x${string}`, amount: bigint) {
    const funder = await resolve("FUNDER");
    const usdg = await resolve("USDG");
    await ensureAllowance(account, usdg, funder, amount);
    return send(account, funder, VAULTFUNDER_ABI, "contribute", [assetId, amount]);
  },
  async claimLaunchShares(account: Address, assetId: `0x${string}`) {
    const funder = await resolve("FUNDER");
    return send(account, funder, VAULTFUNDER_ABI, "claimLaunchShares", [assetId]);
  },
  async stake(account: Address, assetId: `0x${string}`, amount: bigint, fshare: Address) {
    const sv = await resolve("STAKE_VAULTS");
    await ensureAllowance(account, fshare, sv, amount);
    return send(account, sv, STAKEVAULTS_ABI, "stake", [assetId, amount]);
  },
  async claimStakeRewards(account: Address, assetId: `0x${string}`) {
    const sv = await resolve("STAKE_VAULTS");
    return send(account, sv, STAKEVAULTS_ABI, "claimRewards", [assetId]);
  },
  /** Testnet only: the mock USDG has an open mint. */
  async faucetUsdg(account: Address, amount: bigint) {
    const usdg = await resolve("USDG");
    return send(account, usdg, ERC20_ABI, "mint", [account, amount]);
  },
};

/**
 * Whether the funding queue can currently take a contribution for this asset.
 * VaultFunder.contribute reverts NotQueued unless the market is enqueued and
 * not yet poured, and a market funded some other way (CurveFunder's
 * fundFromCurve, say) is never enqueued at all. Gate the UI on this, not on
 * which network is selected.
 */
export async function funderAcceptsContribution(assetId: `0x${string}`): Promise<boolean> {
  const funder = await resolve("FUNDER");
  const pc = publicClient();
  const [idx, poured] = await Promise.all([
    pc.readContract({ address: funder, abi: VAULTFUNDER_ABI, functionName: "queueIndexOf", args: [assetId] }) as Promise<bigint>,
    pc.readContract({ address: funder, abi: VAULTFUNDER_ABI, functionName: "poured", args: [assetId] }) as Promise<boolean>,
  ]);
  return idx > 0n && !poured;
}
