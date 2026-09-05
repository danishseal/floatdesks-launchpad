/**
 * End-to-end signing test against a real chain.
 *
 * Drives the SHIPPED tx builders in lib/float/chain.ts, not a reimplementation
 * of them, which is the whole point: simulating proves the calldata builds,
 * signing proves it lands. Approvals, nonces, live gas estimation and
 * revert-on-send only exist on this side of the line.
 *
 * Uses a throwaway key from ~/.float/testnet-e2e-user, never the deployer, so
 * the flow starts from a zero-state account the way a real user does.
 *
 *   bun scripts/e2e-sign.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  setWalletClientFactory, floatChain, publicClient, tx, waitFor,
  deskVault, deskShares, balanceOf, getListing, listingIds, markPx,
  launchpadParams, tokenCurve, tokenPreviewBuy,
} from "../src/lib/float/chain";
import { resolve } from "../src/lib/float/registry";

const [addr, pk] = readFileSync(`${homedir()}/.float/testnet-e2e-user`, "utf8").trim().split("\n");
const account = privateKeyToAccount(pk as `0x${string}`);
const USER = addr as Address;

setWalletClientFactory(async () =>
  createWalletClient({ account, chain: floatChain(), transport: http(floatChain().rpcUrls.default.http[0]) }),
);

const ok = (s: string) => console.log(`  PASS  ${s}`);
const step = (s: string) => console.log(`\n[${s}]`);
let failures = 0;
async function attempt(name: string, fn: () => Promise<void>) {
  try { await fn(); } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
}

const usd6 = (v: bigint) => `$${(Number(v) / 1e6).toFixed(2)}`;
/** fSHARE and launched tokens are 18dp. */
const wad = (v: bigint) => (Number(v) / 1e18).toFixed(6);
/** Desk SHARES are 6dp like the quote asset, not 18. Formatting them as wad
 *  printed a real 100.196-share position as 0.000000. */
const shares6 = (v: bigint) => (Number(v) / 1e6).toFixed(6);

console.log(`e2e signing test on ${floatChain().name} (${floatChain().id}) as ${USER}`);

const usdg = await resolve("USDG");
const gas = await publicClient().getBalance({ address: USER });
console.log(`native gas balance ${Number(gas) / 1e18} ETH`);

// 1. Faucet ---------------------------------------------------------------
step("1. faucet mock USDG");
await attempt("faucetUsdg", async () => {
  const before = await balanceOf(usdg, USER);
  await waitFor(await tx.faucetUsdg(USER, 500_000_000n)); // 500 USDG
  const after = await balanceOf(usdg, USER);
  if (after <= before) throw new Error("balance did not increase");
  ok(`minted, balance ${usd6(before)} -> ${usd6(after)}`);
});

// 2. Deposit into the Desk vault ------------------------------------------
step("2. deposit USDG into the Desk (approve + deposit)");
await attempt("deskDeposit", async () => {
  const v0 = await deskVault();
  const s0 = await deskShares(USER);
  await waitFor(await tx.deskDeposit(USER, 100_000_000n)); // 100 USDG
  const v1 = await deskVault();
  const s1 = await deskShares(USER);
  if (s1 <= s0) throw new Error("no shares minted");
  ok(`shares ${wad(s0)} -> ${wad(s1)}, vault ${usd6(v0.available)} -> ${usd6(v1.available)}`);
});

// 3. Buy the fSHARE from the Desk -----------------------------------------
step("3. buy fMOUTAI from the Desk");
const ids = await listingIds();
let live: { assetId: `0x${string}`; token: Address; ticker: string } | null = null;
for (const id of ids) {
  const l = await getListing(id);
  if (l.status === 0) { live = { assetId: id, token: l.token, ticker: l.ticker }; break; }
}
if (!live) { console.log("  SKIP  no live market"); }
else {
  console.log(`  live market: ${live.ticker} at $${(Number(await markPx(live.assetId)) / 1e8).toFixed(2)}`);
  await attempt("deskBuy", async () => {
    const before = await balanceOf(live!.token, USER);
    await waitFor(await tx.deskBuy(USER, live!.assetId, 50_000_000n, 0n)); // 50 USDG
    const after = await balanceOf(live!.token, USER);
    if (after <= before) throw new Error("no fSHARE received");
    ok(`f${live!.ticker} ${wad(before)} -> ${wad(after)}`);
  });
}

// 4. Launch a token on that fSHARE ----------------------------------------
step("4. launch a token on the live fSHARE");
let launched: Address | null = null;
if (live) {
  await attempt("launchToken", async () => {
    const p = await launchpadParams();
    console.log(`  launch fee ${usd6(p.launchFee)}, tokens before ${p.tokenCount}`);
    const sym = `E2E${Date.now().toString().slice(-5)}`;
    const hash = await tx.launchToken(USER, "E2E Signing Test", sym, live!.assetId, {
      image: "", website: "", twitter: "", telegram: "",
    });
    const rc = await waitFor(hash);
    const after = await launchpadParams();
    if (after.tokenCount <= p.tokenCount) throw new Error("tokenCount did not increase");
    // The new token is the last entry; read it back off chain.
    const pad = await resolve("TOKEN_LAUNCHPAD");
    launched = (await publicClient().readContract({
      address: pad,
      abi: [{ type: "function", name: "allTokens", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }],
      functionName: "allTokens",
      args: [after.tokenCount - 1n],
    })) as Address;
    ok(`${sym} launched at ${launched} (block ${rc.blockNumber})`);
  });
}

// 5. Buy on the new curve --------------------------------------------------
step("5. buy on the launched token's curve");
if (launched && live) {
  await attempt("tokenBuy", async () => {
    const quoteIn = 100_000_000_000_000_000n; // 0.1 fSHARE
    const [expected] = await tokenPreviewBuy(launched!, quoteIn);
    const before = await balanceOf(launched!, USER);
    await waitFor(await tx.tokenBuy(USER, launched!, quoteIn, 0n, live!.token));
    const after = await balanceOf(launched!, USER);
    if (after <= before) throw new Error("no tokens received");
    const c = await tokenCurve(launched!);
    ok(`bought ${wad(after - before)} tokens (preview said ${wad(expected)}), raise now ${wad(c.rQuote)}`);
  });

// 6. Sell some back --------------------------------------------------------
  step("6. sell some of it back");
  await attempt("tokenSell", async () => {
    const bal = await balanceOf(launched!, USER);
    const half = bal / 2n;
    const q0 = await balanceOf(live!.token, USER);
    await waitFor(await tx.tokenSell(USER, launched!, half, 0n));
    const q1 = await balanceOf(live!.token, USER);
    if (q1 <= q0) throw new Error("no quote returned");
    ok(`sold ${wad(half)} tokens for ${wad(q1 - q0)} f${live!.ticker}`);
  });
}

// 7. Request a withdrawal --------------------------------------------------
step("7. request a Desk withdrawal");
await attempt("deskRequestWithdraw", async () => {
  const s = await deskShares(USER);
  if (s === 0n) throw new Error("no shares to withdraw");
  await waitFor(await tx.deskRequestWithdraw(USER, s / 2n));
  ok(`requested exit of ${wad(s / 2n)} shares (claimable after the delay)`);
});

console.log(`\n${failures === 0 ? "ALL STEPS SIGNED AND LANDED" : `${failures} STEP(S) FAILED`}`);
console.log(`gas left ${Number(await publicClient().getBalance({ address: USER })) / 1e18} ETH`);
process.exit(failures === 0 ? 0 : 1);
