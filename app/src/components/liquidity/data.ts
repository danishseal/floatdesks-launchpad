export type LiquidityPool = {
  id: string;
  tokenA: string;
  tokenB: string;
  fee: string;
  type: string;
  tvl: string;
  apr: string;
  averageApr?: string;
  rewards: string;
  volume: string;
};

export const FEATURED_POOL_ID = "0x5a177cf0effb7e0e7115d792e587c1a5a9cbc9d4";

export const LIQUIDITY_POOLS: LiquidityPool[] = [
  { id: FEATURED_POOL_ID, tokenA: "HYPE", tokenB: "USDC", fee: "0.12%", type: "CL5", tvl: "$2,387,185", apr: "29,449.9%", averageApr: "277.2%", rewards: "$93,389", volume: "$15,247,338" },
  { id: "usdc-usdt0", tokenA: "USDC", tokenB: "USD₮0", fee: "0.0023%", type: "CL1", tvl: "$2,152,370", apr: "45.4%", averageApr: "19.1%", rewards: "$3,625", volume: "$9,330,563" },
  { id: "hype-khype", tokenA: "HYPE", tokenB: "kHYPE", fee: "0.001%", type: "CL1", tvl: "$1,566,505", apr: "68.3%", averageApr: "19.1%", rewards: "$3,412", volume: "$5,796,233" },
  { id: "usdc-usdc", tokenA: "USDC", tokenB: "USDC", fee: "0.0014%", type: "CL1", tvl: "$1,241,736", apr: "5.6%", averageApr: "5.6%", rewards: "Fees only", volume: "$8,719,519" },
  { id: "ram-usdc", tokenA: "RAM", tokenB: "USDC", fee: "3%", type: "CL5", tvl: "$1,206,102", apr: "2,127,321.9%", averageApr: "49,054.7%", rewards: "Fees only", volume: "$630,769" },
  { id: "eth-usdg", tokenA: "ETH", tokenB: "USDG", fee: "0.01%", type: "CL1", tvl: "$862,085", apr: "83,508.6%", averageApr: "166.3%", rewards: "Fees only", volume: "$40,448,785" },
  { id: "ubtc-ueth", tokenA: "UBTC", tokenB: "UETH", fee: "0.06%", type: "CL10", tvl: "$733,406", apr: "3,544.5%", averageApr: "12.0%", rewards: "$1,503", volume: "$2,291,948" },
  { id: "hype-ueth", tokenA: "HYPE", tokenB: "UETH", fee: "0.1%", type: "CL5", tvl: "$663,937", apr: "15,987.0%", averageApr: "59.0%", rewards: "$3,406", volume: "$2,324,128" },
  { id: "spy-usdg", tokenA: "SPY", tokenB: "USDG", fee: "0.01%", type: "RWA", tvl: "$623,551", apr: "17,716.7%", averageApr: "82.2%", rewards: "Fees only", volume: "$11,963,488" },
  { id: "eth-pons", tokenA: "ETH", tokenB: "PONS", fee: "0.1%", type: "CL100", tvl: "$615,312", apr: "87,705.7%", averageApr: "625.1%", rewards: "Fees only", volume: "$8,528,452" },
  { id: "hyperram-fbomb", tokenA: "hyperRAM", tokenB: "fBOMB", fee: "1%", type: "Volatile", tvl: "$540,143", apr: "240.8%", rewards: "$24,927", volume: "$8,332" },
  { id: "evausdt-evausdc", tokenA: "evaUSDT", tokenB: "evaUSDC", fee: "0.0025%", type: "Stable", tvl: "$469,775", apr: "18.6%", rewards: "$1,671", volume: "$0" },
];
