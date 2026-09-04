export interface SalePoint {
  lamports: number;
  unixTs: number;
}

export interface EstimateDetail {
  estimateLamports: number;
  salesUsed: number;
  salesDropped: number;
  referenceAskLamports: number | null;
  deviationBps: number | null;
}

interface BaseMarketConfig {
  /** Market PDA, base58. */
  market: string;
  lookbackDays: number;
  minSales: number;
  /** Estimate vs reference ask disagreement gate; hold the push above this. */
  maxDisagreementBps: number;
  /**
   * External-venue markets only: Meteora DAMM pool address and the synth
   * mint, used to compute and push the mark price alongside the index.
   */
  externalPool?: string;
  synthMint?: string;
}

export interface NftMarketConfig extends BaseMarketConfig {
  kind: "nft";
  /** Magic Eden collection symbol, e.g. "mad_lads". */
  symbol: string;
}

export interface CardMarketConfig extends BaseMarketConfig {
  kind: "card";
  name: string;
  /** "RAW" for ungraded-market underlyings, else e.g. "PSA 10". */
  grade: string;
  /** Price source; see sources/card.ts for what each requires. */
  source: "manual" | "pokemontcg" | "gradedApi";
  /** manual source: operator-attested USD price. */
  usdPrice?: number;
  /** pokemontcg source: card id like "swsh7-215". */
  cardId?: string;
  /** pokemontcg source: price variant, e.g. "holofoil"; defaults to first. */
  variant?: string;
}

export type MarketConfig = NftMarketConfig | CardMarketConfig;

export interface RelayerConfig {
  rpcUrl: string;
  programId: string;
  /** Path to the oracle authority keypair JSON. */
  oracleKeypair: string;
  /** Path to the anchor IDL json. */
  idlPath: string;
  intervalSecs: number;
  markets: MarketConfig[];
}
