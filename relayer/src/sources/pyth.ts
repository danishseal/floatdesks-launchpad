const HERMES = "https://hermes.pyth.network/v2/updates/price/latest";
const SOL_USD_FEED =
  "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/** Spot SOL/USD from Pyth Hermes. */
export async function fetchSolUsd(): Promise<number> {
  const res = await fetch(`${HERMES}?ids[]=${SOL_USD_FEED}&parsed=true`);
  if (!res.ok) throw new Error(`pyth hermes ${res.status}`);
  const body: any = await res.json();
  const p = body.parsed?.[0]?.price;
  if (!p) throw new Error("pyth hermes: no parsed price");
  const price = Number(p.price) * Math.pow(10, p.expo);
  if (!(price > 0)) throw new Error(`pyth hermes: bad price ${price}`);
  return price;
}
