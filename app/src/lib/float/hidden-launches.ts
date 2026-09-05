/**
 * Launches kept off the public surfaces.
 *
 * These are the tokens minted while the CurveFunder venue was being brought up:
 * they exist on chain, they graduated, and their v4 pools are real, but they
 * were made to prove the plumbing rather than to be traded. Listing them put
 * four throwaway names at the top of the liquidity board, above the pools that
 * matter, and read as the product's entire inventory.
 *
 * Hidden, not deleted. Nothing on chain changes, the pools stay open, and
 * anyone holding a position can still reach it by address. This list only
 * decides what the board volunteers.
 *
 * Add an entry only for a launch that is genuinely ours and genuinely a test.
 * This is not a moderation list: a launch is permissionless, and hiding a third
 * party's token because we dislike it is a different feature with different
 * rules that this one must not become.
 */
const HIDDEN: ReadonlySet<string> = new Set(
  [
    "0xa34F722073E0935F2BB9946A8d34Ed955511f663", // DOZE   / fNTDO3
    "0x4Dd1ad3Aa7F14D521D9801c57EB68E269Ed9CFa1", // MARIO  / fNINTENDO
    "0x2c767f3F74b279c27B0d6fff57fd51596A2127d2", // SLEEPY / fNTDO
    "0x4099Af9001bF592f92d3bC52b9bFa6718B92932F", // SNOOZE / fNTDO2
  ].map((a) => a.toLowerCase()),
);

/** True when this launch token should stay off the public board. */
export function isHiddenLaunch(token: string | null | undefined): boolean {
  return token ? HIDDEN.has(token.toLowerCase()) : false;
}
