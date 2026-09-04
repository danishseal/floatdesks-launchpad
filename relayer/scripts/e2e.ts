/**
 * End-to-end rehearsal against a REAL underlying.
 *
 * Pulls live Mad Lads market data from Magic Eden (mainnet), then runs the
 * entire protocol lifecycle on a local validator: market creation, oracle
 * push through the real relayer code path, curve launch, graduation, AMM
 * trading, a hedger short, and a funding crank.
 *
 * Prereq: solana-test-validator running on 127.0.0.1:8899 with the
 * floorlaunch program loaded.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { estimateNftIndex } from "../src/sources/magiceden.js";
import { makePusher, pushIndex } from "../src/push.js";
import { NftMarketConfig, RelayerConfig } from "../src/types.js";

import BN from "bn.js";
const RPC = "http://127.0.0.1:8899";
const PROGRAM_ID = "QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM";
const IDL_PATH = new URL("../../target/idl/floorlaunch.json", import.meta.url)
  .pathname;
const SYMBOL = "mad_lads";
const BASE_UNITS_PER_NFT = 1_000_000_000_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports: number | bigint) =>
  (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);

async function main() {
  // 1. Real market data from mainnet.
  const nftCfg: NftMarketConfig = {
    kind: "nft",
    market: "",
    symbol: SYMBOL,
    lookbackDays: 3,
    minSales: 5,
    maxDisagreementBps: 2500,
  };
  const est = await estimateNftIndex(nftCfg);
  if (!est) throw new Error("estimator gated the live data; cannot proceed");
  console.log(`\n== live underlying: ${SYMBOL} ==`);
  console.log(`listed floor (ask):   ${sol(est.referenceAskLamports!)} SOL`);
  console.log(
    `sale estimate:        ${sol(est.estimateLamports)} SOL ` +
      `(${est.salesUsed} sales used, ${est.salesDropped} outliers dropped, ` +
      `deviation vs ask ${est.deviationBps} bps)`
  );
  const indexLamports = est.estimateLamports;

  // 2. Local chain setup.
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
  const oracleKeyPath = new URL("../keys/oracle-e2e.json", import.meta.url)
    .pathname;
  writeFileSync(oracleKeyPath, JSON.stringify([...oracle.secretKey]));
  for (const kp of [admin.publicKey, oracle.publicKey]) {
    const sig = await connection.requestAirdrop(kp, 100 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
  }

  // Collection identifier: deterministic key from the ME symbol.
  const collection = new PublicKey(
    createHash("sha256").update(`magiceden:${SYMBOL}`).digest()
  );
  const [globalPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    programId
  );
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), collection.toBuffer()],
    programId
  );
  const [mintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), marketPda.toBuffer()],
    programId
  );
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), marketPda.toBuffer()],
    programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketPda.toBuffer()],
    programId
  );
  const [shortPos] = PublicKey.findProgramAddressSync(
    [Buffer.from("short"), marketPda.toBuffer(), admin.publicKey.toBuffer()],
    programId
  );

  // Curve virtuals sized so the launch price opens at the live index.
  const vSol = 100n * BigInt(LAMPORTS_PER_SOL);
  const vTok = (vSol * BASE_UNITS_PER_NFT) / BigInt(indexLamports);
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

  console.log(`\n== local chain setup ==`);
  await program.methods
    .initGlobal(oracle.publicKey, params)
    .accountsPartial({ global: globalPda, admin: admin.publicKey })
    .rpc();
  await program.methods
    .createMarket(collection, null)
    .accountsPartial({
      global: globalPda,
      admin: admin.publicKey,
      market: marketPda,
      synthMint: mintPda,
      poolToken: poolPda,
      solVault: vaultPda,
    })
    .rpc();
  console.log(`market:     ${marketPda.toBase58()}`);
  console.log(`collection: ${collection.toBase58()} (id for "${SYMBOL}")`);
  console.log(`oracle:     ${oracle.publicKey.toBase58()}`);

  // 3. Push the live price through the real relayer code path.
  const relayerCfg: RelayerConfig = {
    rpcUrl: RPC,
    programId: PROGRAM_ID,
    oracleKeypair: oracleKeyPath,
    idlPath: IDL_PATH,
    intervalSecs: 3600,
    markets: [{ ...nftCfg, market: marketPda.toBase58() }],
  };
  const pusher = makePusher(relayerCfg);
  await pushIndex(pusher, marketPda.toBase58(), indexLamports);
  let m: any = await (program.account as any).market.fetch(marketPda);
  console.log(`\n== oracle push (live Magic Eden data) ==`);
  console.log(`on-chain index TWAP:  ${sol(m.indexTwap.toNumber())} SOL per NFT`);

  // 4. Launch: buy through the curve to the graduation target, graduate.
  const userAta = anchor.utils.token.associatedAddress({
    mint: mintPda,
    owner: admin.publicKey,
  });
  await program.methods
    .curveBuy(new BN(11).mul(new BN(LAMPORTS_PER_SOL)), new BN(0))
    .accountsPartial({
      market: marketPda,
      synthMint: mintPda,
      solVault: vaultPda,
      user: admin.publicKey,
      userAta,
    })
    .rpc();
  await program.methods
    .graduate()
    .accountsPartial({ market: marketPda, synthMint: mintPda, poolToken: poolPda })
    .rpc();
  m = await (program.account as any).market.fetch(marketPda);
  console.log(`\n== launch ==`);
  console.log(`curve raised:         ${sol(m.curveSolRaised.toNumber())} SOL`);
  console.log(`insurance fund:       ${sol(m.insuranceLamports.toNumber())} SOL`);
  console.log(`AMM reserves:         ${sol(m.ammSolReserve.toNumber())} SOL / ${(m.ammTokenReserve.toNumber() / 1e6).toFixed(0)} tokens`);

  // 5. Live phase: AMM trade, hedger short, funding crank.
  await program.methods
    .ammBuy(new BN(1).mul(new BN(LAMPORTS_PER_SOL)), new BN(0))
    .accountsPartial({
      market: marketPda,
      synthMint: mintPda,
      poolToken: poolPda,
      solVault: vaultPda,
      user: admin.publicKey,
      userAta,
    })
    .rpc();

  // A hedger shorts ~1 SOL of floor exposure at 3 SOL collateral.
  const mintAmount = new BN(
    ((1n * BigInt(LAMPORTS_PER_SOL) * BASE_UNITS_PER_NFT) /
      BigInt(indexLamports)).toString()
  );
  await program.methods
    .openShort(new BN(3).mul(new BN(LAMPORTS_PER_SOL)), mintAmount)
    .accountsPartial({
      market: marketPda,
      synthMint: mintPda,
      solVault: vaultPda,
      position: shortPos,
      owner: admin.publicKey,
      ownerAta: userAta,
    })
    .rpc();

  await sleep(2500);
  await pushIndex(pusher, marketPda.toBase58(), indexLamports);
  await program.methods
    .accrueFunding()
    .accountsPartial({ market: marketPda })
    .rpc();

  m = await (program.account as any).market.fetch(marketPda);
  const pos: any = await (program.account as any).shortPosition.fetch(shortPos);
  const mark = m.markEma.toNumber();
  const index = m.indexTwap.toNumber();
  const premiumBps = Math.round(((mark - index) / index) * 10_000);
  const debt =
    (BigInt(pos.debtScaled.toString()) * BigInt(m.fundingIndex.toString())) /
    1_000_000_000_000n;
  const debtValue = (debt * BigInt(index)) / BASE_UNITS_PER_NFT;
  const cr = Number((BigInt(pos.collateral.toString()) * 10_000n) / debtValue) / 100;

  console.log(`\n== live market state ==`);
  console.log(`index (Mad Lads):     ${sol(index)} SOL per NFT`);
  console.log(`AMM mark EMA:         ${sol(mark)} SOL per NFT`);
  console.log(`premium:              ${premiumBps} bps`);
  console.log(`funding index:        ${m.fundingIndex.toString()} (1e12 = par)`);
  console.log(`short debt:           ${(Number(debt) / 1e6).toFixed(2)} tokens (${sol(debtValue)} SOL at index)`);
  console.log(`short collateral:     ${sol(pos.collateral.toNumber())} SOL, CR ${cr.toFixed(1)}%`);
  console.log(`\ne2e complete: full lifecycle ran against live ${SYMBOL} data.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
