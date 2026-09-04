use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{
    self, set_authority, spl_token::instruction::AuthorityType, Burn, Mint, MintTo, SetAuthority,
    Token, TokenAccount,
};

pub mod errors;
pub mod state;

use errors::FloorlaunchError as Err;
use state::*;

declare_id!("QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM");

#[program]
pub mod floorlaunch {
    use super::*;

    pub fn init_global(
        ctx: Context<InitGlobal>,
        oracle_authority: Pubkey,
        default_params: MarketParams,
    ) -> Result<()> {
        let g = &mut ctx.accounts.global;
        g.admin = ctx.accounts.admin.key();
        g.oracle_authority = oracle_authority;
        g.default_params = default_params;
        g.bump = ctx.bumps.global;
        Ok(())
    }

    pub fn set_oracle_authority(ctx: Context<AdminGlobal>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.global.oracle_authority = new_authority;
        Ok(())
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        collection: Pubkey,
        params: Option<MarketParams>,
    ) -> Result<()> {
        let params = params.unwrap_or(ctx.accounts.global.default_params);
        require!(params.curve_virtual_sol > 0, Err::ZeroAmount);
        require!(params.curve_virtual_tokens > 0, Err::ZeroAmount);
        require!(
            params.item_reserve == 0 || params.units_per_item_micro > 0,
            Err::ZeroAmount
        );
        {
            let m = &mut ctx.accounts.market;
            m.collection = collection;
            m.synth_mint = ctx.accounts.synth_mint.key();
            m.status = MarketStatus::Bootstrap;
            m.venue = Venue::Internal;
            m.frozen = false;
            m.params = params;
            m.curve_virtual_sol = params.curve_virtual_sol;
            m.curve_virtual_tokens = params.curve_virtual_tokens;
            // Seed the mark with the curve's opening price so value-based
            // item swaps work from the first block.
            m.mark_ema = ((params.curve_virtual_sol as u128 * BASE_UNITS_PER_NFT)
                / params.curve_virtual_tokens as u128) as u64;
            m.mark_last_ts = Clock::get()?.unix_timestamp;
            m.funding_index = FUNDING_ONE;
            m.bump = ctx.bumps.market;
            m.vault_bump = ctx.bumps.sol_vault;
            m.mint_bump = ctx.bumps.synth_mint;
            m.treasury_bump = ctx.bumps.treasury;
        }
        // Fixed supply: premint the full curve allocation and the hedging
        // reserve, then revoke the mint authority forever. From here on,
        // tokens only move between accounts (and burn at graduation);
        // nothing can ever mint again.
        mint_synth(
            &ctx.accounts.market,
            &ctx.accounts.synth_mint,
            &ctx.accounts.pool_token,
            &ctx.accounts.token_program,
            params.curve_virtual_tokens,
        )?;
        if params.max_open_interest > 0 {
            mint_synth(
                &ctx.accounts.market,
                &ctx.accounts.synth_mint,
                &ctx.accounts.treasury,
                &ctx.accounts.token_program,
                params.max_open_interest,
            )?;
        }
        if params.item_reserve > 0 {
            mint_synth(
                &ctx.accounts.market,
                &ctx.accounts.synth_mint,
                &ctx.accounts.item_reserve,
                &ctx.accounts.token_program,
                params.item_reserve,
            )?;
        }
        let market = &ctx.accounts.market;
        let seeds: &[&[u8]] = &[b"market", market.collection.as_ref(), &[market.bump]];
        set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    account_or_mint: ctx.accounts.synth_mint.to_account_info(),
                    current_authority: market.to_account_info(),
                },
                &[seeds],
            ),
            AuthorityType::MintTokens,
            None,
        )?;
        // Untracked rent buffer so outflows can never strand the vault in
        // the non-rent-exempt band where system transfers start failing.
        transfer_in(
            &ctx.accounts.admin,
            &ctx.accounts.sol_vault,
            &ctx.accounts.system_program,
            Rent::get()?.minimum_balance(0),
        )?;
        Ok(())
    }

    /// Attach a market to a token that launched on an external venue
    /// (Meteora DBC into DAMM). The mint is external with fixed supply, so
    /// the market starts Live immediately: CDP supply flows through the
    /// program treasury, which must be funded with reserve tokens (plain
    /// SPL transfer) before shorts can open. The mark price is
    /// oracle-pushed via push_mark.
    pub fn create_external_market(
        ctx: Context<CreateExternalMarket>,
        collection: Pubkey,
        params: Option<MarketParams>,
    ) -> Result<()> {
        let params = params.unwrap_or(ctx.accounts.global.default_params);
        let m = &mut ctx.accounts.market;
        m.collection = collection;
        m.synth_mint = ctx.accounts.synth_mint.key();
        m.status = MarketStatus::Live;
        m.venue = Venue::External;
        m.frozen = false;
        m.params = params;
        m.funding_index = FUNDING_ONE;
        m.funding_last_ts = Clock::get()?.unix_timestamp;
        m.bump = ctx.bumps.market;
        m.vault_bump = ctx.bumps.sol_vault;
        m.treasury_bump = ctx.bumps.treasury;
        transfer_in(
            &ctx.accounts.admin,
            &ctx.accounts.sol_vault,
            &ctx.accounts.system_program,
            Rent::get()?.minimum_balance(0),
        )?;
        Ok(())
    }

    pub fn push_index(ctx: Context<PushIndex>, price_lamports: u64) -> Result<()> {
        let m = &mut ctx.accounts.market;
        // While frozen the index must not move: otherwise a compromised
        // oracle could walk the TWAP breaker-step by breaker-step during
        // the freeze and hand the admin a poisoned price at unfreeze.
        require!(!m.frozen, Err::Frozen);
        require!(price_lamports > 0, Err::BadIndexValue);
        let now = Clock::get()?.unix_timestamp;
        require!(
            m.index_last_ts == 0
                || now - m.index_last_ts >= m.params.min_push_interval_secs as i64,
            Err::PushTooSoon
        );

        if m.index_twap != 0 {
            let dev_bps = (price_lamports as i128 - m.index_twap as i128).unsigned_abs()
                * BPS
                / m.index_twap as u128;
            if dev_bps > m.params.breaker_bps as u128 {
                m.frozen = true;
                m.index_last_raw = price_lamports;
                m.index_last_ts = now;
                emit!(BreakerTripped {
                    market: m.key(),
                    observed: price_lamports,
                    twap: m.index_twap,
                });
                return Ok(());
            }
        }

        let dt = if m.index_last_ts == 0 { i64::MAX } else { now - m.index_last_ts };
        m.index_twap = ema_step(m.index_twap, price_lamports, dt, m.params.index_window_secs);
        m.index_last_raw = price_lamports;
        m.index_last_ts = now;
        emit!(IndexPushed {
            market: m.key(),
            raw: price_lamports,
            twap: m.index_twap,
        });
        Ok(())
    }

    /// Oracle-pushed mark price for external-venue markets, in lamports
    /// per whole underlying unit. The relayer computes it from the
    /// external pool off chain; on chain it is EMA-smoothed and
    /// rate-limited, and funding clamps bound what a bad push can move.
    pub fn push_mark(ctx: Context<PushIndex>, price_lamports: u64) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.venue == Venue::External, Err::WrongVenue);
        require!(!m.frozen, Err::Frozen);
        require!(price_lamports > 0, Err::BadIndexValue);
        let now = Clock::get()?.unix_timestamp;
        require!(
            m.mark_last_ts == 0
                || now - m.mark_last_ts >= m.params.min_push_interval_secs as i64,
            Err::PushTooSoon
        );
        let dt = if m.mark_last_ts == 0 { i64::MAX } else { now - m.mark_last_ts };
        m.mark_ema = ema_step(m.mark_ema, price_lamports, dt, m.params.mark_window_secs);
        m.mark_last_ts = now;
        Ok(())
    }

    pub fn set_frozen(ctx: Context<AdminMarket>, frozen: bool) -> Result<()> {
        ctx.accounts.market.frozen = frozen;
        Ok(())
    }

    /// Admin risk-parameter update. Curve virtual reserves are immutable
    /// after creation; the running curve state is never touched.
    pub fn update_market_params(
        ctx: Context<AdminMarket>,
        params: MarketParams,
    ) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(
            params.curve_virtual_sol == m.params.curve_virtual_sol
                && params.curve_virtual_tokens == m.params.curve_virtual_tokens,
            Err::ImmutableParam
        );
        m.params = params;
        Ok(())
    }

    pub fn curve_buy(ctx: Context<CurveTrade>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Bootstrap, Err::NotBootstrap);
        require!(!m.frozen, Err::Frozen);
        require!(sol_in > 0, Err::ZeroAmount);

        let fee = mul_bps(sol_in, m.params.curve_fee_bps);
        let net_in = sol_in - fee;
        let tokens_out = cp_out(m.curve_virtual_sol, m.curve_virtual_tokens, net_in)?;
        require!(tokens_out >= min_tokens_out, Err::Slippage);
        require!(tokens_out > 0, Err::ZeroAmount);

        m.curve_virtual_sol += net_in;
        m.curve_virtual_tokens -= tokens_out;
        update_mark(m)?;
        m.curve_sol_raised += net_in;
        m.curve_tokens_sold += tokens_out;
        m.fee_lamports += fee;

        transfer_in(
            &ctx.accounts.user,
            &ctx.accounts.sol_vault,
            &ctx.accounts.system_program,
            sol_in,
        )?;
        transfer_pool_tokens_out(
            &ctx.accounts.market,
            &ctx.accounts.pool_token,
            &ctx.accounts.user_ata,
            &ctx.accounts.token_program,
            tokens_out,
        )?;
        emit!(CurveTraded {
            market: ctx.accounts.market.key(),
            user: ctx.accounts.user.key(),
            is_buy: true,
            sol_amount: sol_in,
            token_amount: tokens_out,
        });
        Ok(())
    }

    pub fn curve_sell(ctx: Context<CurveTrade>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Bootstrap, Err::NotBootstrap);
        require!(!m.frozen, Err::Frozen);
        require!(tokens_in > 0, Err::ZeroAmount);
        require!(tokens_in <= m.curve_tokens_sold, Err::CurveSellTooLarge);

        let sol_gross = cp_out(m.curve_virtual_tokens, m.curve_virtual_sol, tokens_in)?;
        require!(sol_gross <= m.curve_sol_raised, Err::InsufficientVaultFunds);
        let fee = mul_bps(sol_gross, m.params.curve_fee_bps);
        let sol_out = sol_gross - fee;
        require!(sol_out >= min_sol_out, Err::Slippage);

        m.curve_virtual_tokens += tokens_in;
        update_mark(m)?;
        m.curve_virtual_sol -= sol_gross;
        m.curve_sol_raised -= sol_gross;
        m.curve_tokens_sold -= tokens_in;
        m.fee_lamports += fee;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.user_ata.to_account_info(),
                    to: ctx.accounts.pool_token.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            tokens_in,
        )?;
        let market_key = ctx.accounts.market.key();
        transfer_out(
            &ctx.accounts.sol_vault,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.system_program,
            market_key,
            ctx.accounts.market.vault_bump,
            sol_out,
        )?;
        emit!(CurveTraded {
            market: market_key,
            user: ctx.accounts.user.key(),
            is_buy: false,
            sol_amount: sol_out,
            token_amount: tokens_in,
        });
        Ok(())
    }

    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Bootstrap, Err::NotBootstrap);
        require!(!m.frozen, Err::Frozen);
        require!(
            m.curve_sol_raised >= m.params.graduation_target_sol,
            Err::TargetNotReached
        );
        require!(m.index_twap > 0, Err::NoIndex);

        let insurance = mul_bps(m.curve_sol_raised, m.params.insurance_share_bps);
        let amm_sol = m.curve_sol_raised - insurance;
        // Pair AMM liquidity at the curve's closing price.
        let amm_tokens = ((amm_sol as u128 * m.curve_virtual_tokens as u128)
            / m.curve_virtual_sol as u128) as u64;
        require!(amm_tokens > 0, Err::ZeroAmount);

        m.insurance_lamports = insurance;
        m.amm_sol_reserve = amm_sol;
        m.amm_token_reserve = amm_tokens;
        m.status = MarketStatus::Live;
        let now = Clock::get()?.unix_timestamp;
        // The mark EMA has been fed by the curve all through bootstrap and
        // the AMM seeds at the curve's closing price, so it carries over
        // continuously; just refresh the clock.
        if m.mark_ema == 0 {
            m.mark_ema = m.amm_spot_per_nft();
        }
        m.mark_last_ts = now;
        m.funding_last_ts = now;

        // The curve allocation still holds every unsold token; the AMM
        // keeps its price-matched seed and the excess burns, so supply
        // only ever shrinks after launch.
        let excess = ctx.accounts.pool_token.amount.saturating_sub(amm_tokens);
        if excess > 0 {
            let market = &ctx.accounts.market;
            let seeds: &[&[u8]] =
                &[b"market", market.collection.as_ref(), &[market.bump]];
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.synth_mint.to_account_info(),
                        from: ctx.accounts.pool_token.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    &[seeds],
                ),
                excess,
            )?;
        }
        emit!(Graduated {
            market: ctx.accounts.market.key(),
            amm_sol,
            amm_tokens,
            insurance,
        });
        Ok(())
    }

    pub fn amm_buy(ctx: Context<AmmTrade>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.venue == Venue::Internal, Err::WrongVenue);
        require!(m.status == MarketStatus::Live, Err::NotLive);
        require!(!m.frozen, Err::Frozen);
        require!(sol_in > 0, Err::ZeroAmount);

        let fee = mul_bps(sol_in, m.params.amm_fee_bps);
        let net_in = sol_in - fee;
        let tokens_out = cp_out(m.amm_sol_reserve, m.amm_token_reserve, net_in)?;
        require!(tokens_out >= min_tokens_out, Err::Slippage);
        require!(tokens_out > 0 && tokens_out < m.amm_token_reserve, Err::ZeroAmount);

        m.amm_sol_reserve += net_in;
        m.amm_token_reserve -= tokens_out;
        m.fee_lamports += fee;
        update_mark(m)?;

        transfer_in(
            &ctx.accounts.user,
            &ctx.accounts.sol_vault,
            &ctx.accounts.system_program,
            sol_in,
        )?;
        transfer_pool_tokens_out(
            &ctx.accounts.market,
            &ctx.accounts.pool_token,
            &ctx.accounts.user_ata,
            &ctx.accounts.token_program,
            tokens_out,
        )?;
        emit!(AmmTraded {
            market: ctx.accounts.market.key(),
            user: ctx.accounts.user.key(),
            is_buy: true,
            sol_amount: sol_in,
            token_amount: tokens_out,
        });
        Ok(())
    }

    pub fn amm_sell(ctx: Context<AmmTrade>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.venue == Venue::Internal, Err::WrongVenue);
        require!(m.status == MarketStatus::Live, Err::NotLive);
        require!(!m.frozen, Err::Frozen);
        require!(tokens_in > 0, Err::ZeroAmount);

        let sol_gross = cp_out(m.amm_token_reserve, m.amm_sol_reserve, tokens_in)?;
        require!(sol_gross < m.amm_sol_reserve, Err::InsufficientVaultFunds);
        let fee = mul_bps(sol_gross, m.params.amm_fee_bps);
        let sol_out = sol_gross - fee;
        require!(sol_out >= min_sol_out, Err::Slippage);

        m.amm_token_reserve += tokens_in;
        m.amm_sol_reserve -= sol_gross;
        m.fee_lamports += fee;
        update_mark(m)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.user_ata.to_account_info(),
                    to: ctx.accounts.pool_token.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            tokens_in,
        )?;
        let market_key = ctx.accounts.market.key();
        transfer_out(
            &ctx.accounts.sol_vault,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.system_program,
            market_key,
            ctx.accounts.market.vault_bump,
            sol_out,
        )?;
        emit!(AmmTraded {
            market: market_key,
            user: ctx.accounts.user.key(),
            is_buy: false,
            sol_amount: sol_out,
            token_amount: tokens_in,
        });
        Ok(())
    }

    pub fn open_short(ctx: Context<OpenShort>, collateral: u64, mint_amount: u64) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Live, Err::NotLive);
        require!(!m.frozen, Err::Frozen);
        require!(collateral > 0 && mint_amount > 0, Err::ZeroAmount);
        require_fresh_index(m)?;

        let p = &mut ctx.accounts.position;
        if p.owner == Pubkey::default() {
            p.owner = ctx.accounts.owner.key();
            p.market = m.key();
            p.bump = ctx.bumps.position;
        }

        let new_debt = m.debt_from_scaled(p.debt_scaled) + mint_amount;
        let new_collateral = p.collateral + collateral;
        let debt_value = m.value_at_index(new_debt);
        require!(
            new_collateral as u128 * BPS >= debt_value as u128 * m.params.initial_cr_bps as u128,
            Err::InsufficientCollateral
        );

        let total_debt = m.debt_from_scaled(m.total_debt_scaled) + mint_amount;
        require!(total_debt <= m.params.max_open_interest, Err::OpenInterestCapReached);

        let scaled = m.scaled_from_debt(mint_amount);
        p.debt_scaled += scaled;
        p.collateral = new_collateral;
        m.total_debt_scaled += scaled;
        m.total_collateral += collateral;

        transfer_in(
            &ctx.accounts.owner,
            &ctx.accounts.sol_vault,
            &ctx.accounts.system_program,
            collateral,
        )?;
        // Both venues run fixed supply: CDP tokens come out of the
        // program treasury, whose balance is the hard OI ceiling.
        require!(
            ctx.accounts.treasury.amount >= mint_amount,
            Err::TreasuryDepleted
        );
        transfer_pool_tokens_out(
            &ctx.accounts.market,
            &ctx.accounts.treasury,
            &ctx.accounts.owner_ata,
            &ctx.accounts.token_program,
            mint_amount,
        )?;
        emit!(ShortChanged {
            market: ctx.accounts.market.key(),
            owner: ctx.accounts.owner.key(),
            collateral: ctx.accounts.position.collateral,
            debt: new_debt,
        });
        Ok(())
    }

    pub fn add_collateral(ctx: Context<AdjustCollateral>, amount: u64) -> Result<()> {
        require!(amount > 0, Err::ZeroAmount);
        let m = &mut ctx.accounts.market;
        let p = &mut ctx.accounts.position;
        p.collateral += amount;
        m.total_collateral += amount;
        transfer_in(
            &ctx.accounts.owner,
            &ctx.accounts.sol_vault,
            &ctx.accounts.system_program,
            amount,
        )?;
        Ok(())
    }

    pub fn withdraw_collateral(ctx: Context<AdjustCollateral>, amount: u64) -> Result<()> {
        require!(amount > 0, Err::ZeroAmount);
        let m = &mut ctx.accounts.market;
        require!(!m.frozen, Err::Frozen);
        let p = &mut ctx.accounts.position;
        require!(amount <= p.collateral, Err::InsufficientVaultFunds);

        let debt = m.debt_from_scaled(p.debt_scaled);
        let remaining = p.collateral - amount;
        if debt > 0 {
            require_fresh_index(m)?;
            let debt_value = m.value_at_index(debt);
            require!(
                remaining as u128 * BPS >= debt_value as u128 * m.params.initial_cr_bps as u128,
                Err::InsufficientCollateral
            );
        }
        p.collateral = remaining;
        m.total_collateral -= amount;
        let market_key = ctx.accounts.market.key();
        transfer_out(
            &ctx.accounts.sol_vault,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program,
            market_key,
            ctx.accounts.market.vault_bump,
            amount,
        )?;
        Ok(())
    }

    pub fn repay_burn(ctx: Context<RepayBurn>, amount: u64) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(!m.frozen, Err::Frozen);
        require!(amount > 0, Err::ZeroAmount);
        let p = &mut ctx.accounts.position;
        let debt = m.debt_from_scaled(p.debt_scaled);
        require!(amount <= debt, Err::RepayTooLarge);

        let scaled_repaid = if amount == debt {
            p.debt_scaled
        } else {
            (amount as u128 * FUNDING_ONE) / m.funding_index
        };
        p.debt_scaled -= scaled_repaid;
        m.total_debt_scaled = m.total_debt_scaled.saturating_sub(scaled_repaid);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.owner_ata.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        emit!(ShortChanged {
            market: ctx.accounts.market.key(),
            owner: ctx.accounts.owner.key(),
            collateral: ctx.accounts.position.collateral,
            debt: debt - amount,
        });
        Ok(())
    }

    pub fn accrue_funding(ctx: Context<AccrueFunding>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Live, Err::NotLive);
        require!(!m.frozen, Err::Frozen);
        require_fresh_index(m)?;
        let now = Clock::get()?.unix_timestamp;
        let dt = now - m.funding_last_ts;
        require!(dt >= m.params.min_crank_interval_secs as i64, Err::CrankTooSoon);

        match m.venue {
            Venue::Internal => update_mark(m)?,
            Venue::External => {
                // Mark is oracle-pushed for external venues; funding must
                // not run on a missing or stale mark.
                require!(m.mark_ema > 0, Err::NoMark);
                if m.params.max_index_age_secs > 0 {
                    require!(
                        now - m.mark_last_ts <= m.params.max_index_age_secs as i64,
                        Err::IndexStale
                    );
                }
            }
        }

        // premium in bps, positive when mark trades above index
        let premium_bps = (m.mark_ema as i128 - m.index_twap as i128) * BPS as i128
            / m.index_twap as i128;
        let mut rate_bps_per_day = premium_bps * m.params.funding_k_bps as i128 / BPS as i128;
        let clamp = m.params.max_funding_bps_per_day as i128;
        rate_bps_per_day = rate_bps_per_day.clamp(-clamp, clamp);

        // Mark above index pays shorts: their debt shrinks, funding_index falls.
        // Mark below index charges shorts: debt grows, pushing buy-and-burn.
        // Effective dt is capped at one day: a late crank forfeits the
        // excess instead of applying today's premium retroactively to an
        // unbounded gap, and the linear step can never zero the index.
        let dt_eff = (dt as i128).min(86_400);
        let delta = m.funding_index as i128 * rate_bps_per_day * dt_eff
            / (86_400 * BPS as i128);
        let new_index = m.funding_index as i128 - delta;
        require!(new_index > 0, Err::MathOverflow);
        m.funding_index = new_index as u128;
        m.funding_last_ts = now;
        emit!(FundingAccrued {
            market: m.key(),
            rate_bps_per_day: rate_bps_per_day as i64,
            funding_index_lo: m.funding_index as u64,
            mark: m.mark_ema,
            index: m.index_twap,
        });
        Ok(())
    }

    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Live, Err::NotLive);
        require!(!m.frozen, Err::Frozen);
        require_fresh_index(m)?;
        let p = &mut ctx.accounts.position;
        let debt = m.debt_from_scaled(p.debt_scaled);
        require!(debt > 0, Err::NotLiquidatable);

        let debt_value = m.value_at_index(debt);
        require!(
            (p.collateral as u128) * BPS < debt_value as u128 * m.params.maintenance_cr_bps as u128,
            Err::NotLiquidatable
        );

        // Liquidator burns the full debt from their own wallet.
        let target_payout = debt_value + mul_bps(debt_value, m.params.liq_bonus_bps);
        let mut payout = target_payout.min(p.collateral);
        let mut owner_refund = p.collateral - payout;
        if payout < target_payout {
            let topup = (target_payout - payout).min(m.insurance_lamports);
            m.insurance_lamports -= topup;
            payout += topup;
            owner_refund = 0;
        }

        m.total_collateral -= p.collateral;
        m.total_debt_scaled = m.total_debt_scaled.saturating_sub(p.debt_scaled);
        p.collateral = 0;
        p.debt_scaled = 0;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.liquidator_ata.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: ctx.accounts.liquidator.to_account_info(),
                },
            ),
            debt,
        )?;
        let market_key = ctx.accounts.market.key();
        let vault_bump = ctx.accounts.market.vault_bump;
        transfer_out(
            &ctx.accounts.sol_vault,
            &ctx.accounts.liquidator.to_account_info(),
            &ctx.accounts.system_program,
            market_key,
            vault_bump,
            payout,
        )?;
        if owner_refund > 0 {
            transfer_out(
                &ctx.accounts.sol_vault,
                &ctx.accounts.position_owner,
                &ctx.accounts.system_program,
                market_key,
                vault_bump,
                owner_refund,
            )?;
        }
        emit!(Liquidated {
            market: market_key,
            owner: ctx.accounts.position_owner.key(),
            liquidator: ctx.accounts.liquidator.key(),
            debt_burned: debt,
            payout,
        });
        Ok(())
    }

    pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
        let p = &ctx.accounts.position;
        require!(p.debt_scaled == 0, Err::DebtOutstanding);
        require!(p.collateral == 0, Err::InsufficientCollateral);
        Ok(())
    }

    /// Release an identity fee escrow. The escrow is a program-derived
    /// system account seeded by the hash of the identity (e.g.
    /// sha256("youtube:pokerev")); fees for unverified identities
    /// accumulate there via plain transfers. No key exists for it: funds
    /// can only leave through this admin-signed instruction after
    /// off-chain ownership verification, to the verified wallet.
    pub fn release_escrow(
        ctx: Context<ReleaseEscrow>,
        id_hash: [u8; 32],
        amount: Option<u64>,
    ) -> Result<()> {
        let bal = ctx.accounts.escrow.lamports();
        let amount = amount.unwrap_or(bal).min(bal);
        require!(amount > 0, Err::ZeroAmount);
        let seeds: &[&[u8]] = &[b"escrow", id_hash.as_ref(), &[ctx.bumps.escrow]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow.to_account_info(),
                    to: ctx.accounts.recipient.clone(),
                },
                &[seeds],
            ),
            amount,
        )?;
        emit!(EscrowReleased {
            id_hash,
            recipient: ctx.accounts.recipient.key(),
            amount,
        });
        Ok(())
    }

    /// Register an item mint (a specific vaulted-card NFT or collection
    /// NFT) as depositable into a market's item pool. Admin-gated in v1;
    /// on-chain collection verification replaces this at devnet.
    pub fn register_item(ctx: Context<RegisterItem>) -> Result<()> {
        let r = &mut ctx.accounts.registration;
        r.market = ctx.accounts.market.key();
        r.item_mint = ctx.accounts.item_mint.key();
        r.bump = ctx.bumps.registration;
        Ok(())
    }

    /// Deposit a registered item and receive tokens worth the item: the
    /// card's live index value divided by the token's mark price. Tokens
    /// come from the preminted item reserve, so supply stays fixed.
    pub fn deposit_item(ctx: Context<ItemSwap>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(!m.frozen, Err::Frozen);
        require_fresh_index(m)?;
        update_mark(m)?;
        require!(m.mark_ema > 0, Err::NoMark);

        // Tokens equal in value to one item at current prices. The index
        // is launch-scaled, so units_per_item_micro restores the item's
        // real size.
        let tokens_out = ((m.index_twap as u128
            * BASE_UNITS_PER_NFT
            * m.params.units_per_item_micro as u128)
            / m.mark_ema as u128
            / 1_000_000) as u64;
        require!(
            ctx.accounts.item_reserve.amount >= tokens_out,
            Err::ItemReserveDepleted
        );
        m.items_deposited += 1;

        // Item into the market escrow.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.user_item.to_account_info(),
                    to: ctx.accounts.escrow_item.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            1,
        )?;
        transfer_pool_tokens_out(
            &ctx.accounts.market,
            &ctx.accounts.item_reserve,
            &ctx.accounts.user_token,
            &ctx.accounts.token_program,
            tokens_out,
        )?;
        emit!(ItemSwapped {
            market: ctx.accounts.market.key(),
            user: ctx.accounts.user.key(),
            item_mint: ctx.accounts.item_mint.key(),
            deposited: true,
            tokens: tokens_out,
        });
        Ok(())
    }

    /// Return tokens worth one item and take a copy out of the escrow.
    pub fn withdraw_item(ctx: Context<ItemSwap>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(!m.frozen, Err::Frozen);
        require_fresh_index(m)?;
        update_mark(m)?;
        require!(m.mark_ema > 0, Err::NoMark);
        require!(ctx.accounts.escrow_item.amount >= 1, Err::ItemNotInEscrow);

        let tokens_in = ((m.index_twap as u128
            * BASE_UNITS_PER_NFT
            * m.params.units_per_item_micro as u128)
            / m.mark_ema as u128
            / 1_000_000) as u64;
        m.items_deposited = m.items_deposited.saturating_sub(1);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.user_token.to_account_info(),
                    to: ctx.accounts.item_reserve.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            tokens_in,
        )?;
        transfer_pool_tokens_out(
            &ctx.accounts.market,
            &ctx.accounts.escrow_item,
            &ctx.accounts.user_item,
            &ctx.accounts.token_program,
            1,
        )?;
        emit!(ItemSwapped {
            market: ctx.accounts.market.key(),
            user: ctx.accounts.user.key(),
            item_mint: ctx.accounts.item_mint.key(),
            deposited: false,
            tokens: tokens_in,
        });
        Ok(())
    }

    pub fn withdraw_fees(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(amount > 0 && amount <= m.fee_lamports, Err::InsufficientVaultFunds);
        m.fee_lamports -= amount;
        let market_key = ctx.accounts.market.key();
        transfer_out(
            &ctx.accounts.sol_vault,
            &ctx.accounts.recipient,
            &ctx.accounts.system_program,
            market_key,
            ctx.accounts.market.vault_bump,
            amount,
        )?;
        Ok(())
    }
}

