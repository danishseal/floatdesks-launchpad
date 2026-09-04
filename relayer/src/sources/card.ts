import { CardMarketConfig, EstimateDetail } from "../types.js";
import { fetchSolUsd } from "./pyth.js";

const LAMPORTS_PER_SOL = 1_000_000_000;
const POKEMONTCG = "https://api.pokemontcg.io/v2";

/**
 * Card pipeline v1.
 *
 * Live sources:
 * - "pokemontcg": pokemontcg.io, keyless (an env key POKEMONTCG_API_KEY
 *   raises rate limits). Returns the TCGplayer market price for a RAW
 *   (ungraded) card variant, refreshed daily. Suitable underlying for raw
 *   card markets; a PSA-graded market must not use this source.
 * - "manual": config-maintained USD price (operator-attested).
 *
 * Pending keys:
 * - "gradedApi": PSA/BGS graded prices via a subscription API (TCG Price
 *   Lookup et al.), plus Collector Crypt and Courtyard cross-checks. The
 *   client here is shaped but refuses to run without TCG_GRADED_API_KEY.
 *
 * All sources convert USD to lamports through Pyth SOL/USD.
 */
export async function fetchCardUsd(cfg: CardMarketConfig): Promise<number> {
  switch (cfg.source) {
    case "manual": {
      if (!(cfg.usdPrice && cfg.usdPrice > 0)) {
        throw new Error("manual source requires usdPrice in config");
      }
      return cfg.usdPrice;
    }
    case "pokemontcg": {
      if (!cfg.cardId) throw new Error("pokemontcg source requires cardId");
      const headers: Record<string, string> = {};
      if (process.env.POKEMONTCG_API_KEY) {
        headers["X-Api-Key"] = process.env.POKEMONTCG_API_KEY;
      }
      // Keyless access rate-limits aggressively and can return transient
      // 5xx; retry with backoff before treating it as a source failure.
      let res: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
        res = await fetch(
          `${POKEMONTCG}/cards/${cfg.cardId}?select=id,name,tcgplayer`,
          { headers }
        );
        if (res.ok) break;
      }
      if (!res || !res.ok) throw new Error(`pokemontcg ${res?.status}`);
      const body: any = await res.json();
      const prices = body.data?.tcgplayer?.prices;
      if (!prices) throw new Error(`pokemontcg: no prices for ${cfg.cardId}`);
      const variant = cfg.variant ?? Object.keys(prices)[0];
      const p = prices[variant];
      if (!p?.market || !(p.market > 0)) {
        throw new Error(`pokemontcg: no market price for ${cfg.cardId}/${variant}`);
      }
      // Sanity band: the market print must sit inside the low/high spread.
      if (p.low && p.high && (p.market < p.low * 0.5 || p.market > p.high)) {
        throw new Error(
          `pokemontcg: market ${p.market} outside sane band [${p.low}, ${p.high}]`
        );
      }
      return p.market;
    }
    case "gradedApi": {
      if (!process.env.TCG_GRADED_API_KEY) {
        throw new Error(
          "gradedApi source requires TCG_GRADED_API_KEY (subscription pending)"
        );
      }
      throw new Error("gradedApi client not yet validated against a live key");
    }
    default:
      throw new Error(`unknown card source ${(cfg as any).source}`);
  }
}

export async function estimateCardIndex(
  cfg: CardMarketConfig
): Promise<EstimateDetail | null> {
  const usd = await fetchCardUsd(cfg);
  const solUsd = await fetchSolUsd();
  const lamports = Math.round((usd / solUsd) * LAMPORTS_PER_SOL);
  return {
    estimateLamports: lamports,
    salesUsed: 0,
    salesDropped: 0,
    referenceAskLamports: null,
    deviationBps: null,
  };
}
