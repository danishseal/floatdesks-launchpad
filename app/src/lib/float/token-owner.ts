/**
 * Which launcher holds one known token, answered by asking rather than by
 * enumerating.
 *
 * `cfAllTokensDetailed()` reads `tokenCount()` and then fans out one
 * `allTokens(i)` per index, each with its own `.catch(() => null)`. Under load
 * on the public RPC some of those calls lose, and the list comes back SHORT
 * while looking complete. A token missing from it then reads as a token that
 * does not exist, which is how the chart printed "No trading data available yet"
 * and the contracts grid answered "no curve on this deployment holds
 * 0xa34F72..." about DOZE, a token with a live pool, minutes after both had
 * rendered it correctly.
 *
 * When the address is already known there is no reason to search for it. Asking
 * each launcher `curves(token)` is two reads and cannot go short. The one thing
 * that has to be handled carefully is that `curves()` answers an ALL-ZERO struct
 * for a token it has never seen instead of reverting, so "not held here" and
 * "the call failed" are different answers and are kept different here.
 */

import type { Address } from "viem";
import { zeroAddress } from "viem";
import { cfCurve, cfLaunchers, type CurveFunderCurve } from "./curve-funder";
import { withRetry, mapLimited } from "./retry";

const ZERO_ID = "0x0000000000000000000000000000000000000000000000000000000000000000";

export type TokenOwner =
  | { kind: "found"; launcher: Address; superseded: boolean; curve: CurveFunderCurve }
  /** Every launcher answered, and none of them holds this token. */
  | { kind: "absent" }
  /** At least one launcher could not be asked, so absence cannot be claimed. */
  | { kind: "unreadable"; reasons: string[] };

/** A curve struct that has never been written. Not data. */
function isEmpty(c: CurveFunderCurve): boolean {
  return (
    c.underlying === ZERO_ID &&
    c.creator === zeroAddress &&
    c.vToken === 0n &&
    c.gradTarget === 0n
  );
}

export async function launcherHolding(token: Address): Promise<TokenOwner> {
  const all = await cfLaunchers().catch(() => []);
  if (!all.length) return { kind: "unreadable", reasons: ["no launcher to ask"] };

  const reasons: string[] = [];
  const results = await mapLimited(all, async (l) => {
      try {
        return { l, curve: await withRetry(() => cfCurve(token, l.address), `curves(${token}) on ${l.address}`) };
      } catch (e) {
        reasons.push(
          `${l.address}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
        );
        return null;
      }
  });

  for (const r of results) {
    if (r && !isEmpty(r.curve)) {
      return {
        kind: "found",
        launcher: r.l.address,
        superseded: r.l.superseded,
        curve: r.curve,
      };
    }
  }

  // Nothing held it, but if a launcher refused to answer we did not actually
  // ask all of them, and "absent" would be a claim we cannot make.
  if (reasons.length) return { kind: "unreadable", reasons };
  return { kind: "absent" };
}
