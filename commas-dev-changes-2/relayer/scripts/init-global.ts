import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const adminPath = process.env.ADMIN_KEY_PATH ?? `${homedir()}/.config/solana/id.json`;
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(adminPath, "utf8"))));
const keyPath = process.env.ORACLE_KEY_PATH ?? new URL("../keys/oracle-sim.json", import.meta.url).pathname;
mkdirSync(new URL("../keys", import.meta.url).pathname, { recursive: true });
let oracle: Keypair;
if (existsSync(keyPath)) oracle = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
else { oracle = Keypair.generate(); writeFileSync(keyPath, JSON.stringify([...oracle.secretKey])); }
const idl = JSON.parse(readFileSync(new URL("../../target/idl/floorlaunch.json", import.meta.url).pathname, "utf8"));
idl.address = "QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM";
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" }));
const [globalPda] = PublicKey.findProgramAddressSync([Buffer.from("global")], new PublicKey(idl.address));
const params = {
  indexWindowSecs: 30, minPushIntervalSecs: 0, breakerBps: 3000, maxIndexAgeSecs: 3600,
  markWindowSecs: 60, fundingKBps: 10000, maxFundingBpsPerDay: 10000, minCrankIntervalSecs: 1,
  initialCrBps: 15000, maintenanceCrBps: 12000, liqBonusBps: 500,
  maxOpenInterest: new BN("400000000000000"), itemReserve: new BN("100000000000000"), unitsPerItemMicro: new BN(1_000_000), curveFeeBps: 70, ammFeeBps: 70,
  graduationTargetSol: new BN(10).mul(new BN(1e9)), insuranceShareBps: 1000,
  curveVirtualSol: new BN(100).mul(new BN(1e9)), curveVirtualTokens: new BN("1000000000000"),
};
await program.methods.initGlobal(oracle.publicKey, params as any)
  .accountsPartial({ global: globalPda, admin: admin.publicKey }).rpc();
console.log("global initialized, oracle:", oracle.publicKey.toBase58());
