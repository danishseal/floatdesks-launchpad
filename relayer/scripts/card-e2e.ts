/**
 * Live card-pipeline test: prices a REAL collectible (Umbreon VMAX Alt
 * Art, swsh7-215, raw) from pokemontcg.io TCGplayer market data, converts
 * through live Pyth SOL/USD, and pushes it into a local market through the
 * real relayer cycle.
 *
 * Prereq: fresh solana-test-validator on 127.0.0.1:8899 with the program.
 */
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { CardMarketConfig, RelayerConfig } from "../src/types.js";
import { fetchCardUsd, estimateCardIndex } from "../src/sources/card.js";
import { fetchSolUsd } from "../src/sources/pyth.js";
import { makePusher } from "../src/push.js";
import { runCycle } from "../src/main.js";

const RPC = "http://127.0.0.1:8899";
const PROGRAM_ID = "QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM";
const IDL_PATH = new URL("../../target/idl/floorlaunch.json", import.meta.url)
  .pathname;
const BASE_UNITS_PER_NFT = 1_000_000_000_000n;

async function main() {
  const cardCfg: CardMarketConfig = {
    kind: "card",
    market: "",
    name: "Umbreon VMAX Alt Art",
    grade: "RAW",
    source: "pokemontcg",
    cardId: "swsh7-215",
    variant: "holofoil",
    lookbackDays: 14,
    minSales: 5,
    maxDisagreementBps: 1500,
  };

  const [usd, solUsd] = await Promise.all([fetchCardUsd(cardCfg), fetchSolUsd()]);
  const est = await estimateCardIndex(cardCfg);
  if (!est) throw new Error("card estimate gated");
  console.log(`\n== live underlying: ${cardCfg.name} (${cardCfg.grade}) ==`);
  console.log(`TCGplayer market:     $${usd}`);
  console.log(`Pyth SOL/USD:         $${solUsd.toFixed(2)}`);
  console.log(
    `index:                ${(est.estimateLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL per card`
  );

  const connection = new Connection(RPC, "confirmed");
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))
    )
  );
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(admin),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
  idl.address = PROGRAM_ID;
  const program = new anchor.Program(idl, provider);
  const programId = new PublicKey(PROGRAM_ID);

  const oracle = Keypair.generate();
  mkdirSync(new URL("../keys", import.meta.url).pathname, { recursive: true });
  const oracleKeyPath = new URL("../keys/oracle-card-e2e.json", import.meta.url)
    .pathname;
  writeFileSync(oracleKeyPath, JSON.stringify([...oracle.secretKey]));
  for (const kp of [admin.publicKey, oracle.publicKey]) {
    const sig = await connection.requestAirdrop(kp, 100 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
  }

  const collection = new PublicKey(
    createHash("sha256").update(`pokemontcg:${cardCfg.cardId}:RAW`).digest()
  );
  const [globalPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    programId
  );
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), collection.toBuffer()],
    programId
  );

  const vSol = 100n * BigInt(LAMPORTS_PER_SOL);
  const vTok = (vSol * BASE_UNITS_PER_NFT) / BigInt(est.estimateLamports);
  const params = {
    indexWindowSecs: 30,
    minPushIntervalSecs: 0,
    breakerBps: 3000,
    maxIndexAgeSecs: 3600,
    markWindowSecs: 30,
    fundingKBps: 10000,
    maxFundingBpsPerDay: 10000,
    minCrankIntervalSecs: 1,
    initialCrBps: 15000,
    maintenanceCrBps: 12000,
    liqBonusBps: 500,
    maxOpenInterest: new BN("1000000000000000"),
    curveFeeBps: 100,
    ammFeeBps: 100,
    graduationTargetSol: new BN(10).mul(new BN(LAMPORTS_PER_SOL)),
    insuranceShareBps: 1000,
    curveVirtualSol: new BN(vSol.toString()),
    curveVirtualTokens: new BN(vTok.toString()),
  };

  await program.methods
    .initGlobal(oracle.publicKey, params)
    .accountsPartial({ global: globalPda, admin: admin.publicKey })
    .rpc();
  await program.methods
    .createMarket(collection, null)
    .accountsPartial({ global: globalPda, admin: admin.publicKey, market: marketPda })
    .rpc();
  console.log(`\nmarket: ${marketPda.toBase58()} (id ${collection.toBase58().slice(0, 8)}..)`);

  // Push through the production relayer cycle.
  const relayerCfg: RelayerConfig = {
    rpcUrl: RPC,
    programId: PROGRAM_ID,
    oracleKeypair: oracleKeyPath,
    idlPath: IDL_PATH,
    intervalSecs: 3600,
    markets: [{ ...cardCfg, market: marketPda.toBase58() }],
  };
  await runCycle(relayerCfg, makePusher(relayerCfg));

  const m: any = await (program.account as any).market.fetch(marketPda);
  const twap = m.indexTwap.toNumber();
  console.log(`\non-chain index TWAP:  ${(twap / LAMPORTS_PER_SOL).toFixed(4)} SOL per card`);
  const impliedUsd = (twap / LAMPORTS_PER_SOL) * solUsd;
  console.log(`implied USD:          $${impliedUsd.toFixed(2)} (source $${usd})`);
  if (Math.abs(impliedUsd - usd) / usd > 0.01) {
    throw new Error("on-chain index deviates >1% from source price");
  }
  console.log(`\ncard e2e complete: live collectible price is on chain.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