// ---------- helpers ----------

fn mul_bps(amount: u64, bps: u16) -> u64 {
    ((amount as u128 * bps as u128) / BPS) as u64
}

/// Constant-product output amount for `amount_in` against reserves (in, out).
fn cp_out(reserve_in: u64, reserve_out: u64, amount_in: u64) -> Result<u64> {
    let k = reserve_in as u128 * reserve_out as u128;
    let new_in = reserve_in as u128 + amount_in as u128;
    let new_out = k.div_ceil(new_in);
    Ok((reserve_out as u128)
        .checked_sub(new_out)
        .ok_or(Err::MathOverflow)? as u64)
}

/// Staleness guard: with max_index_age_secs set, index-priced operations
/// (shorts, withdrawals against debt, funding, liquidations) refuse to run
/// on an index older than the configured age.
fn require_fresh_index(m: &Market) -> Result<()> {
    require!(m.index_twap > 0, Err::NoIndex);
    if m.params.max_index_age_secs > 0 {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now - m.index_last_ts <= m.params.max_index_age_secs as i64,
            Err::IndexStale
        );
    }
    Ok(())
}

fn update_mark(m: &mut Market) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    // Bootstrap markets have no AMM yet; the curve's virtual-reserve spot
    // is the venue price, so the mark EMA (and with it item swaps) works
    // in both phases with the same smoothing.
    let spot = match m.status {
        MarketStatus::Live => m.amm_spot_per_nft(),
        MarketStatus::Bootstrap => {
            if m.curve_virtual_tokens == 0 {
                0
            } else {
                ((m.curve_virtual_sol as u128 * BASE_UNITS_PER_NFT)
                    / m.curve_virtual_tokens as u128) as u64
            }
        }
    };
    if spot == 0 {
        return Ok(());
    }
    let dt = now - m.mark_last_ts;
    if dt > 0 {
        m.mark_ema = ema_step(m.mark_ema, spot, dt, m.params.mark_window_secs);
        m.mark_last_ts = now;
    }
    Ok(())
}

