/** Protocol fee treasury (launch fees + protocol half of trading fees). */
export const FEE_TREASURY = "BNbCZjxJJ3UT75XyvzHA7ZL9yb7kVonw2GR1TDtSGNAX";
export const LAUNCH_FEE_SOL = 0.1;

// Defaults to the live mainnet indexer; override for local dev or a self-hosted
// instance via VITE_INDEXER_HTTP / VITE_INDEXER_WS.
export const INDEXER_HTTP =
  import.meta.env.VITE_INDEXER_HTTP ?? "https://commas-indexer.fly.dev";
export const INDEXER_WS =
  import.meta.env.VITE_INDEXER_WS ?? "wss://commas-indexer.fly.dev/ws";

/** Per-collection presentation metadata, keyed by on-chain collection id. */
export const COLLECTION_META: Record<
  string,
  { name: string; ticker: string; image: string; underlying: string; venue: string }
> = {
  "9vMk6PCT4BtZxxxHJXm6r3vF9KRDRVZXfV7ZxSRXdT3m": {
    name: "Mad Lads",
    ticker: "flMAD",
    image: "https://madlads.s3.us-west-2.amazonaws.com/images/7863.png",
    underlying: "NFT floor",
    venue: "Magic Eden",
  },
};

export const FALLBACK_META = {
  name: "Unknown market",
  ticker: "fl???",
  image: "",
  underlying: "collectible",
  venue: "oracle",
};

export const COLORS = {
  up: "#2ea36f",
  down: "#e5534b",
  index: "#3f7fc4",
};
