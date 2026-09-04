import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync } from "node:fs";
import { RelayerConfig } from "./types.js";

export interface Pusher {
  program: anchor.Program;
  oracle: Keypair;
  globalPda: PublicKey;
}

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8")))
  );
}

export function makePusher(cfg: RelayerConfig): Pusher {
  const oracle = loadKeypair(cfg.oracleKeypair);
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(oracle),
    { commitment: "confirmed" }
  );
  const idl = JSON.parse(readFileSync(cfg.idlPath, "utf8"));
  idl.address = cfg.programId;
  const program = new anchor.Program(idl, provider);
  const [globalPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    new PublicKey(cfg.programId)
  );
  return { program, oracle, globalPda };
}

export async function pushIndex(
  pusher: Pusher,
  market: string,
  lamports: number
): Promise<string> {
  return pusher.program.methods
    .pushIndex(new BN(lamports))
    .accountsPartial({
      global: pusher.globalPda,
      oracleAuthority: pusher.oracle.publicKey,
      market: new PublicKey(market),
    })
    .signers([pusher.oracle])
    .rpc();
}

/** External-venue markets: push the mark computed from the external pool. */
export async function pushMark(
  pusher: Pusher,
  market: string,
  lamports: number
): Promise<string> {
  return pusher.program.methods
    .pushMark(new BN(lamports))
    .accountsPartial({
      global: pusher.globalPda,
      oracleAuthority: pusher.oracle.publicKey,
      market: new PublicKey(market),
    })
    .signers([pusher.oracle])
    .rpc();
}
