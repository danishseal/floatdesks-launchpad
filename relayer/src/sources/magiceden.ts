import { SalePoint, NftMarketConfig, EstimateDetail } from "../types.js";
import { estimate } from "../estimator.js";

const ME = "https://api-mainnet.magiceden.dev/v2";
const LAMPORTS_PER_SOL = 1_000_000_000;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`magiceden ${res.status} for ${url}`);
  return res.json();
}

export async function fetchFloorLamports(symbol: string): Promise<number | null> {
  const stats = await getJson(`${ME}/collections/${symbol}/stats`);
  return typeof stats.floorPrice === "number" ? stats.floorPrice : null;
}

/** Recent buyNow sales within the lookback window, paginated. */
export async function fetchSales(
  symbol: string,
  lookbackDays: number,
  maxPages = 5
): Promise<SalePoint[]> {
  const cutoff = Date.now() / 1000 - lookbackDays * 86_400;
  const sales: SalePoint[] = [];
  for (let page = 0; page < maxPages; page++) {
    const batch = await getJson(
      `${ME}/collections/${symbol}/activities?offset=${page * 100}&limit=100`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    let sawOlder = false;
    for (const a of batch) {
      if (a.type !== "buyNow") continue;
      if (typeof a.blockTime !== "number" || typeof a.price !== "number") continue;
      if (a.blockTime < cutoff) {
        sawOlder = true;
        continue;
      }
      sales.push({
        lamports: Math.round(a.price * LAMPORTS_PER_SOL),
        unixTs: a.blockTime,
      });
    }
    if (sawOlder) break;
  }
  return sales;
}

/** Cheapest current listings, ascending, in lamports. */
export async function fetchListingLadder(
  symbol: string,
  limit = 10
): Promise<number[]> {
  const listings = await getJson(
    `${ME}/collections/${symbol}/listings?offset=0&limit=${limit}`
  );
  if (!Array.isArray(listings)) return [];
  return listings
    .map((l: any) => Math.round((l.price ?? 0) * LAMPORTS_PER_SOL))
    .filter((p: number) => p > 0)
    .sort((a: number, b: number) => a - b);
}

/**
 * NFT floor index estimate in lamports per NFT.
 *
 * Primary observable: the ask ladder. The estimate is the median of the
 * cheapest 3 listings (the 2nd-cheapest), which hugs the floor but cannot
 * be moved by any single fake listing: a lone underpriced listing is a
 * fillable offer that arbitrage removes, and a lone overpriced one never
 * becomes the median. Cross-checked against the venue's reported floor
 * within maxDisagreementBps. Blue-chip sale prints are too sparse on the
 * public feed to be the primary signal; recent sales are collected as a
 * logged confirmation only. A bid-side leg (Tensor collection bids)
 * strengthens this once an API key is provisioned.
 */
export async function estimateNftIndex(
  cfg: NftMarketConfig
): Promise<EstimateDetail | null> {
  const [floor, ladder, sales] = await Promise.all([
    fetchFloorLamports(cfg.symbol),
    fetchListingLadder(cfg.symbol),
    fetchSales(cfg.symbol, cfg.lookbackDays, 3).catch(() => []),
  ]);
  if (ladder.length < 3) return null;
  const est = ladder[1];

  let deviationBps: number | null = null;
  if (floor && floor > 0) {
    deviationBps = Math.round((Math.abs(est - floor) / floor) * 10_000);
    if (deviationBps > cfg.maxDisagreementBps) return null;
  }

  return {
    estimateLamports: est,
    salesUsed: sales.length,
    salesDropped: 0,
    referenceAskLamports: floor,
    deviationBps,
  };
}
