/**
 * Turn a chain error into a sentence a person can act on.
 *
 * ONE home. There were three copies of this, in the wizard, the trade panel and
 * the liquidity page, and they had already drifted: different mappings, and a
 * different order between "rejected in wallet" and the revert reason. A rule
 * with three homes is the shape we spent today removing.
 *
 * Custom error names are matched EXACTLY, never by substring. Float declares 108
 * of them and one contains another: /Graduated/ also matches NotGraduated(), so
 * the panel would have said "this curve has graduated" when the chain said it
 * had not. That one is latent rather than live, since CurveFunder declares
 * NotGraduated() and never reverts it, and it arms itself the day someone adds
 * the revert. The point is that a substring test cannot tell a name from its own
 * negation, which is the worst direction for a sentence to be wrong in.
 */

/** Exact custom-error name -> what to tell the person. */
const SENTENCE: Record<string, string> = {
  UnderlyingNotLive: "That market is not open yet.",
  Graduated: "This curve has graduated. Trade the pool instead.",
  NotGraduated: "This curve has not graduated yet. Trade the curve instead.",
  Slippage: "Price moved past your slippage. Try again.",
  SettleOnly: "This market is settle-only right now, so it can only be traded down.",
  OiCapExceeded: "This trade would push the market past its open-interest cap.",
  Halted: "That market is halted.",
  NotQueued: "That market is not in the funding queue.",
  AlreadyPoured: "That market has already been funded.",
  NotFresh: "The price feed is stale. Try again once the oracle catches up.",
  InsufficientLiquidity: "The Desk does not have enough liquidity for that size.",
  InsufficientBalance: "Not enough balance for that.",
  InsufficientAllowance: "The approval did not go through. Try again.",
  ExitPending: "You already have an exit request pending.",
  FirstDepositTooSmall: "The first deposit into this vault has to be larger.",
  ZeroAmount: "Enter an amount above zero.",
  UnknownAsset: "This chain does not know that market.",
  UnknownToken: "This launcher does not know that token.",
};

/**
 * viem renders a custom error as its own line, `Error: Name()`, inside a much
 * longer message that also contains the function signature and the call
 * arguments. Anchoring to that line is what keeps `buy(bytes32 assetId, ...)`
 * further down from being read as an error name.
 */
const ERROR_LINE = /^\s*Error:\s*([A-Z][A-Za-z0-9_]*)\s*\(/m;
const REVERT_REASON = /reverted with the following reason:\s*\n?(.+)/;

export function readableError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);

  // Not a contract error at all, and it beats every other reading.
  if (/User rejected|denied transaction|User denied/i.test(msg)) return "Rejected in wallet.";

  const name = msg.match(ERROR_LINE)?.[1];
  if (name && SENTENCE[name]) return SENTENCE[name];

  const reason = msg.match(REVERT_REASON)?.[1]?.trim();
  if (reason) return reason;

  // An unmapped custom error is still more use than a truncated stack line.
  if (name) return `${name}()`;

  return msg.split("\n")[0].slice(0, 160);
}
