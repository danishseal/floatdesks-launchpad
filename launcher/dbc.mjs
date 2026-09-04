/**
 * Meteora DBC launch leg (devnet).
 *
 * One-time: creates the floorlaunch partner config: flat 0.70% trading
 * fee with 50% routed to the pool creator (the launch flow's fee
 * receiver: the launcher's wallet, a custom address, or an identity
 * escrow), migration to DAMM v2, LP split 50/50 partner/creator.
 *
 * Per launch: creates a token pool under that config, with poolCreator =
 * the fee receiver. Verification path: swap, read the fee breakdown,
 * claim creator fees.
 *
 * Usage:
 *   node dbc.mjs config          # create the partner config (once)
 *   node dbc.mjs launch <SYM>    # launch a test token
 *   node dbc.mjs verify <pool>   # swap 0.1 SOL, show fees, claim creator side
 */
import {
  DynamicBondingCurveClient,
  buildCurveWithMarketCap,
  TokenType,
  TokenDecimal,
  TokenAuthorityOption,
  BaseFeeMode,
  CollectFeeMode,
  MigrationOption,
  MigrationFeeOption,
  ActivationType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const RPC = "https://api.devnet.solana.com";
const STATE = new URL("./devnet-dbc.json", import.meta.url).pathname;
const NATIVE_SOL = new PublicKey("So11111111111111111111111111111111111111112");

const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(readFileSync(`${homedir()}/.config/solana/predict-markets-devnet.json`, "utf8"))
  )
);
const connection = new Connection(RPC, "confirmed");
const client = new DynamicBondingCurveClient(connection, "confirmed");

const state = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

async function send(tx, signers, label) {
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, ...signers], {
    commitment: "confirmed",
    skipPreflight: false,
  });
  console.log(`${label}: ${sig}`);
  return sig;
}

async function createConfig() {
  const curve = buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.SPL,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: 70,
          endingFeeBps: 70,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 50,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 25,
      partnerLiquidityPercentage: 25,
      creatorPermanentLockedLiquidityPercentage: 25,
      creatorLiquidityPercentage: 25,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    initialMarketCap: 25,
    migrationMarketCap: 100,
  });

  const configKp = Keypair.generate();
  const tx = await client.partner.createConfig({
    ...curve,
    config: configKp.publicKey,
    feeClaimer: payer.publicKey, // protocol fee wallet (floorlaunch)
    leftoverReceiver: payer.publicKey,
    quoteMint: NATIVE_SOL,
    payer: payer.publicKey,
  });
  await send(tx, [configKp], "createConfig");
  const s = state();
  s.config = configKp.publicKey.toBase58();
  save(s);
  console.log("partner config:", s.config);
}

async function launch(symbol, creatorOverride) {
  const s = state();
  if (!s.config) throw new Error("run `config` first");
  const baseMint = Keypair.generate();
  const poolCreator = creatorOverride ? new PublicKey(creatorOverride) : payer.publicKey;
  const tx = await client.creator.createPool({
    name: `floorlaunch test ${symbol}`,
    symbol,
    uri: "https://floorlaunch.example/meta.json",
    payer: payer.publicKey,
    poolCreator,
    config: new PublicKey(s.config),
    baseMint: baseMint.publicKey,
  });
  await send(tx, [baseMint], "createPool");
  const { deriveDbcPoolAddress } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const pool = deriveDbcPoolAddress(NATIVE_SOL, baseMint.publicKey, new PublicKey(s.config));
  s.lastPool = pool.toBase58();
  s.lastMint = baseMint.publicKey.toBase58();
  s.lastCreator = poolCreator.toBase58();
  save(s);
  console.log("pool:", s.lastPool);
  console.log("mint:", s.lastMint);
  console.log("creator (fee receiver):", s.lastCreator);
}

async function verify(poolAddr) {
  const s = state();
  const pool = new PublicKey(poolAddr ?? s.lastPool);
  const swapTx = await client.pool.swap({
    owner: payer.publicKey,
    pool,
    amountIn: new BN(100_000_000), // 0.1 SOL
    minimumAmountOut: new BN(0),
    swapBaseForQuote: false,
    referralTokenAccount: null,
    payer: payer.publicKey,
  });
  await send(swapTx, [], "swap 0.1 SOL");

  const fees = await client.state.getPoolFeeBreakdown(pool);
  const fmt = (x) => (x ? x.toString() : "0");
  console.log("fee breakdown:", JSON.stringify({
    partnerQuote: fmt(fees?.partner?.unClaimQuoteFee ?? fees?.partnerQuoteFee),
    creatorQuote: fmt(fees?.creator?.unClaimQuoteFee ?? fees?.creatorQuoteFee),
    raw: undefined,
  }));
  try {
    const claimTx = await client.creator.claimCreatorTradingFee({
      creator: payer.publicKey,
      payer: payer.publicKey,
      pool,
      maxBaseAmount: new BN("18446744073709551615"),
      maxQuoteAmount: new BN("18446744073709551615"),
    });
    await send(claimTx, [], "claimCreatorTradingFee");
  } catch (e) {
    console.log("creator claim:", String(e.message).slice(0, 140));
  }
}

const [cmd, arg1, arg2] = process.argv.slice(2);
if (cmd === "config") await createConfig();
else if (cmd === "launch") await launch(arg1 ?? "flTEST", arg2);
else if (cmd === "verify") await verify(arg1);
else console.log("usage: node dbc.mjs config|launch <SYM> [creator]|verify [pool]");
