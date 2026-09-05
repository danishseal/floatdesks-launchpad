/**
 * Single sided USDG zap, executed for real against a fork of Robinhood Chain
 * mainnet 4663, through the same library the app ships.
 *
 *   bun scripts/fork-zap.ts
 *
 * It starts its own anvil on port 8473, writes the pid to
 * /tmp/float-fork-zap.pid, and kills THAT PID when it is done. It never
 * pattern-kills: other sessions on this machine run their own anvil, node and
 * bun processes and a pattern kill takes them out.
 *
 * Set REUSE_FORK=1 to talk to an anvil that is already up on 8473 instead.
 *
 * Fork from a RECENT block. The public RPC is not an archive node and its
 * window is well under an hour: a fork left running past it starts answering
 * "metadata is not found" for storage it has never fetched, which surfaces as
 * a contract revert with no reason and reads exactly like a bug in this code.
 * It is not one. Re-fork and run again.
 *
 * What it checks, in order:
 *
 *   1. the tick maths agrees with the pool's own sqrtPriceX96
 *   2. the split is DERIVED: three ranges on one pool, one straddling spot and
 *      two entirely to one side, give three different splits
 *   3. USDG is currency0 in three quote pools and currency1 in SNOOZE, and
 *      both are handled
 *   4. on PRISTINE mainnet state the Desk refuses, naming the rule that refused
 *   5. with the listing flipped Live ON THE FORK the whole thing runs
 *   6. the OI cap refusal is told apart from the settle-only one
 *   7. the documented hazard, reproduced: move the pool under a snapshot and
 *      the mint fails with the Desk's fSHARE already bought and stranded
 */

import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createWalletClient, http, encodeFunctionData, parseAbi, type Address } from "viem";

const PORT = Number(process.env.ANVIL_PORT ?? 8473);
const RPC = `http://127.0.0.1:${PORT}`;
const PID_FILE = process.env.PID_FILE ?? "/tmp/float-fork-zap.pid";
const UPSTREAM = "https://rpc.mainnet.chain.robinhood.com";

process.env.NEXT_PUBLIC_FLOAT_NETWORK = "float-mainnet";
process.env.NEXT_PUBLIC_FLOAT_RPC = RPC;

const { setWalletClientFactory, floatChain, publicClient, balanceOf, netOI, getListing, oracleQuote, waitFor } =
  await import("../src/lib/float/chain");
const { resolve } = await import("../src/lib/float/registry");
const { lpPools } = await import("../src/lib/float/pools");
const {
  planZapUsdg,
  zapUsdgIntoQuotePool,
  listingForFshare,
  centredRange,
  sqrtRatioAtTick,
  positionLiquidity,
  positionManager,
  unwindZapShares,
} = await import("../src/lib/float/lp");
const { routeFor, buyGraduated } = await import("../src/lib/float/v4-router");

type Pool = Awaited<ReturnType<typeof lpPools>>["pools"][number];

// ------------------------------------------------------------------- fork

let id = 0;
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const j = (await r.json()) as { error?: { message: string }; result?: unknown };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function upstreamHead(): Promise<number> {
  const r = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  return Number((await r.json()).result);
}

let anvilPid: number | null = null;

/**
 * Refuse a port somebody else is on.
 *
 * The poll below waits for anything to answer on PORT and checks only the
 * chain id. A neighbouring session's fork of the same chain passes that, and
 * this script then impersonates accounts, flips listing status and sends
 * transactions into THEIR node. This machine runs several forks at once, and
 * the repo rule is to check the port before binding rather than after.
 */
function portIsFree(port: number): boolean {
  try {
    execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return false; // something answered, so it is taken
  } catch {
    return true; // lsof exits non-zero when nothing holds the port
  }
}