fn transfer_in<'info>(
    from: &Signer<'info>,
    vault: &SystemAccount<'info>,
    system_program: &Program<'info, System>,
    lamports: u64,
) -> Result<()> {
    system_program::transfer(
        CpiContext::new(
            system_program.to_account_info(),
            Transfer {
                from: from.to_account_info(),
                to: vault.to_account_info(),
            },
        ),
        lamports,
    )
}

fn transfer_out<'info>(
    vault: &SystemAccount<'info>,
    to: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    market_key: Pubkey,
    vault_bump: u8,
    lamports: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &[vault_bump]];
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            Transfer {
                from: vault.to_account_info(),
                to: to.clone(),
            },
            &[seeds],
        ),
        lamports,
    )
}

fn mint_synth<'info>(
    market: &Account<'info, Market>,
    mint: &Account<'info, Mint>,
    to: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[b"market", market.collection.as_ref(), &[market.bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            MintTo {
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: market.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

fn transfer_pool_tokens_out<'info>(
    market: &Account<'info, Market>,
    pool: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[b"market", market.collection.as_ref(), &[market.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            token::Transfer {
                from: pool.to_account_info(),
                to: to.to_account_info(),
                authority: market.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

// ---------- events ----------

#[event]
pub struct IndexPushed {
    pub market: Pubkey,
    pub raw: u64,
    pub twap: u64,
}

#[event]
pub struct BreakerTripped {
    pub market: Pubkey,
    pub observed: u64,
    pub twap: u64,
}

#[event]
pub struct CurveTraded {
    pub market: Pubkey,
    pub user: Pubkey,
    pub is_buy: bool,
    pub sol_amount: u64,
    pub token_amount: u64,
}

#[event]
pub struct Graduated {
    pub market: Pubkey,
    pub amm_sol: u64,
    pub amm_tokens: u64,
    pub insurance: u64,
}

#[event]
pub struct AmmTraded {
    pub market: Pubkey,
    pub user: Pubkey,
    pub is_buy: bool,
    pub sol_amount: u64,
    pub token_amount: u64,
}

#[event]
pub struct ShortChanged {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub collateral: u64,
    pub debt: u64,
}

#[event]
pub struct FundingAccrued {
    pub market: Pubkey,
    pub rate_bps_per_day: i64,
    pub funding_index_lo: u64,
    pub mark: u64,
    pub index: u64,
}

#[event]
pub struct ItemSwapped {
    pub market: Pubkey,
    pub user: Pubkey,
    pub item_mint: Pubkey,
    pub deposited: bool,
    pub tokens: u64,
}

#[event]
pub struct EscrowReleased {
    pub id_hash: [u8; 32],
    pub recipient: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Liquidated {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub liquidator: Pubkey,
    pub debt_burned: u64,
    pub payout: u64,
}

// ---------- contexts ----------

#[derive(Accounts)]
pub struct InitGlobal<'info> {
    #[account(init, payer = admin, space = 8 + Global::INIT_SPACE, seeds = [b"global"], bump)]
    pub global: Account<'info, Global>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminGlobal<'info> {
    #[account(mut, seeds = [b"global"], bump = global.bump, has_one = admin)]
    pub global: Account<'info, Global>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminMarket<'info> {
    #[account(seeds = [b"global"], bump = global.bump, has_one = admin)]
    pub global: Account<'info, Global>,
    pub admin: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
#[instruction(collection: Pubkey)]
pub struct CreateMarket<'info> {
    #[account(seeds = [b"global"], bump = global.bump, has_one = admin)]
    pub global: Box<Account<'info, Global>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", collection.as_ref()],
        bump
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init,
        payer = admin,
        seeds = [b"mint", market.key().as_ref()],
        bump,
        mint::decimals = SYNTH_DECIMALS,
        mint::authority = market
    )]
    pub synth_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        seeds = [b"pool", market.key().as_ref()],
        bump,
        token::mint = synth_mint,
        token::authority = market
    )]
    pub pool_token: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = admin,
        seeds = [b"treasury", market.key().as_ref()],
        bump,
        token::mint = synth_mint,
        token::authority = market
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = admin,
        seeds = [b"items", market.key().as_ref()],
        bump,
        token::mint = synth_mint,
        token::authority = market
    )]
    pub item_reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump)]
    pub sol_vault: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(collection: Pubkey)]
