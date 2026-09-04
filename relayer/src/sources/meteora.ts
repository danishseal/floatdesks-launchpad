const DAMM_API = "https://damm-api.meteora.ag";
const WSOL = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKENS_PER_UNIT = 1_000_000;

/**
 * Mark price for an external-venue market from a Meteora DAMM pool,
 * in lamports per whole underlying unit (1M tokens).
 *
 * Reads the pool's reserve amounts from Meteora's public API and requires
 * the pool to be synth/WSOL. The on-chain program never parses pool bytes;
 * this price goes in through push_mark (oracle-signed, EMA-smoothed,
 * funding-clamped), the same bounded-trust path as the index.
 */
export async function fetchDammMarkLamports(
  poolAddress: string,
  synthMint: string
): Promise<number> {
  const res = await fetch(`${DAMM_API}/pools?address=${poolAddress}`);
  if (!res.ok) throw new Error(`meteora damm api ${res.status}`);
  const body: any = await res.json();
  const pool = Array.isArray(body) ? body[0] : body.data?.[0] ?? body;
  const mints: string[] = pool.pool_token_mints;
  const amounts: number[] = pool.pool_token_amounts.map((a: string) =>
    Number(a)
  );
  if (!mints || mints.length !== 2) {
    throw new Error("meteora damm api: unexpected pool shape");
  }
  const synthIdx = mints.indexOf(synthMint);
  const solIdx = mints.indexOf(WSOL);
  if (synthIdx < 0 || solIdx < 0 || synthIdx === solIdx) {
    throw new Error(
      `pool ${poolAddress} is not a ${synthMint.slice(0, 6)}../WSOL pair`
    );
  }
  const synthAmount = amounts[synthIdx];
  const solAmount = amounts[solIdx];
  if (!(synthAmount > 0) || !(solAmount > 0)) {
    throw new Error(`pool ${poolAddress} has empty reserves`);
  }
  const solPerToken = solAmount / synthAmount;
  return Math.round(solPerToken * TOKENS_PER_UNIT * LAMPORTS_PER_SOL);
}
