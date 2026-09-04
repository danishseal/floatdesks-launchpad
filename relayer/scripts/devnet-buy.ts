import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import BN from "bn.js";

const MARKET = "FKBB8yEbsBW6BmWq1cJoDocKxySwJGVrrCZeKemAY1Y7";
async function main() {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))));
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
  const program = new anchor.Program(JSON.parse(readFileSync(`${homedir()}/floorlaunch/target/idl/floorlaunch.json`, "utf8")), provider);
  const marketPda = new PublicKey(MARKET);
  const m: any = await (program.account as any).market.fetch(marketPda);
  const mintPda = new PublicKey(m.synthMint);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), marketPda.toBuffer()], program.programId);
  const userAta = anchor.utils.token.associatedAddress({ mint: mintPda, owner: admin.publicKey });
  const sig = await program.methods
    .curveBuy(new BN(0.25 * LAMPORTS_PER_SOL), new BN(0))
    .accountsPartial({ market: marketPda, synthMint: mintPda, solVault: vaultPda, user: admin.publicKey, userAta })
    .rpc();
  console.log("buy tx:", sig);
  const after: any = await (program.account as any).market.fetch(marketPda);
  const spot = (Number(after.curveVirtualSol) / Number(after.curveVirtualTokens)) * 1e12;
  console.log(`curve spot after: ${spot.toFixed(6)} SOL/unit, raised ${(Number(after.curveSolRaised) / 1e9).toFixed(4)} SOL`);
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
