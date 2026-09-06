/**
 * Launches kept off the public surfaces.
 *
 * These are the tokens minted while the CurveFunder venue was being brought up:
 * they exist on chain, they graduated, and their v4 pools are real, but they
 * were made to prove the plumbing rather than to be traded. Listing them put
 * four throwaway names at the top of the liquidity board, above the pools that
 * matter, and read as the product's entire inventory.
 *
 * Hidden, not deleted, and the distinction is the whole design. Nothing on
 * chain changes, the pools stay open, every holder keeps their balance, and
 * the token's own page still loads from a direct link. This list decides only
 * what the LISTS volunteer: the launchpad grid, the scanner and the liquidity
 * board. `fetchToken` deliberately does not consult it, so a link someone was
 * sent never dies.
 *
 * Add an entry only for a launch that is genuinely ours and genuinely a test.
 * This is not a moderation list: a launch is permissionless, and hiding a third
 * party's token because we dislike it is a different feature with different
 * rules that this one must not become.
 */
const HIDDEN: ReadonlySet<string> = new Set(
  [
    // Superseded launcher, all graduated during bring-up.
    "0x4Dd1ad3Aa7F14D521D9801c57EB68E269Ed9CFa1", // MARIO      Mario
    "0x2c767f3F74b279c27B0d6fff57fd51596A2127d2", // SLEEPY     Sleepy
    "0x4099Af9001bF592f92d3bC52b9bFa6718B92932F", // SNOOZE     Snooze
    // Current launcher.
    "0xa34F722073E0935F2BB9946A8d34Ed955511f663", // DOZE       Dozing Mario
    "0xD4f8cDCa49dc8C6896312d1FE3b9123924ee960d", // FDTEST6584 Floatdesk Launch Test
    "0xDf1D02dDE151D3cE69a7AA7f3F40E799a80015a1", // PANDA      Panda Money
    "0xe39a49E4963B09933CFFeAb59FDcE87645770179", // TEST       TEST
  ].map((a) => a.toLowerCase()),
);

/** True when this launch token should stay off the public board. */
export function isHiddenLaunch(token: string | null | undefined): boolean {
  return token ? HIDDEN.has(token.toLowerCase()) : false;
}
