/**
 * The CurveFunder venue.
 *
 * Robinhood Chain mainnet runs this instead of TokenLaunchpad, and the two
 * differ in the way that matters most to a UI: a TokenLaunchpad curve is quoted
 * in the underlying fSHARE, a CurveFunder curve is quoted in USDG. So a buyer
 * here needs no fSHARE first, and `rQuote` is dollars rather than shares.
 *
 * Kept in its own module rather than branched inside chain.ts, so the
 * TokenLaunchpad path cannot be broken by a change made for this one. The
 * venue is chosen at runtime by detectVenue() from what the Registry holds.
 */

import type { Address } from "viem";
import { publicClient, ERC20_ABI, ensureAllowance, walletClient, floatChain } from "./chain";
import { CURVEFUNDER_ABI } from "./abi";
import { resolve } from "./registry";

export interface CurveFunderCurve {
  underlying: `0x${string}`;
  creator: Address;
  share: Address;
  vQuote: bigint;
  /** USDG units: net buys minus gross sells. Drives the price. */
  rQuote: bigint;
  vToken: bigint;
  sold: bigint;
  /** fSHARE actually held, which is what sells pay out of. */
  fShareReserve: bigint;
  gradTarget: bigint;
  graduated: boolean;
  /** Set at graduation. Non-zero means the curve is spent and a v4 pool owns it. */
  poolId: `0x${string}`;
}

export async function curveFunderAddress(): Promise<Address | null> {
  try {
    return await resolve("CURVE_FUNDER");
  } catch {
    return null;
  }
}

/**
 * Launchers whose tokens still exist but which the Registry no longer points
 * at. A superseded contract cannot by definition be in the registry, and
 * enumerating the current one alone showed 1 of 4 mainnet launches while
 * looking complete: MARIO, SLEEPY and SNOOZE live on 0xD55E56Be and their pools
 * still hold real liquidity.
 *
 * Overridable so this never becomes a stale constant of the kind that has
 * already cost this project three days. Empty is a valid value.
 */
function legacyLaunchers(): Address[] {
  const raw = process.env.NEXT_PUBLIC_FLOAT_LEGACY_LAUNCHERS;
  if (raw !== undefined) {
    return raw.split(",").map((a) => a.trim()).filter(Boolean) as Address[];
  }
  return ["0xD55E56BeaC9527Ace861a788BaAE82e5347c6495"];
}

/** Every launcher to read, current first. */
async function launchers(): Promise<Array<{ address: Address; superseded: boolean }>> {
  const current = await curveFunderAddress();
  const legacy = legacyLaunchers()
    .filter((a) => a.toLowerCase() !== current?.toLowerCase())
    .map((address) => ({ address, superseded: true }));
  return current ? [{ address: current, superseded: false }, ...legacy] : legacy;
}

export async function cfTokenCount(): Promise<bigint> {
  const cf = await resolve("CURVE_FUNDER");
  return (await publicClient().readContract({
    address: cf, abi: CURVEFUNDER_ABI, functionName: "tokenCount",
  })) as bigint;
}

/** Every launched token across every launcher, with which one holds it. */
export async function cfAllTokensDetailed(): Promise<
  Array<{ token: Address; launcher: Address; superseded: boolean }>
> {
  const pc = publicClient();
  const out: Array<{ token: Address; launcher: Address; superseded: boolean }> = [];
  for (const { address, superseded } of await launchers()) {
    const n = (await pc.readContract({
      address, abi: CURVEFUNDER_ABI, functionName: "tokenCount",
    }).catch(() => 0n)) as bigint;
    const tokens = await Promise.all(
      Array.from({ length: Number(n) }, (_, i) =>
        pc.readContract({
          address, abi: CURVEFUNDER_ABI, functionName: "allTokens", args: [BigInt(i)],
        }).then((t) => t as Address).catch(() => null),
      ),
    );
    for (const t of tokens) if (t) out.push({ token: t, launcher: address, superseded });
  }
  return out;
}

export async function cfAllTokens(): Promise<Address[]> {
  return (await cfAllTokensDetailed()).map((t) => t.token);
}

/**
 * A curve, read from the launcher that actually holds it. Reading a legacy
 * token against the current launcher returns a ZERO STRUCT rather than
 * reverting, which would render it as a real token with nothing in it.
 */
export async function cfCurve(token: Address, launcher?: Address): Promise<CurveFunderCurve> {
  const cf = launcher ?? (await resolve("CURVE_FUNDER"));
  // curves() returns a STRUCT here, not the flat tuple TokenLaunchpad returns.
  return (await publicClient().readContract({
    address: cf, abi: CURVEFUNDER_ABI, functionName: "curves", args: [token],
  })) as CurveFunderCurve;
}

export async function cfPreviewBuy(token: Address, usdgIn: bigint) {
  const cf = await resolve("CURVE_FUNDER");
  return (await publicClient().readContract({
    address: cf, abi: CURVEFUNDER_ABI, functionName: "previewBuy", args: [token, usdgIn],
  })) as [bigint, bigint];
}

export async function cfPreviewSell(token: Address, tokensIn: bigint) {
  const cf = await resolve("CURVE_FUNDER");
  return (await publicClient().readContract({
    address: cf, abi: CURVEFUNDER_ABI, functionName: "previewSell", args: [token, tokensIn],
  })) as [bigint, bigint];
}

/** ERC-20 identity for a launched token, since there is no indexer here. */
export async function cfTokenMeta(token: Address) {
  const pc = publicClient();
  const call = <T,>(functionName: string) =>
    pc.readContract({ address: token, abi: ERC20_ABI, functionName } as never) as Promise<T>;
  const [name, symbol] = await Promise.all([call<string>("name"), call<string>("symbol")]);
  return { name, symbol };
}

async function send(account: Address, address: Address, functionName: string, args: unknown[]) {
  const wc = await walletClient();
  const pc = publicClient();
  const signer = wc.account ?? account;
  const { request } = await pc.simulateContract({
    account: signer, address, abi: CURVEFUNDER_ABI as never, functionName, args, chain: floatChain(),
  });
  return wc.writeContract({ ...request, account: signer } as never);
}

export const cfTx = {
  /** Buys are paid in USDG here, not in the underlying fSHARE. */
  async buy(account: Address, token: Address, usdgIn: bigint, minOut: bigint) {
    const cf = await resolve("CURVE_FUNDER");
    const usdg = await resolve("USDG");
    await ensureAllowance(account, usdg, cf, usdgIn);
    return send(account, cf, "buy", [token, usdgIn, minOut]);
  },
  /** Sells pay out in the underlying fSHARE, out of fShareReserve. */
  async sell(account: Address, token: Address, tokensIn: bigint, minShareOut: bigint) {
    const cf = await resolve("CURVE_FUNDER");
    await ensureAllowance(account, token, cf, tokensIn);
    return send(account, cf, "sell", [token, tokensIn, minShareOut]);
  },
};