pub struct CreateExternalMarket<'info> {
    #[account(seeds = [b"global"], bump = global.bump, has_one = admin)]
    pub global: Account<'info, Global>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", collection.as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,
    /// The externally launched token mint (e.g. created by Meteora DBC).
    pub synth_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [b"treasury", market.key().as_ref()],
        bump,
        token::mint = synth_mint,
        token::authority = market
    )]
    pub treasury: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump)]
    pub sol_vault: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PushIndex<'info> {
    #[account(seeds = [b"global"], bump = global.bump)]
    pub global: Account<'info, Global>,
    #[account(constraint = oracle_authority.key() == global.oracle_authority @ Err::Unauthorized)]
    pub oracle_authority: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct CurveTrade<'info> {
    #[account(mut, seeds = [b"market", market.collection.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"mint", market.key().as_ref()], bump = market.mint_bump)]
    pub synth_mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"pool", market.key().as_ref()], bump)]
    pub pool_token: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = synth_mint,
        associated_token::authority = user
    )]
    pub user_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(mut, seeds = [b"market", market.collection.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"mint", market.key().as_ref()], bump = market.mint_bump)]
    pub synth_mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"pool", market.key().as_ref()], bump)]
    pub pool_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AmmTrade<'info> {
    #[account(mut, seeds = [b"market", market.collection.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"mint", market.key().as_ref()], bump = market.mint_bump)]
    pub synth_mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"pool", market.key().as_ref()], bump)]
    pub pool_token: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = synth_mint,
        associated_token::authority = user
    )]
    pub user_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenShort<'info> {
    #[account(mut, seeds = [b"market", market.collection.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, address = market.synth_mint)]
    pub synth_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"treasury", market.key().as_ref()],
        bump = market.treasury_bump
    )]
    pub treasury: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + ShortPosition::INIT_SPACE,
        seeds = [b"short", market.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub position: Account<'info, ShortPosition>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = synth_mint,
        associated_token::authority = owner
    )]
    pub owner_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdjustCollateral<'info> {
    #[account(mut, seeds = [b"market", market.collection.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [b"short", market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = owner
    )]
    pub position: Account<'info, ShortPosition>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RepayBurn<'info> {
    #[account(mut, seeds = [b"market", market.collection.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, address = market.synth_mint)]
    pub synth_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"treasury", market.key().as_ref()],
        bump = market.treasury_bump
    )]
    pub treasury: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"short", market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = owner
    )]
    pub position: Account<'info, ShortPosition>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, associated_token::mint = synth_mint, associated_token::authority = owner)]
    pub owner_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AccrueFunding<'info> {
    #[account(mut, seeds = [b"market", market.collection.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(mut, seeds = [b"market", market.collection.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, address = market.synth_mint)]
    pub synth_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"treasury", market.key().as_ref()],
        bump = market.treasury_bump
    )]
    pub treasury: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [b"short", market.key().as_ref(), position_owner.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == position_owner.key() @ Err::Unauthorized
    )]
    pub position: Account<'info, ShortPosition>,
    /// CHECK: receives the collateral remainder; validated against position.owner.
    #[account(mut)]
    pub position_owner: AccountInfo<'info>,
    #[account(mut)]
    pub liquidator: Signer<'info>,
    #[account(mut, associated_token::mint = synth_mint, associated_token::authority = liquidator)]
    pub liquidator_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(
        mut,
        close = owner,
        seeds = [b"short", position.market.as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = owner
    )]
    pub position: Account<'info, ShortPosition>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(id_hash: [u8; 32])]
