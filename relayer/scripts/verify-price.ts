/**
 * Price-consistency verification: launch a Frogana via the indexer's
 * /dev/launch (the exact UI path), buy in stages through the curve, let
 * auto-graduation fire, then compare what the indexer reports (trade tape,
 * lastTradePrice) against the on-chain spot and index.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import BN from "bn.js";

const RPC = "http://127.0.0.1:8899";
const API = "http://127.0.0.1:8787";
const IDL_PATH = new URL("../../target/idl/floorlaunch.json", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sol = (l: number) => (l / LAMPORTS_PER_SOL).toFixed(4);

async function main() {
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8")))
  );
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
  const program = new anchor.Program(idl, provider);

  // 1. Launch through the indexer, exactly as the UI does.
  const launchRes = await fetch(`${API}/dev/launch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      identifier: "magiceden:froganas",
      meta: {
        name: "Frogana Floor",
        ticker: "flFROG",
        description: "price verification",
        launchedBy: admin.publicKey.toBase58(),
        links: {},
      },
    }),
  });
  const launch = await launchRes.json();
  if (!launchRes.ok) throw new Error(`launch failed: ${JSON.stringify(launch)}`);
  const marketPda = new PublicKey(launch.market);
  console.log(`launched market ${launch.market}`);
  await sleep(3000);

  let m: any = await (program.account as any).market.fetch(marketPda);
  const index = Number(m.indexTwap);
  const openSpot =
    (Number(m.curveVirtualSol) / Number(m.curveVirtualTokens)) * 1e12;
  console.log(`scaled index: ${sol(index)} SOL/unit (expect 0.6250, the migration price)`);
  console.log(`curve open:   ${sol(openSpot)} SOL/unit (expect 0.0250 = 25 SOL MC on 1B supply)`);

  const mintPda = new PublicKey(m.synthMint);
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketPda.toBuffer()],
    program.programId
  );
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), marketPda.toBuffer()],
    program.programId
  );
  const userAta = anchor.utils.token.associatedAddress({ mint: mintPda, owner: admin.publicKey });

  // 2. Staged buys: 30 + 30 + 45 SOL (crosses the 100 SOL target on the
  // third), so migration happens with 100+ SOL in the pool.
  for (const amt of [30, 30, 45]) {
    await program.methods
      .curveBuy(new BN(amt).mul(new BN(LAMPORTS_PER_SOL)), new BN(0))
      .accountsPartial({ market: marketPda, synthMint: mintPda, solVault: vaultPda, user: admin.publicKey, userAta })
      .rpc();
    m = await (program.account as any).market.fetch(marketPda);
    const spot = (Number(m.curveVirtualSol) / Number(m.curveVirtualTokens)) * 1e12;
    console.log(`bought ${amt} SOL -> on-chain curve spot ${sol(spot)} SOL/unit, raised ${sol(Number(m.curveSolRaised))}`);
    await sleep(1500);
  }

  // 3. Wait for auto-graduation, then one AMM buy.
  for (let i = 0; i < 30; i++) {
    m = await (program.account as any).market.fetch(marketPda);
    if ("live" in m.status) break;
    await sleep(2000);
  }
  if (!("live" in m.status)) throw new Error("auto-graduation did not fire");
  console.log(`auto-graduated. AMM ${sol(Number(m.ammSolReserve))} SOL / ${(Number(m.ammTokenReserve) / 1e6).toFixed(0)} tokens`);

  await program.methods
    .ammBuy(new BN(LAMPORTS_PER_SOL), new BN(0))
    .accountsPartial({ market: marketPda, synthMint: mintPda, poolToken: poolPda, solVault: vaultPda, user: admin.publicKey, userAta })
    .rpc();
  await sleep(3000);

  // 4. Compare indexer view vs chain.
  m = await (program.account as any).market.fetch(marketPda);
  const chainSpot = (Number(m.ammSolReserve) / Number(m.ammTokenReserve)) * 1e12;
  const trades = await (await fetch(`${API}/trades/${launch.market}?limit=10`)).json();
  const markets = await (await fetch(`${API}/markets`)).json();
  const mk = markets.find((x: any) => x.market === launch.market);

  console.log(`\n== consistency check ==`);
  console.log(`on-chain AMM spot:      ${sol(chainSpot)} SOL/unit`);
  console.log(`on-chain index:         ${sol(Number(m.indexTwap))} SOL/unit`);
  console.log(`premium:                ${(((chainSpot / Number(m.indexTwap)) - 1) * 100).toFixed(2)}%`);
  console.log(`indexer trade tape (newest first):`);
  for (const t of trades.slice(0, 6)) {
    console.log(`  ${t.phase} ${t.side} ${t.solAmount} SOL -> price ${(t.priceSol * 1e6).toFixed(4)} SOL/unit`);
  }
  const last = trades[0];
  const lastPerUnit = last.priceSol * 1e6;
  const drift = Math.abs(lastPerUnit - chainSpot / LAMPORTS_PER_SOL) / (chainSpot / LAMPORTS_PER_SOL);
  console.log(`tape-vs-chain drift:    ${(drift * 100).toFixed(3)}% ${drift < 0.005 ? "PASS" : "FAIL"}`);
  const prem = (lastPerUnit * LAMPORTS_PER_SOL) / Number(m.indexTwap) - 1;
  console.log(`displayed premium:      ${(prem * 100).toFixed(2)}% ${Math.abs(prem) < 0.25 ? "PASS (near index)" : "FAIL"}`);
  console.log(`indexer lastTradePrice/markPerToken fields: mark ${mk?.markPerToken}, indexPerToken ${mk?.indexPerToken}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
