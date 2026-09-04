use anchor_lang::prelude::*;

#[error_code]
pub enum FloorlaunchError {
    #[msg("unauthorized")]
    Unauthorized,
    #[msg("market is not in bootstrap phase")]
    NotBootstrap,
    #[msg("market is not live")]
    NotLive,
    #[msg("market is frozen")]
    Frozen,
    #[msg("market is not frozen")]
    NotFrozen,
    #[msg("oracle push too soon after previous push")]
    PushTooSoon,
    #[msg("index observation outside sane bounds")]
    BadIndexValue,
    #[msg("slippage limit exceeded")]
    Slippage,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("graduation target not reached")]
    TargetNotReached,
    #[msg("curve sell exceeds tokens sold")]
    CurveSellTooLarge,
    #[msg("collateral ratio below requirement")]
    InsufficientCollateral,
    #[msg("open interest cap reached")]
    OpenInterestCapReached,
    #[msg("position is not liquidatable")]
    NotLiquidatable,
    #[msg("repay exceeds outstanding debt")]
    RepayTooLarge,
    #[msg("funding crank too soon after previous crank")]
    CrankTooSoon,
    #[msg("no index price available yet")]
    NoIndex,
    #[msg("index price is stale")]
    IndexStale,
    #[msg("math overflow")]
    MathOverflow,
    #[msg("insufficient vault funds for withdrawal")]
    InsufficientVaultFunds,
    #[msg("position still has outstanding debt")]
    DebtOutstanding,
    #[msg("parameter cannot be changed after market creation")]
    ImmutableParam,
    #[msg("instruction not available for this market venue")]
    WrongVenue,
    #[msg("no mark price available yet")]
    NoMark,
    #[msg("treasury reserve cannot cover this mint")]
    TreasuryDepleted,
    #[msg("item reserve cannot cover this deposit")]
    ItemReserveDepleted,
    #[msg("item is not registered for this market")]
    ItemNotRegistered,
    #[msg("item escrow does not hold this item")]
    ItemNotInEscrow,
}