async function startFork() {
  if (process.env.REUSE_FORK) {
    console.log(`reusing the anvil already on ${RPC}`);
    return;
  }
  if (!portIsFree(PORT)) {
    throw new Error(
      `port ${PORT} is already held by another process. This script impersonates ` +
        `accounts and changes listing status, and the readiness poll below only ` +
        `checks the chain id, which a neighbouring fork of 4663 would also pass. ` +
        `Set ANVIL_PORT to a free port, or REUSE_FORK=1 if that node is genuinely yours.`,
    );
  }
  // A few blocks back from the tip, so the fork does not race a reorg, and
  // nowhere near old enough to fall out of the RPC's state window.
  const head = await upstreamHead();
  const forkBlock = head - 20;
  const child = spawn(
    "anvil",
    ["--fork-url", UPSTREAM, "--fork-block-number", String(forkBlock), "--port", String(PORT), "--silent"],
    { stdio: "ignore" },
  );
  anvilPid = child.pid ?? null;
  if (anvilPid) writeFileSync(PID_FILE, String(anvilPid));
  console.log(`anvil pid ${anvilPid} forking 4663 at block ${forkBlock} on ${RPC}`);
  for (let i = 0; i < 120; i++) {
    try {
      await rpc("eth_chainId", []);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("anvil did not come up");
}

function stopFork() {
  if (anvilPid === null) return;
  try {
    process.kill(anvilPid, "SIGTERM"); // BY PID. never pattern kill on this machine.
    console.log(`\nkilled anvil pid ${anvilPid}`);
  } catch (e) {
    console.log(`could not kill anvil pid ${anvilPid}: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------------ format

const usd = (v: bigint) => `$${(Number(v) / 1e6).toFixed(6)}`;
const wad = (v: bigint) => (Number(v) / 1e18).toFixed(8);
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

function showResult(label: string, r: Awaited<ReturnType<typeof zapUsdgIntoQuotePool>>) {
  console.log(`\n  ${label}: ${r.ok ? "OK" : `FAILED at ${r.failedAt}`}`);
  for (const s of r.steps) {
    console.log(`    [${s.ok ? "ok  " : "fail"}] ${s.name.padEnd(9)} ${s.detail}`);
    for (const h of s.hashes) console.log(`             tx ${h}`);
  }
  if (!r.ok) console.log(`    error: ${r.error}`);
  console.log(`    USDG   ${usd(r.balances.before.usdg)} -> ${usd(r.balances.after.usdg)}`);
  console.log(`    fSHARE ${wad(r.balances.before.fshare)} -> ${wad(r.balances.after.fshare)}`);
  if (r.position) {
    console.log(
      `    position #${r.position.tokenId}  liquidity ${r.position.liquidity}  `
        + `amount0 ${r.position.amount0}  amount1 ${r.position.amount1}`,
    );
  }
  if (r.strandedShares > 0n) console.log(`    STRANDED fSHARE ${wad(r.strandedShares)}`);
}

/** One sided and straddling ranges around a pool's current tick, all aligned. */
function ranges(pool: Pool) {
  const s = pool.key.tickSpacing;
  const base = Math.floor(pool.tick / s) * s;
  return {
    straddling: centredRange(pool, 10),
    above: { tickLower: base + 4 * s, tickUpper: base + 14 * s },
    below: { tickLower: base - 14 * s, tickUpper: base - 4 * s },
  };
}

// -------------------------------------------------------------------- run

const LISTINGS_ADMIN_ABI = parseAbi([
  "function owner() view returns (address)",
  "function setStatus(bytes32 assetId, uint8 status)",
]);

let failures = 0;
const bad = (why: string) => {
  failures++;
  console.log(`  CHECK FAILED: ${why}`);
};

try {
  await startFork();

  const chainId = Number(await rpc("eth_chainId", []));
  console.log(`chain ${chainId}, forked at block ${await publicClient().getBlockNumber()}\n`);
  if (chainId !== 4663) throw new Error("not a 4663 fork");

  const usdg = await resolve("USDG");
  const listings = await resolve("LISTINGS");
  console.log(`registry USDG ${usdg}\nregistry DESK ${await resolve("DESK")}\nregistry LISTINGS ${listings}`);

  const owner = (await publicClient().readContract({
    address: listings, abi: LISTINGS_ADMIN_ABI, functionName: "owner",
  })) as Address;
  // One account in both roles: it is the deployer, it owns Listings, and it is
  // the only address on this chain holding USDG, so it is the only way to play
  // a user without inventing a balance.
  const WHO = (process.env.ACCOUNT ?? owner) as Address;
  for (const who of new Set([WHO, owner])) {
    await rpc("anvil_impersonateAccount", [who]);
    await rpc("anvil_setBalance", [who, "0xde0b6b3a7640000"]);
  }
  setWalletClientFactory(async () =>
    createWalletClient({ account: WHO, chain: floatChain(), transport: http(RPC) }),
  );
  console.log(`acting as ${WHO}, holding ${usd(await balanceOf(usdg, WHO))} USDG\n`);

  const { pools } = await lpPools();
  const quote = pools.filter((p) => p.kind === "quote");

  // -- 1. the tick maths against the pool's own price ----------------------
  console.log("1. TickMath vs the chain's own sqrtPriceX96");
  for (const p of quote) {
    const sp = BigInt(p.sqrtPriceX96);
    const lo = sqrtRatioAtTick(p.tick);
    const hi = sqrtRatioAtTick(p.tick + 1);
    if (!(lo <= sp && sp < hi)) bad(`${p.launch.symbol}: sqrtPriceX96 outside its own tick`);
    console.log(`  ${p.launch.symbol.padEnd(7)} tick ${String(p.tick).padStart(8)}  ${lo <= sp && sp < hi ? "in range" : "OUT OF RANGE"}`);
  }

  // -- the four quote pools, and which of them the Desk can actually mint --
  console.log("\n   the quote pools, and whether the Desk can mint their fSHARE");
  const now = BigInt(Math.floor(Date.now() / 1000));
  const tradeable: Pool[] = [];
  for (const p of quote) {
    const fshare = (p.usdgSide === 0 ? p.key.currency1 : p.key.currency0) as Address;
    const found = await listingForFshare(fshare);
    if (!found) {
      bad(`no listing relates ${fshare} to an assetId`);
      continue;
    }
    const l = await getListing(found.assetId);
    const o = await oracleQuote(found.assetId);
    const fresh = now <= o.updatedAt + l.maxStaleness;
    if (fresh) tradeable.push(p);
    console.log(
      `  ${p.launch.symbol.padEnd(7)} ${p.symbol0}/${p.symbol1}  USDG is currency${p.usdgSide}  `
        + `${l.ticker.padEnd(9)} status ${l.status}  oracle ${fresh ? "fresh" : "STALE"} `
        + `(posted ${o.updatedAt}, expires ${o.updatedAt + l.maxStaleness}, now ${now})`,
    );
  }

  const target = tradeable[0];
  const snooze = quote.find((p) => p.usdgSide === 1);
  if (!snooze) throw new Error("expected one quote pool with USDG as currency1");
  if (!target) throw new Error("no quote pool has a fresh oracle, so no Desk buy can be made at all");
  console.log(`\n   using ${target.launch.symbol} for the execution phases: its oracle is the fresh one`);

  const IN = 10_000_000n; // $10
  const R = ranges(target);

  // -- 2. the split is derived from the range -----------------------------
  console.log(
    `\n2. the split for ${usd(IN)} on the ${target.launch.symbol} quote pool `
      + `(USDG is currency${target.usdgSide}, tick ${target.tick})`,
  );
  for (const [label, r] of [
    ["straddling spot", R.straddling], ["entirely above spot", R.above], ["entirely below spot", R.below],
  ] as const) {
    const plan = await planZapUsdg({ account: WHO, pool: target, usdgIn: IN, ...r });
    console.log(
      `  ${label.padEnd(20)} [${r.tickLower}, ${r.tickUpper}]  desk ${pct(plan.deskFraction).padStart(7)}  `
        + `${usd(plan.usdgToDesk)} to the Desk, ${usd(plan.usdgToPool)} stays USDG, `
        + `quoted ${wad(plan.previewShares)} f${plan.ticker}`,
    );
  }

  // -- 3. USDG on the other side ------------------------------------------
  console.log(`\n3. the ${snooze.launch.symbol} pool, where USDG is currency${snooze.usdgSide} (tick ${snooze.tick})`);
  const sr = centredRange(snooze, 10);
  const snoozePlan = await planZapUsdg({ account: WHO, pool: snooze, usdgIn: IN, ...sr });
  console.log(
    `  straddling spot [${sr.tickLower}, ${sr.tickUpper}]  desk ${pct(snoozePlan.deskFraction)}  `
      + `USDG side picked as ${snoozePlan.usdg}, fSHARE as ${snoozePlan.fshare} (${snoozePlan.ticker})`,
  );
  if (snoozePlan.usdg.toLowerCase() !== usdg.toLowerCase()) bad("picked the fSHARE as the USDG side");
  if (snoozePlan.fshare.toLowerCase() === usdg.toLowerCase()) bad("picked USDG as the fSHARE side");

  // -- 4. pristine mainnet state ------------------------------------------
  const plan0 = await planZapUsdg({ account: WHO, pool: target, usdgIn: IN, ...R.straddling });
  const listing0 = await getListing(plan0.assetId);
  console.log(
    `\n4. the zap against PRISTINE mainnet state. ${plan0.ticker} is status `
      + `${listing0.status} (0 Live, 1 SettleOnly, 2 Halted)`,
  );
  {
    const snap = await rpc("evm_snapshot", []);
    const r = await zapUsdgIntoQuotePool({ account: WHO, pool: target, usdgIn: IN, ...R.straddling });
    showResult(`straddling spot, ${target.launch.symbol}`, r);
    if (r.ok || !/settle-only/.test(r.error ?? "")) bad("expected a settle-only refusal on pristine state");
    if (r.balances.before.usdg !== r.balances.after.usdg) bad("a refused zap still spent USDG");
    await rpc("evm_revert", [snap]);
  }

  // -- 5. with the listing flipped Live on the fork ------------------------
  console.log(
    "\n5. the same zap after flipping the listing to Live ON THE FORK.\n"
      + "   A deliberate change to forked state, made as the Listings owner. Every\n"
      + "   market on mainnet is settle-only right now, so the happy path cannot be\n"
      + "   exercised without it.",
  );
  async function setLive(assetId: `0x${string}`) {
    const hash = await rpc("eth_sendTransaction", [{
      from: owner,
      to: listings,
      data: encodeFunctionData({ abi: LISTINGS_ADMIN_ABI, functionName: "setStatus", args: [assetId, 0] }),
      gas: "0x100000",
    }]) as `0x${string}`;
    await waitFor(hash);
  }

  {
    const snap = await rpc("evm_snapshot", []);
    await setLive(plan0.assetId);
    console.log(`  ${plan0.ticker} set Live. netOI before ${await netOI(plan0.assetId)}`);

    const r = await zapUsdgIntoQuotePool({ account: WHO, pool: target, usdgIn: IN, ...R.straddling });
    showResult(`straddling spot, ${target.launch.symbol}, Live`, r);
    if (!r.ok) bad("the zap should have gone through on a Live market");

    // Read the minted NFT back off chain. positionsIn() is the library way but
    // it scans Transfer logs from block 0, which a fork forwards to the
    // throttled public RPC.
    if (r.position) {
      const tokenId = BigInt(r.position.tokenId);
      const owner721 = (await publicClient().readContract({
        address: (await positionManager())!,
        abi: parseAbi(["function ownerOf(uint256) view returns (address)"]),
        functionName: "ownerOf", args: [tokenId],
      })) as Address;
      const liq = await positionLiquidity(tokenId);
      console.log(`  position #${tokenId} reads back: owner ${owner721}, liquidity ${liq}`);
      if (owner721.toLowerCase() !== WHO.toLowerCase() || liq === 0n) {
        bad("the minted position does not read back as the account's");
      }
      // The leftover is meant to land in USDG, so anything above dust on the
      // fSHARE side means the split's bias was not enough.
      if (r.strandedShares * 10_000n > r.deskSharesBought) {
        bad(`a clean zap left ${wad(r.strandedShares)} fSHARE behind, more than dust`);
      }
    } else {
      bad("no position came back from the zap");
    }
    console.log(`  netOI after ${await netOI(plan0.assetId)}`);

    console.log("\n  and into a range entirely above spot, which needs no fSHARE at all:");
    const oneSided = await zapUsdgIntoQuotePool({ account: WHO, pool: target, usdgIn: 2_000_000n, ...R.above });
    showResult(`entirely above spot, ${target.launch.symbol}, Live`, oneSided);
    if (!oneSided.ok) bad("the one sided zap should have gone through");
    if (oneSided.deskSharesBought !== 0n) bad("a range above spot should not have touched the Desk");

    await rpc("evm_revert", [snap]);
  }

  // -- 6. the OI cap, told apart from settle-only -------------------------
  console.log("\n6. the OI cap refusal, same market, Live");
  {
    const snap = await rpc("evm_snapshot", []);
    await setLive(plan0.assetId);
    const l = await getListing(plan0.assetId);
    const oi = await netOI(plan0.assetId);
    const px = (await oracleQuote(plan0.assetId)).price;
    const used = (oi < 0n ? -oi : oi) * px / 10n ** 20n;
    console.log(`  oiCapQuote ${usd(l.oiCapQuote)}, netOI ${oi} which is ${usd(used)} of notional`);
    // Entirely below spot puts the whole input through the Desk, so clearing
    // the remaining headroom takes only a big enough number.
    const oversize = (l.oiCapQuote - used) * 3n;
    console.log(`  zapping ${usd(oversize)} into a range entirely below spot, all of it through the Desk`);
    const r = await zapUsdgIntoQuotePool({ account: WHO, pool: target, usdgIn: oversize, ...R.below });
    showResult("entirely below spot, oversized", r);
    if (r.ok || !/open-interest cap/.test(r.error ?? "")) bad("expected an open-interest cap refusal");
    if (r.balances.before.usdg !== r.balances.after.usdg) bad("a refused zap still spent USDG");
    await rpc("evm_revert", [snap]);
  }

  // -- 7. the hazard itself -----------------------------------------------
  console.log(
    "\n7. the hazard this is documented as carrying. The split is derived from the\n"
      + "   pool snapshot the caller hands in. Move the pool after that snapshot and\n"
      + "   the mint no longer fits, with the Desk's fSHARE already bought.",
  );
  {
    const snap = await rpc("evm_snapshot", []);
    await setLive(plan0.assetId);
    const route = await routeFor(target.launch.token);
    if ("error" in route) {
      bad(`could not build a route to move the pool: ${route.error}`);
    } else {
      // A real trade through the graduated route, which crosses this very
      // quote pool, so the snapshot below is genuinely out of date.
      await waitFor(await buyGraduated(WHO, route, 20_000_000n, 0n));
      const moved = (await lpPools()).pools.find((p) => p.poolId === target.poolId)!;
      console.log(`  pool tick ${target.tick} -> ${moved.tick} after a $20 buy through it`);

      // `target` is the STALE snapshot, on purpose.
      const stale = await zapUsdgIntoQuotePool({ account: WHO, pool: target, usdgIn: 5_000_000n, ...R.straddling });
      showResult("stale snapshot", stale);
      if (stale.strandedShares > 0n) {
        const back = await unwindZapShares(WHO, plan0, stale.strandedShares);
        console.log(
          `  recovered: sold ${wad(stale.strandedShares)} f${plan0.ticker} back to the Desk for `
            + `${usd(back.usdgOut)}, tx ${back.hash}`,
        );
        if (back.usdgOut <= 0n) bad("the recovery sale returned nothing");
      } else {
        console.log("  the mint absorbed the move, so nothing was stranded this time");
      }
    }
    await rpc("evm_revert", [snap]);
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
} catch (e) {
  failures++;
  console.error("\nfork run threw:", e);
} finally {
  stopFork();
}

process.exit(failures === 0 ? 0 : 1);
