/**
 * Program transaction builders. All instruction accounts resolve from the
 * market PDA and the connected wallet; amounts arrive in UI units and are
 * converted here.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import idl from "./idl.json";

const PROGRAM_ID = new PublicKey((idl as any).address);
const LAMPORTS = 1e9;
const TOKEN_BASE = 1e6; // 6 decimals

export interface TxResult {
  sig: string;
}

function program(provider: anchor.AnchorProvider): anchor.Program {
  return new anchor.Program(idl as any, provider);
}

export function pdas(market: PublicKey, owner?: PublicKey) {
  const [mint] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), market.toBuffer()],
    PROGRAM_ID
  );
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), market.toBuffer()],
    PROGRAM_ID
  );
  const [treasury] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), market.toBuffer()],
    PROGRAM_ID
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()],
    PROGRAM_ID
  );
  const [itemReserve] = PublicKey.findProgramAddressSync(
    [Buffer.from("items"), market.toBuffer()],
    PROGRAM_ID
  );
  const short = owner
    ? PublicKey.findProgramAddressSync(
        [Buffer.from("short"), market.toBuffer(), owner.toBuffer()],
        PROGRAM_ID
      )[0]
    : undefined;
  return { mint, pool, treasury, vault, itemReserve, short };
}

export function itemRegistration(market: PublicKey, itemMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("item"), market.toBuffer(), itemMint.toBuffer()],
    PROGRAM_ID
  )[0];
}

export async function depositItem(
  provider: anchor.AnchorProvider,
  market: string,
  itemMint: string
): Promise<TxResult> {
  const m = new PublicKey(market);
  const im = new PublicKey(itemMint);
  const p = pdas(m);
  const sig = await program(provider)
    .methods.depositItem()
    .accountsPartial({
      market: m,
      itemMint: im,
      registration: itemRegistration(m, im),
      itemReserve: p.itemReserve,
      user: provider.wallet.publicKey,
      synthMint: p.mint,
    })
    .rpc();
  return { sig };
}

export async function withdrawItem(
  provider: anchor.AnchorProvider,
  market: string,
  itemMint: string
): Promise<TxResult> {
  const m = new PublicKey(market);
  const im = new PublicKey(itemMint);
  const p = pdas(m);
  const sig = await program(provider)
    .methods.withdrawItem()
    .accountsPartial({
      market: m,
      itemMint: im,
      registration: itemRegistration(m, im),
      itemReserve: p.itemReserve,
      user: provider.wallet.publicKey,
      synthMint: p.mint,
    })
    .rpc();
  return { sig };
}

export async function curveBuy(
  provider: anchor.AnchorProvider,
  market: string,
  solIn: number,
  minTokensOut: number
): Promise<TxResult> {
  const m = new PublicKey(market);
  const p = pdas(m);
  const sig = await program(provider)
    .methods.curveBuy(
      new BN(Math.floor(solIn * LAMPORTS)),
      new BN(Math.floor(minTokensOut * TOKEN_BASE))
    )
    .accountsPartial({
      market: m,
      synthMint: p.mint,
      poolToken: p.pool,
      solVault: p.vault,
      user: provider.wallet.publicKey,
    })
    .rpc();
  return { sig };
}

export async function curveSell(
  provider: anchor.AnchorProvider,
  market: string,
  tokensIn: number,
  minSolOut: number
): Promise<TxResult> {
  const m = new PublicKey(market);
  const p = pdas(m);
  const sig = await program(provider)
    .methods.curveSell(
      new BN(Math.floor(tokensIn * TOKEN_BASE)),
      new BN(Math.floor(minSolOut * LAMPORTS))
    )
    .accountsPartial({
      market: m,
      synthMint: p.mint,
      poolToken: p.pool,
      solVault: p.vault,
      user: provider.wallet.publicKey,
    })
    .rpc();
  return { sig };
}

export async function graduate(
  provider: anchor.AnchorProvider,
  market: string
): Promise<TxResult> {
  const m = new PublicKey(market);
  const p = pdas(m);
  const sig = await program(provider)
    .methods.graduate()
    .accountsPartial({ market: m, synthMint: p.mint, poolToken: p.pool })
    .rpc();
  return { sig };
}

export async function ammBuy(
  provider: anchor.AnchorProvider,
  market: string,
  solIn: number,
  minTokensOut: number
): Promise<TxResult> {
  const m = new PublicKey(market);
  const p = pdas(m);
  const sig = await program(provider)
    .methods.ammBuy(
      new BN(Math.floor(solIn * LAMPORTS)),
      new BN(Math.floor(minTokensOut * TOKEN_BASE))
    )
    .accountsPartial({
      market: m,
      synthMint: p.mint,
      poolToken: p.pool,
      solVault: p.vault,
      user: provider.wallet.publicKey,
    })
    .rpc();
  return { sig };
}

export async function ammSell(
  provider: anchor.AnchorProvider,
  market: string,
  tokensIn: number,
  minSolOut: number
): Promise<TxResult> {
  const m = new PublicKey(market);
  const p = pdas(m);
  const sig = await program(provider)
    .methods.ammSell(
      new BN(Math.floor(tokensIn * TOKEN_BASE)),
      new BN(Math.floor(minSolOut * LAMPORTS))
    )
    .accountsPartial({
      market: m,
      synthMint: p.mint,
      poolToken: p.pool,
      solVault: p.vault,
      user: provider.wallet.publicKey,
    })
    .rpc();
  return { sig };
}

/**
 * Open (or add to) a cash-settled short hedge. Posts SOL collateral and shorts
 * `sizeTokens` of notional at the current index - no tokens are drawn. PnL
 * settles in SOL at close.
 */
