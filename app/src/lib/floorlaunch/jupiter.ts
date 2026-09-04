/**
 * Jupiter swap path for external (Meteora DBC) markets.
 *
 * Internal-curve markets trade against the Commas program (curveBuy/ammBuy).
 * Meteora markets trade on a real Meteora pool, so spot buys/sells route through
 * Jupiter, which finds the Meteora route. Same `(provider, ...) => { sig }`
 * shape as the program trade builders so the trade panel can branch cleanly.
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { TxResult } from "./transactions";

const WSOL = "So11111111111111111111111111111111111111112";
const LAMPORTS = 1e9;
const TOKEN_BASE = 1e6; // synth mint has 6 decimals
const JUP_API = process.env.NEXT_PUBLIC_JUPITER_API ?? "https://lite-api.jup.ag";

/**
 * Quote + build + sign + send a Jupiter swap. Returns the confirmed signature.
 * Slippage is enforced by Jupiter via slippageBps (no separate minOut needed).
 */
async function jupiterSwap(
  provider: anchor.AnchorProvider,
  inputMint: string,
  outputMint: string,
  amountAtomic: number,
  slippageBps: number
): Promise<TxResult> {
  const owner = provider.wallet.publicKey;
  if (!owner) throw new Error("wallet not connected");

  const quoteUrl =
    `${JUP_API}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${Math.floor(amountAtomic)}&slippageBps=${Math.round(slippageBps)}` +
    `&restrictIntermediateTokens=true`;
  const quote = await fetch(quoteUrl).then((r) => r.json());
  if (!quote || quote.error || !quote.outAmount) {
    throw new Error(quote?.error ?? "no Jupiter route for this market yet");
  }

  const swapRes = await fetch(`${JUP_API}/swap/v1/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: owner.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  }).then((r) => r.json());
  if (!swapRes?.swapTransaction) {
    throw new Error(swapRes?.error ?? "Jupiter swap build failed");
  }

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapRes.swapTransaction, "base64")
  );
  const signed = await provider.wallet.signTransaction(tx);
  const sig = await provider.connection.sendRawTransaction(signed.serialize(), {
    maxRetries: 3,
  });
  await provider.connection.confirmTransaction(sig, "confirmed");
  return { sig };
}

/** Buy the synth with SOL on the Meteora pool via Jupiter. */
export function jupiterBuy(
  provider: anchor.AnchorProvider,
  synthMint: string,
  solIn: number,
  slippage: number
): Promise<TxResult> {
  return jupiterSwap(
    provider,
    WSOL,
    new PublicKey(synthMint).toBase58(),
    Math.floor(solIn * LAMPORTS),
    slippage * 10_000
  );
}

/** Sell the synth for SOL on the Meteora pool via Jupiter. */
export function jupiterSell(
  provider: anchor.AnchorProvider,
  synthMint: string,
  tokensIn: number,
  slippage: number
): Promise<TxResult> {
  return jupiterSwap(
    provider,
    new PublicKey(synthMint).toBase58(),
    WSOL,
    Math.floor(tokensIn * TOKEN_BASE),
    slippage * 10_000
  );
}
