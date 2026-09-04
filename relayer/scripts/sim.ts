/**
 * Live market simulator for frontend development.
 *
 * Sets up the Mad Lads market on a local validator (real Magic Eden index),
 * then trades it continuously with a handful of wallets so the indexer and
 * chart have organic-looking data: random-walk flow with momentum, periodic
 * oracle pushes drifting around the real floor, and funding cranks.
 */
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { estimateNftIndex } from "../src/sources/magiceden.js";
import { makePusher, pushIndex } from "../src/push.js";
import { NftMarketConfig, RelayerConfig } from "../src/types.js";

const RPC = "http://127.0.0.1:8899";
const PROGRAM_ID = "QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM";
const IDL_PATH = new URL("../../target/idl/floorlaunch.json", import.meta.url).pathname;
const SYMBOL = "mad_lads";
const BASE_UNITS_PER_NFT = 1_000_000_000_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

async function main() {
  const nftCfg: NftMarketConfig = {
    kind: "nft", market: "", symbol: SYMBOL,
    lookbackDays: 3, minSales: 5, maxDisagreementBps: 2500,
  };
  const est = await estimateNftIndex(nftCfg);
  if (!est) throw new Error("estimator gated");
  const baseIndex = est.estimateLamports;
  console.log(`live ${SYMBOL} index: ${(baseIndex / 1e9).toFixed(3)} SOL`);

  const connection = new Connection(RPC, "processed");
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8")))
  );
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
    commitment: "processed",
    preflightCommitment: "processed",
    skipPreflight: true,
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
  idl.address = PROGRAM_ID;
  const program = new anchor.Program(idl, provider);
  const programId = new PublicKey(PROGRAM_ID);

  mkdirSync(new URL("../keys", import.meta.url).pathname, { recursive: true });
  const oracleKeyPath = new URL("../keys/oracle-sim.json", import.meta.url).pathname;
  let oracle: Keypair;
  try {
    oracle = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(oracleKeyPath, "utf8")))
    );
  } catch {
    oracle = Keypair.generate();
    writeFileSync(oracleKeyPath, JSON.stringify([...oracle.secretKey]));
  }

  const traders = Array.from({ length: 4 }, () => Keypair.generate());
  for (const kp of [admin.publicKey, oracle.publicKey, ...traders.map((t) => t.publicKey)]) {
    const sig = await connection.requestAirdrop(kp, 500 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
  }

  const collection = new PublicKey(createHash("sha256").update(`magiceden:${SYMBOL}`).digest());
  const [globalPda] = PublicKey.findProgramAddressSync([Buffer.from("global")], programId);
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), collection.toBuffer()], programId
  );

  const vSol = 100n * BigInt(LAMPORTS_PER_SOL);
  const vTok = (vSol * BASE_UNITS_PER_NFT) / BigInt(baseIndex);
  const params = {
    indexWindowSecs: 30, minPushIntervalSecs: 0, breakerBps: 3000,
    maxIndexAgeSecs: 3600, markWindowSecs: 60, fundingKBps: 10000,
    maxFundingBpsPerDay: 10000, minCrankIntervalSecs: 1,
    initialCrBps: 15000, maintenanceCrBps: 12000, liqBonusBps: 500,
    maxOpenInterest: new BN("100000000000000"),
    curveFeeBps: 70, ammFeeBps: 70,
    graduationTargetSol: new BN(10).mul(new BN(LAMPORTS_PER_SOL)),
    insuranceShareBps: 1000,
    curveVirtualSol: new BN(vSol.toString()),
    curveVirtualTokens: new BN(vTok.toString()),
  };

  const existing = await (program.account as any).market.fetchNullable(marketPda);
  const isFresh = !existing;
  if (isFresh) {
    await program.methods.initGlobal(oracle.publicKey, params)
      .accountsPartial({ global: globalPda, admin: admin.publicKey }).rpc();
    await program.methods.createMarket(collection, null)
      .accountsPartial({ global: globalPda, admin: admin.publicKey, market: marketPda }).rpc();
  } else {
    // Resuming: rotate only if the stored key does not match on chain.
    const g0: any = await (program.account as any).global.fetch(globalPda);
    if (!g0.oracleAuthority.equals(oracle.publicKey)) {
      await program.methods.setOracleAuthority(oracle.publicKey)
        .accountsPartial({ global: globalPda, admin: admin.publicKey }).rpc();
      for (let i = 0; i < 120; i++) {
        const g: any = await (program.account as any).global.fetch(globalPda);
        if (g.oracleAuthority.equals(oracle.publicKey)) break;
        await sleep(500);
      }
    }
  }
  console.log(`market ${marketPda.toBase58()} (${isFresh ? "fresh" : "resumed"})`);

  const relayerCfg: RelayerConfig = {
    rpcUrl: RPC, programId: PROGRAM_ID, oracleKeypair: oracleKeyPath,
    idlPath: IDL_PATH, intervalSecs: 3600,
    markets: [{ ...nftCfg, market: marketPda.toBase58() }],
  };
  const pusher = makePusher(relayerCfg);
  await pushIndex(pusher, marketPda.toBase58(), baseIndex);

  // A resumed market can still be pre-graduation (e.g. after a validator
  // state rollback); treat it like a fresh launch so trading can start.
  const mNow: any = await (program.account as any).market.fetch(marketPda);
  const needsLaunch = isFresh || "bootstrap" in mNow.status;
  if (needsLaunch) {
    // Launch: several wallets buy through the curve, then graduate.
    const buyCurve = (kp: Keypair, sol: number) =>
      program.methods.curveBuy(new BN(Math.floor(sol * LAMPORTS_PER_SOL)), new BN(0))
        .accountsPartial({ market: marketPda, user: kp.publicKey })
        .signers([kp]).rpc();
    for (const [i, t] of traders.entries()) await buyCurve(t, 2.5 + i);
    await program.methods.graduate().accountsPartial({ market: marketPda }).rpc();
  }
  console.log("entering live trading loop");

  // Live loop.
  let drift = 0;          // index random walk, bps from base
  let sentiment = 0;      // trade-flow momentum in [-1, 1]
  let lastPush = 0, lastCrank = 0;
  const tokBal = async (kp: Keypair) => {
    const mint = PublicKey.findProgramAddressSync(
      [Buffer.from("mint"), marketPda.toBuffer()], programId)[0];
    const ata = anchor.utils.token.associatedAddress({ mint, owner: kp.publicKey });
    try {
      return Number((await connection.getTokenAccountBalance(ata)).value.amount);
    } catch { return 0; }
  };

  let pushFailures = 0;
  let tradeFailures = 0;
  while (true) {
    // Oracle first and independently: a failing trade path must never
    // starve the price feed (a real bug: a dead websocket made every
    // trade confirm time out and the push after it never ran for hours).
    const now = Date.now();
    if (now - lastPush > 9000) {
      try {
        drift = Math.max(-150, Math.min(150, drift + rand(-25, 25)));
        await pushIndex(pusher, marketPda.toBase58(),
          Math.floor(baseIndex * (1 + drift / 10000)));
        lastPush = now;
        pushFailures = 0;
      } catch (e: any) {
        pushFailures++;
        console.error("push error:", e.message?.slice(0, 100));
      }
    }
    if (now - lastCrank > 15000) {
      try {
        await program.methods.accrueFunding()
          .accountsPartial({ market: marketPda }).rpc();
        lastCrank = now;
      } catch {}
    }
    try {
      sentiment = Math.max(-1, Math.min(1, sentiment + rand(-0.3, 0.3)));
      const kp = traders[Math.floor(Math.random() * traders.length)];
      const mAcc: any = await (program.account as any).market.fetch(marketPda);
      const priceUnit =
        (Number(mAcc.ammSolReserve) * 1e12) / Number(mAcc.ammTokenReserve) / 1e9;
      const indexUnit = Number(mAcc.indexTwap) / 1e9;
      const gap = (indexUnit - priceUnit) / indexUnit;
      const buyBias = Math.max(0.15, Math.min(0.85, 0.5 + gap * 4 + sentiment * 0.12));
      if (Math.random() < buyBias) {
        await program.methods
          .ammBuy(new BN(Math.floor(rand(0.02, 0.16) * LAMPORTS_PER_SOL)), new BN(0))
          .accountsPartial({ market: marketPda, user: kp.publicKey })
          .signers([kp]).rpc();
      } else {
        const bal = await tokBal(kp);
        if (bal > 1_000_000) {
          await program.methods
            .ammSell(new BN(Math.floor(bal * rand(0.02, 0.12))), new BN(0))
            .accountsPartial({ market: marketPda, user: kp.publicKey })
            .signers([kp]).rpc();
        }
      }
      tradeFailures = 0;
    } catch (e: any) {
      tradeFailures++;
      console.error("sim tick error:", e.message?.slice(0, 120));
    }
    // A run of failures means this process's RPC/websocket connection has
    // gone bad; exit and let the supervisor relaunch with a fresh one
    // (the resume path re-attaches to the existing market).
    if (pushFailures >= 4 || tradeFailures >= 3) {
      console.error("too many consecutive failures; exiting for supervisor restart");
      process.exit(2);
    }
    await sleep(rand(350, 900));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