export async function openShort(
  provider: anchor.AnchorProvider,
  market: string,
  collateralSol: number,
  sizeTokens: number
): Promise<TxResult> {
  const m = new PublicKey(market);
  const owner = provider.wallet.publicKey;
  const p = pdas(m, owner);
  const sig = await program(provider)
    .methods.openShort(
      new BN(Math.floor(collateralSol * LAMPORTS)),
      new BN(Math.floor(sizeTokens * TOKEN_BASE))
    )
    .accountsPartial({
      market: m,
      solVault: p.vault,
      position: p.short!,
      owner,
    })
    .rpc();
  return { sig };
}

/** Close a cash-settled short: settle PnL in SOL and return collateral. */
export async function closePosition(
  provider: anchor.AnchorProvider,
  market: string
): Promise<TxResult> {
  const m = new PublicKey(market);
  const owner = provider.wallet.publicKey;
  const p = pdas(m, owner);
  const sig = await program(provider)
    .methods.closePosition()
    .accountsPartial({
      market: m,
      solVault: p.vault,
      position: p.short!,
      owner,
    })
    .rpc();
  return { sig };
}

export interface PositionView {
  tokenBalance: number;
  collateralSol: number;
  debtTokens: number;
  crPct: number | null;
  liqIndexSolPerUnit: number | null;
}

/** Read the wallet's synth balance and short position for a market. */
export async function fetchPosition(
  provider: anchor.AnchorProvider,
  market: string,
  indexPerToken: number,
  fundingIndex: string,
  maintenanceCrBps = 12000,
  synthMint?: string
): Promise<PositionView> {
  const m = new PublicKey(market);
  const owner = provider.wallet.publicKey;
  const p = pdas(m, owner);
  const prog = program(provider);

  let tokenBalance = 0;
  try {
    // External (Meteora) markets trade their own SPL mint, not the
    // ["mint", market] PDA, so use the real synth mint when the caller has it,
    // otherwise the balance read hits a non-existent account and shows 0.
    const mint = synthMint ? new PublicKey(synthMint) : p.mint;
    const ata = anchor.utils.token.associatedAddress({
      mint,
      owner,
    });
    const bal = await provider.connection.getTokenAccountBalance(ata);
    tokenBalance = Number(bal.value.amount) / TOKEN_BASE;
  } catch {}

  let collateralSol = 0;
  let debtTokens = 0;
  try {
    const pos: any = await (prog.account as any).shortPosition.fetch(p.short!);
    collateralSol = Number(pos.collateral) / LAMPORTS;
    debtTokens =
      Number((BigInt(pos.debtScaled.toString()) * BigInt(fundingIndex)) / 1_000_000_000_000n) /
      TOKEN_BASE;
  } catch {}

  // Debt value in SOL at the current index; CR and the index level (SOL
  // per unit) at which the position hits maintenance.
  const debtValueSol = debtTokens * indexPerToken;
  const crPct = debtValueSol > 0 ? (collateralSol / debtValueSol) * 100 : null;
  const debtUnits = debtTokens / TOKEN_BASE;
  const liqIndexSolPerUnit =
    debtUnits > 0
      ? collateralSol / (debtUnits * (maintenanceCrBps / 10000))
      : null;

  return { tokenBalance, collateralSol, debtTokens, crPct, liqIndexSolPerUnit };
}
