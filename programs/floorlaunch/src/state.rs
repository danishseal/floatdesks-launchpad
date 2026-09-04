use anchor_lang::prelude::*;

/// Whole synth tokens per one floor NFT.
pub const TOKENS_PER_NFT: u64 = 1_000_000;
pub const SYNTH_DECIMALS: u8 = 6;
/// Token base units per one floor NFT: 1_000_000 tokens * 10^6.
pub const BASE_UNITS_PER_NFT: u128 = 1_000_000_000_000;
/// Fixed point one for the cumulative funding index.
pub const FUNDING_ONE: u128 = 1_000_000_000_000;
pub const BPS: u128 = 10_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MarketStatus {
    Bootstrap,
    Live,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Venue {
    /// Token launched and traded on the program's own curve and AMM.
    /// Synth supply is elastic (minted and burned by the program).
    Internal,
    /// Token launched and traded on an external venue (Meteora DBC into
    /// DAMM). The mint is external and its supply fixed, so CDP supply
    /// moves through a program-owned treasury reserve instead of
    /// mint/burn, and the mark price is oracle-pushed.
    External,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct MarketParams {
    /// Time window for the index TWAP (EMA weighting), seconds.
    pub index_window_secs: u32,
    /// Minimum seconds between oracle pushes.
    pub min_push_interval_secs: u32,
    /// Push deviating from TWAP by more than this freezes the market.
    pub breaker_bps: u16,
    /// Index older than this blocks shorts, withdrawals, funding, and
    /// liquidations. 0 disables the guard.
    pub max_index_age_secs: u32,
    /// Window for the AMM mark EMA, seconds.
    pub mark_window_secs: u32,
    /// Funding sensitivity: rate_per_day = premium * funding_k_bps / 10000.
    pub funding_k_bps: u16,
    /// Absolute clamp on funding, bps of debt per day.
    pub max_funding_bps_per_day: u16,
    /// Minimum seconds between funding cranks.
    pub min_crank_interval_secs: u32,
    /// Collateral ratio to open or withdraw, bps (e.g. 15000 = 150%).
    pub initial_cr_bps: u16,
    /// Collateral ratio below which liquidation opens, bps.
    pub maintenance_cr_bps: u16,
    /// Liquidator bonus, bps of repaid debt value.
    pub liq_bonus_bps: u16,
    /// Cap on total CDP debt, token base units.
    pub max_open_interest: u64,
    /// Preminted allocation backing item swaps, token base units. Zero
    /// disables item swaps for the market.
    pub item_reserve: u64,
    /// How many synth units (1M tokens each) one physical item was worth
    /// at launch, in millionths. The curve prices every launch at the
    /// same 25 -> 100 SOL market cap span regardless of the underlying,
    /// so the oracle index is launch-scaled and this factor carries the
    /// item's real size into item swaps. 1_000_000 = one unit per item.
    pub units_per_item_micro: u64,
    /// Curve trade fee, bps.
    pub curve_fee_bps: u16,
    /// AMM trade fee, bps.
    pub amm_fee_bps: u16,
    /// Real SOL raised on the curve that triggers graduation.
    pub graduation_target_sol: u64,
    /// Share of raised SOL that seeds the insurance fund at graduation, bps.
    pub insurance_share_bps: u16,
    /// Initial virtual SOL reserve for the curve, lamports.
    pub curve_virtual_sol: u64,
    /// Initial virtual token reserve for the curve, base units.
    pub curve_virtual_tokens: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Global {
    pub admin: Pubkey,
    pub oracle_authority: Pubkey,
    pub default_params: MarketParams,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    /// Identifies the NFT collection (verified collection mint address).
    pub collection: Pubkey,
    pub synth_mint: Pubkey,
    pub status: MarketStatus,
    pub venue: Venue,
    /// Circuit breaker flag. Blocks everything except add_collateral and admin ops.
    pub frozen: bool,
    pub params: MarketParams,

    // Oracle index, lamports per whole NFT.
    pub index_twap: u64,
    pub index_last_raw: u64,
    pub index_last_ts: i64,

    // Curve state.
    pub curve_virtual_sol: u64,
    pub curve_virtual_tokens: u64,
    pub curve_sol_raised: u64,
    pub curve_tokens_sold: u64,

    // AMM state (real reserves after graduation).
    pub amm_sol_reserve: u64,
    pub amm_token_reserve: u64,
    /// Mark price EMA, lamports per whole NFT.
    pub mark_ema: u64,
    pub mark_last_ts: i64,

    // Funding.
    /// Cumulative funding index, FUNDING_ONE fixed point.
    pub funding_index: u128,
    pub funding_last_ts: i64,

    // CDP aggregates. Debt stored funding-scaled.
    pub total_debt_scaled: u128,
    pub total_collateral: u64,

    // Lamport accounting inside the shared sol vault.
    pub insurance_lamports: u64,
    pub fee_lamports: u64,

    /// Items currently held by the market's item escrow.
    pub items_deposited: u32,

    pub bump: u8,
    pub vault_bump: u8,
    pub mint_bump: u8,
    pub treasury_bump: u8,
}

/// Admin-registered item mint eligible for a market's item swaps (a
/// vaulted-card NFT or collection NFT verified off chain in v1).
#[account]
#[derive(InitSpace)]
pub struct ItemRegistration {
    pub market: Pubkey,
    pub item_mint: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ShortPosition {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub collateral: u64,
    /// Debt in base units divided by funding_index at last touch, FUNDING_ONE scaled.
    pub debt_scaled: u128,
    pub bump: u8,
}

impl Market {
    /// Current debt in token base units for a scaled debt amount.
    pub fn debt_from_scaled(&self, scaled: u128) -> u64 {
        ((scaled * self.funding_index) / FUNDING_ONE) as u64
    }

    pub fn scaled_from_debt(&self, debt: u64) -> u128 {
        (debt as u128 * FUNDING_ONE).div_ceil(self.funding_index)
    }

    /// Lamport value of a token base unit amount at the current index.
    pub fn value_at_index(&self, base_units: u64) -> u64 {
        ((base_units as u128 * self.index_twap as u128) / BASE_UNITS_PER_NFT) as u64
    }

    /// AMM spot price, lamports per whole NFT.
    pub fn amm_spot_per_nft(&self) -> u64 {
        if self.amm_token_reserve == 0 {
            return 0;
        }
        ((self.amm_sol_reserve as u128 * BASE_UNITS_PER_NFT)
            / self.amm_token_reserve as u128) as u64
    }
}

/// Time-weighted EMA step: pull `ema` toward `spot` by min(dt, window)/window.
pub fn ema_step(ema: u64, spot: u64, dt: i64, window_secs: u32) -> u64 {
    if ema == 0 {
        return spot;
    }
    let w = window_secs.max(1) as u128;
    let dt = (dt.max(0) as u128).min(w);
    let ema = ema as u128;
    let spot = spot as u128;
    ((ema * (w - dt) + spot * dt) / w) as u64
}