pub struct ReleaseEscrow<'info> {
    #[account(seeds = [b"global"], bump = global.bump, has_one = admin)]
    pub global: Account<'info, Global>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"escrow", id_hash.as_ref()], bump)]
    pub escrow: SystemAccount<'info>,
    /// CHECK: verified wallet chosen after off-chain identity proof.
    #[account(mut)]
    pub recipient: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterItem<'info> {
    #[account(seeds = [b"global"], bump = global.bump, has_one = admin)]
    pub global: Account<'info, Global>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub market: Account<'info, Market>,
    pub item_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = 8 + ItemRegistration::INIT_SPACE,
        seeds = [b"item", market.key().as_ref(), item_mint.key().as_ref()],
        bump
    )]
    pub registration: Account<'info, ItemRegistration>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ItemSwap<'info> {
    #[account(mut, seeds = [b"market", market.collection.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    pub item_mint: Box<Account<'info, Mint>>,
    #[account(
        seeds = [b"item", market.key().as_ref(), item_mint.key().as_ref()],
        bump = registration.bump,
        constraint = registration.item_mint == item_mint.key() @ Err::ItemNotRegistered
    )]
    pub registration: Box<Account<'info, ItemRegistration>>,
    #[account(
        mut,
        seeds = [b"items", market.key().as_ref()],
        bump
    )]
    pub item_reserve: Box<Account<'info, TokenAccount>>,
    /// The market's escrow for this specific item mint.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = item_mint,
        associated_token::authority = market
    )]
    pub escrow_item: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = item_mint,
        associated_token::authority = user
    )]
    pub user_item: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.synth_mint)]
    pub synth_mint: Box<Account<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = synth_mint,
        associated_token::authority = user
    )]
    pub user_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(seeds = [b"global"], bump = global.bump, has_one = admin)]
    pub global: Account<'info, Global>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"market", market.collection.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub sol_vault: SystemAccount<'info>,
    /// CHECK: fee destination chosen by admin.
    #[account(mut)]
    pub recipient: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}
