/**
 * Companies Float intends to list, before anyone has listed them.
 *
 * A launcher should be able to pick a company that has no market yet:
 * `CurveFunder.launchNew` creates the listing inside the launch transaction, so
 * the contract has never needed the market to exist first. Only this UI did,
 * because it could only offer what `usePools` already returns.
 *
 * The entries here are DATA, not deployment. Nothing is pre-deployed: the
 * fSHARE contract, the Listings row and the funding-queue slot all come into
 * existence when somebody actually launches, which is why a list this long
 * costs nothing to carry.
 *
 * THE ORACLE IS THE GATE. A market whose ticker the oracle does not carry is
 * born halted and stays dark forever, so offering one would sell a launcher a
 * fee for nothing. Every entry is checked against a live quote before it is
 * shown; see `launchableCandidates`. Adding a name here does not make it
 * launchable, posting its price does.
 */
import { keccak256, toBytes } from "viem";
import { oracleQuote } from "./chain";

export interface Candidate {
  /** Registry ticker. assetId is keccak256 of these exact bytes. */
  ticker: string;
  displayName: string;
  /** Home line, shown so a launcher knows which security this is. */
  line: string;
}

/** The genesis set. Ordered by market cap, which is how the picker reads. */
export const CATALOGUE: Candidate[] = [
  { ticker: "ARAMCO", displayName: "Saudi Aramco", line: "2222.SR" },
  { ticker: "SAMSUNG", displayName: "Samsung Electronics", line: "005930.KS" },
  { ticker: "TENCENT", displayName: "Tencent Holdings", line: "0700.HK" },
  { ticker: "ROCHE", displayName: "Roche Holding", line: "RO.SW" },
  { ticker: "ICBC", displayName: "ICBC", line: "1398.HK" },
  { ticker: "NOVARTIS", displayName: "Novartis", line: "NOVN.SW" },
  { ticker: "MUFG", displayName: "Mitsubishi UFJ", line: "8306.T" },
  { ticker: "LVMH", displayName: "LVMH", line: "MC.PA" },
  { ticker: "SIEMENS", displayName: "Siemens", line: "SIE.DE" },
  { ticker: "SAP", displayName: "SAP", line: "SAP.DE" },
  { ticker: "NESTLE", displayName: "Nestle", line: "NESN.SW" },
  { ticker: "TOYOTA", displayName: "Toyota Motor", line: "7203.T" },
  { ticker: "LOREAL", displayName: "L'Oreal", line: "OR.PA" },
  { ticker: "SOFTBANK", displayName: "SoftBank Group", line: "9984.T" },
  { ticker: "HERMES", displayName: "Hermes International", line: "RMS.PA" },
  { ticker: "AIRBUS", displayName: "Airbus", line: "AIR.PA" },
  { ticker: "SONY", displayName: "Sony Group", line: "6758.T" },
  { ticker: "NINTENDO", displayName: "Nintendo", line: "7974.T" },
  { ticker: "CAMBRICON", displayName: "Cambricon Technologies", line: "688256.SS" },
  { ticker: "SKHYNIX", displayName: "SK Hynix", line: "000660.KS" },
];

export const assetIdOf = (ticker: string) => keccak256(toBytes(ticker));

/**
 * The catalogue entries that could actually open, in one pass.
 *
 * Drops anything already listed (those belong in the normal picker) and
 * anything the oracle cannot price. `getQuote` reverts NeverPosted for a ticker
 * no poster has ever submitted, which is exactly the signal wanted, so a
 * rejection is a normal answer here rather than an error worth surfacing.
 */
export async function pricedNow(assetId: `0x${string}`, maxAgeSec = 86_400): Promise<boolean> {
  try {
    const q = await oracleQuote(assetId);
    if (q.price <= 0n) return false;
    // The hub answers a quorum failure with the last known price stamped
    // DEGRADED_AGE into the past, so a dead market looks priced until you read
    // the timestamp. The three fixed test lines read exactly that way: a real
    // price, a ten-year-old stamp, marketOpen false.
    const age = Math.floor(Date.now() / 1000) - Number(q.updatedAt);
    return age >= 0 && age <= maxAgeSec;
  } catch {
    return false;
  }
}

export async function launchableCandidates(listed: Set<string>): Promise<Candidate[]> {
  const open = CATALOGUE.filter((c) => !listed.has(assetIdOf(c.ticker).toLowerCase()));
  const checked = await Promise.all(
    open.map(async (c) => {
      try {
        const q = await oracleQuote(assetIdOf(c.ticker));
        return q.price > 0n ? c : null;
      } catch {
        return null; // never posted: not launchable, and that is not an error
      }
    }),
  );
  return checked.filter((c): c is Candidate => c !== null);
}
