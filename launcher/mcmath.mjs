import {
  buildCurveWithMarketCap, TokenType, TokenDecimal, TokenAuthorityOption,
  BaseFeeMode, CollectFeeMode, MigrationOption, MigrationFeeOption, ActivationType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

const base = (migrationMarketCap) => buildCurveWithMarketCap({
  token: { tokenType: TokenType.SPL, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.NINE,
    tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
  fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      feeSchedulerParam: { startingFeeBps: 70, endingFeeBps: 70, numberOfPeriod: 0, totalDuration: 0 } },
    dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: 50, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
  migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
  liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 25, partnerLiquidityPercentage: 25,
    creatorPermanentLockedLiquidityPercentage: 25, creatorLiquidityPercentage: 25 },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0,
    totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Timestamp,
  initialMarketCap: 25,
  migrationMarketCap,
});

console.log("initial MC 25 SOL, supply 1B, single-segment curve:");
for (const mc of [100, 200, 400, 800, 1600, 3200]) {
  const c = base(mc);
  const threshold = Number(c.migrationQuoteThreshold) / 1e9;
  const pctSold = c.percentageSupplyOnMigration ?? "?";
  console.log(`  migrate at MC ${String(mc).padStart(4)} SOL -> raise/pool ≈ ${threshold.toFixed(1)} SOL (supply sold on curve: ${typeof pctSold === "number" ? pctSold.toFixed(1) : pctSold}%)`);
}
