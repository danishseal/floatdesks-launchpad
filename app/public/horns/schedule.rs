//! Schedule Horn — a `before_swap` pricing Horn that runs a **gradual dutch
//! auction** inside the venue, ported from Doppler (Whetstone Research) by way
//! of Vector's `schedule-vector`.
//!
//! The part worth porting is the schedule, not the plumbing. A sale runs for
//! `duration_seconds` from a `start_time`; over that window the price the venue
//! offers the token ramps from a `start_price` to an `end_price`. A dutch
//! auction opens expensive and decays, so `start_price > end_price` is the
//! usual bootstrap shape, but the ramp is linear and works in either direction.
//!
//! # What ports, and what does not
//!
//! Doppler (and Vector) state the schedule in ticks and drive it with an
//! **accumulator** that reads realised demand (`netSold`) in `after_swap` and
//! rebalances the curve up or down against it. That demand feedback needs
//! mutable state written on every swap. The ANSEM Horns interface is a single
//! read-only `before_swap` QUERY (`Deps`, not `DepsMut`) with no `after_swap`
//! execute hook, so there is nowhere to keep a running accumulator and nothing
//! measures demand. What is left, and what this Horn implements, is the honest
//! subset that is a pure function of the clock: a **time-parameterised** dutch
//! auction whose price is fixed by `env.block.time` alone. Waiting gets a buyer
//! the decayed price; nothing they or anyone else trades moves the schedule.
//!
//! # Delta, not fee
//!
//! Vector's `schedule-vector` could not use `BEFORE_SWAP_RETURNS_DELTA` (its
//! curve venue rejects deltas and settling one needs deps it could not add), so
//! it expressed the whole auction as an **LP fee override**, which can only ever
//! make the trader's price *worse* than pool spot. The ANSEM AMM re-validates
//! and settles a returned `Delta` itself (`amount_in == offered`,
//! `amount_out <= reserve`, `amount_out > 0`), so this port takes the path
//! Vector wanted but could not reach: it prices the swap directly against the
//! scheduled price and hands the AMM `(amount_in, amount_out)`, exactly like
//! `horn-curve` — only here the "curve" is the time-parameterised schedule
//! rather than a StableSwap invariant. This is strictly closer to Doppler's
//! ideal than the fee-band compromise, because the scheduled price can sit above
//! *or* below pool spot.
//!
//! # Safety
//!
//! For any degenerate input — zero reserves/amount, a zero or unset price, a
//! computed fill that is zero or larger than the reserve — it returns `Proceed`,
//! so the AMM falls back to its own constant-product math and a swap is never
//! broken by this Horn. The AMM re-validates the returned delta regardless.
//! Trades before `start_time` are priced at `start_price` (the schedule is
//! clamped to `[0, duration]`), never rejected.
//!
//! # Rounding
//!
//! The output is floored and an optional `fee_bps` is baked into a smaller
//! output (kept by the pool for LPs / the issuer), so every rounding decision
//! favours the sale over the taker, matching Doppler's discipline.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_binary, Addr, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult,
    Uint128, Uint256,
};
use cw_storage_plus::Item;
use thiserror::Error;

const BPS: u128 = 10_000;
const MAX_HOOK_FEE_BPS: u16 = 1000; // must match amm::hooks::MAX_HOOK_FEE_BPS

/// Widest tolerance band and the ceiling on the per-swap fill fraction (100%).
pub const MAX_BPS: u16 = BPS as u16;

/// Fixed-point denominator for a price. A `price` is `uchanse` base-units per
/// one token base-unit, multiplied by `PRICE_SCALE`. So a price_scaled of
/// `PRICE_SCALE` means 1 uchanse per token base-unit, `2 * PRICE_SCALE` means 2,
/// and `PRICE_SCALE / 2` means one uchanse buys two token base-units.
pub const PRICE_SCALE: u128 = 1_000_000;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("fee bps must be <= {MAX_HOOK_FEE_BPS}")]
    FeeTooHigh {},
    #[error("duration must be > 0")]
    BadDuration {},
    #[error("start and end price must be > 0")]
    BadPrice {},
    #[error("max_fill_bps must be between 1 and {MAX_BPS}")]
    BadMaxFill {},
    #[error("tolerance_bps must be <= {MAX_BPS}")]
    BadTolerance {},
}

// ── mirrors of amm::hooks (serialize identically, so the AMM's query/response
//    round-trips without a shared crate dependency) ──────────────────────────

#[cw_serde]
pub struct SwapContext {
    pub token_address: String,
    pub sender: String,
    pub offer_ansem: bool,
    pub input_amount: Uint128,
    pub ansem_reserve: Uint128,
    pub token_reserve: Uint128,
    pub default_fee_bps: u16,
}

#[cw_serde]
pub enum HookDecision {
    Proceed,
    Reject { reason: String },
    OverrideFee { fee_bps: u16 },
    Delta { amount_in: Uint128, amount_out: Uint128 },
}

// ── state ───────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    /// Price at `start_time`, as `uchanse`-per-token-base-unit * `PRICE_SCALE`.
    /// For a dutch auction this is the high end.
    pub start_price: Uint128,
    /// Price at `start_time + duration_seconds`, same units. The low end.
    pub end_price: Uint128,
    /// Length of the ramp in seconds.
    pub duration_seconds: u64,
    /// Unix seconds the schedule opens. Set from `env.block.time` at instantiate
    /// unless the caller pins an explicit value.
    pub start_time: u64,
    /// Trading fee (bps) baked into the output; kept by the pool for LPs.
    pub fee_bps: u16,
    /// Explicit on/off switch. When `false` the Horn always returns `Proceed`,
    /// so the admin can retire the schedule without leaving it quoting a stale
    /// price. The schedule is also treated as ended (→ `Proceed`) automatically
    /// once `now >= start_time + duration_seconds`.
    pub enabled: bool,
    /// A single swap may fill at most this fraction (bps) of the out-reserve.
    /// The scheduled price is size-independent and zero-slippage, so without a
    /// cap one whale swap drains a full reserve side at the scheduled price; a
    /// fill larger than the cap falls back to `Proceed` (constant product).
    pub max_fill_bps: u16,
    /// The Delta only fires while the scheduled price is within this many bps of
    /// the live pool ratio `ansem_reserve / token_reserve`. The scheduled price
    /// is a pure function of the clock and ignores the pool; once it diverges
    /// from the pool ratio the quote is an arbitrage gift the AMM settles from
    /// reserves without a constant-product re-check, so off band we `Proceed`.
    pub tolerance_bps: u16,
}

const CONFIG: Item<Config> = Item::new("config");

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub start_price: Uint128,
    pub end_price: Uint128,
    pub duration_seconds: u64,
    /// `None` stamps the schedule's start at the current block time.
    pub start_time: Option<u64>,
    pub fee_bps: u16,
    /// `None` defaults to enabled.
    pub enabled: Option<bool>,
    pub max_fill_bps: u16,
    pub tolerance_bps: u16,
}

#[cw_serde]
pub enum ExecuteMsg {
    UpdateConfig {
        admin: Option<String>,
        start_price: Option<Uint128>,
        end_price: Option<Uint128>,
        duration_seconds: Option<u64>,
        start_time: Option<u64>,
        fee_bps: Option<u16>,
        enabled: Option<bool>,
        max_fill_bps: Option<u16>,
        tolerance_bps: Option<u16>,
    },
}

/// Mirrors `amm::hooks::HookQuery` so the AMM's `before_swap` query deserializes
/// here and gets back a `HookDecision`.
#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(HookDecision)]
    BeforeSwap { ctx: SwapContext },
    #[returns(Config)]
    Config {},
    /// The live scheduled price (scaled) at a given unix time, for tooling / UI.
    #[returns(Uint128)]
    PriceAt { time: u64 },
}

// ── the schedule arithmetic, kept pure so it can be tested without a chain ───

/// Linear interpolation of the scheduled price at `now`.
///
/// Clamped to `[start_time, start_time + duration]`: before the sale opens the
/// price is `start_price`, after it closes the price is `end_price`. Works for
/// `end >= start` (a ramp up) and `end < start` (the usual dutch decay). All
/// intermediate math is in `Uint256`, so a large price times a long duration
/// cannot overflow.
pub fn scheduled_price(
    start_price: u128,
    end_price: u128,
    duration_seconds: u64,
    start_time: u64,
    now: u64,
) -> u128 {
    if duration_seconds == 0 {
        return end_price;
    }
    let elapsed = now.saturating_sub(start_time).min(duration_seconds);
    let e = Uint256::from(elapsed);
    let d = Uint256::from(duration_seconds);
    if end_price >= start_price {
        let span = Uint256::from(end_price - start_price);
        let delta = span * e / d;
        (Uint256::from(start_price) + delta)
            .try_into()
            .map(|v: Uint128| v.u128())
            .unwrap_or(end_price)
    } else {
        let span = Uint256::from(start_price - end_price);
        let delta = span * e / d;
        (Uint256::from(start_price) - delta)
            .try_into()
            .map(|v: Uint128| v.u128())
            .unwrap_or(end_price)
    }
}

/// Price one swap at the scheduled price. Returns the gross output (before fee)
/// in the output denom's base units, or `None` if the schedule cannot produce a
/// valid, positive, reserve-bounded fill.
///
/// `offer_ansem` decides the direction and therefore the units:
/// - buying the token with uchanse: `out_tokens = input * PRICE_SCALE / price`
/// - selling the token for uchanse: `out_ansem  = input * price / PRICE_SCALE`
#[allow(clippy::too_many_arguments)]
pub fn scheduled_out(
    input: Uint128,
    offer_ansem: bool,
    out_reserve: Uint128,
    price_scaled: u128,
) -> Option<u128> {
    if input.is_zero() || out_reserve.is_zero() || price_scaled == 0 {
        return None;
    }
    let inp = Uint256::from(input.u128());
    let price = Uint256::from(price_scaled);
    let scale = Uint256::from(PRICE_SCALE);
    let out: Uint256 = if offer_ansem {
        inp * scale / price
    } else {
        inp * price / scale
    };
    let out_u128: u128 = Uint128::try_from(out).ok()?.u128();
    if out_u128 == 0 || out_u128 > out_reserve.u128() {
        return None;
    }
    Some(out_u128)
}

/// Is the scheduled price within `tolerance_bps` of the live pool ratio
/// `ansem_reserve / token_reserve` (both on the same `PRICE_SCALE`)?
///
/// The scheduled price is a pure function of the clock and ignores the pool. If
/// it has drifted off the pool ratio, quoting it hands the AMM an arbitrage
/// price it settles from reserves without a constant-product re-check, so the
/// caller `Proceed`s when this is false. Compared by cross-multiplication in
/// `Uint256` so there is no division. Returns `None` on any overflow or a
/// degenerate reserve (either side zero), which the caller treats the same as
/// off band (→ `Proceed`). `start_price`/`end_price` have no upper bound, so an
/// adversarial near-`u128::MAX` price times a large reserve can push these
/// products past `2^256`; a bare `Uint256` `*` would PANIC there, and this is a
/// read-only `before_swap` query where a panic is NOT caught by the fallback —
/// it aborts every swap on the pool. Checked math degrades to `None` instead.
fn within_tolerance(
    price_scaled: u128,
    ansem_reserve: Uint128,
    token_reserve: Uint128,
    tolerance_bps: u16,
) -> Option<bool> {
    if ansem_reserve.is_zero() || token_reserve.is_zero() || price_scaled == 0 {
        return None;
    }
    // pool ratio = ar/tr, quoted = price/PRICE_SCALE.
    // |price/PRICE_SCALE - ar/tr| <= tol * ar/tr
    // <=> |price*tr - ar*PRICE_SCALE| * BPS <= tol_bps * ar * PRICE_SCALE.
    let ar = Uint256::from(ansem_reserve.u128());
    let tr = Uint256::from(token_reserve.u128());
    let price = Uint256::from(price_scaled);
    let scale = Uint256::from(PRICE_SCALE);
    let lhs_a = price.checked_mul(tr).ok()?;
    let lhs_b = ar.checked_mul(scale).ok()?;
    let diff = if lhs_a >= lhs_b { lhs_a - lhs_b } else { lhs_b - lhs_a };
    let scaled_diff = diff.checked_mul(Uint256::from(BPS)).ok()?;
    let bound = Uint256::from(tolerance_bps as u128)
        .checked_mul(ar)
        .ok()?
        .checked_mul(scale)
        .ok()?;
    Some(scaled_diff <= bound)
}

// ── entry points ────────────────────────────────────────────────────────────

fn check_prices(start: Uint128, end: Uint128) -> Result<(), ContractError> {
    if start.is_zero() || end.is_zero() {
        return Err(ContractError::BadPrice {});
    }
    Ok(())
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    cw2::set_contract_version(deps.storage, "ansem-horn-schedule", env!("CARGO_PKG_VERSION"))?;
    if msg.fee_bps > MAX_HOOK_FEE_BPS {
        return Err(ContractError::FeeTooHigh {});
    }
    if msg.duration_seconds == 0 {
        return Err(ContractError::BadDuration {});
    }
    check_prices(msg.start_price, msg.end_price)?;
    if msg.max_fill_bps < 1 || msg.max_fill_bps > MAX_BPS {
        return Err(ContractError::BadMaxFill {});
    }
    if msg.tolerance_bps > MAX_BPS {
        return Err(ContractError::BadTolerance {});
    }
    CONFIG.save(
        deps.storage,
        &Config {
            admin: deps.api.addr_validate(&msg.admin)?,
            start_price: msg.start_price,
            end_price: msg.end_price,
            duration_seconds: msg.duration_seconds,
            start_time: msg.start_time.unwrap_or_else(|| env.block.time.seconds()),
            fee_bps: msg.fee_bps,
            enabled: msg.enabled.unwrap_or(true),
            max_fill_bps: msg.max_fill_bps,
            tolerance_bps: msg.tolerance_bps,
        },
    )?;
    Ok(Response::new().add_attribute("action", "instantiate"))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    let ExecuteMsg::UpdateConfig {
        admin,
        start_price,
        end_price,
        duration_seconds,
        start_time,
        fee_bps,
        enabled,
        max_fill_bps,
        tolerance_bps,
    } = msg;
    let mut cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    if let Some(a) = admin {
        cfg.admin = deps.api.addr_validate(&a)?;
    }
    if let Some(p) = start_price {
        cfg.start_price = p;
    }
    if let Some(p) = end_price {
        cfg.end_price = p;
    }
    if let Some(d) = duration_seconds {
        if d == 0 {
            return Err(ContractError::BadDuration {});
        }
        cfg.duration_seconds = d;
    }
    if let Some(t) = start_time {
        cfg.start_time = t;
    }
    if let Some(f) = fee_bps {
        if f > MAX_HOOK_FEE_BPS {
            return Err(ContractError::FeeTooHigh {});
        }
        cfg.fee_bps = f;
    }
    if let Some(e) = enabled {
        cfg.enabled = e;
    }
    if let Some(m) = max_fill_bps {
        if m < 1 || m > MAX_BPS {
            return Err(ContractError::BadMaxFill {});
        }
        cfg.max_fill_bps = m;
    }
    if let Some(t) = tolerance_bps {
        if t > MAX_BPS {
            return Err(ContractError::BadTolerance {});
        }
        cfg.tolerance_bps = t;
    }
    check_prices(cfg.start_price, cfg.end_price)?;
    CONFIG.save(deps.storage, &cfg)?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::BeforeSwap { ctx } => to_binary(&decide(deps, &env, ctx)),
        QueryMsg::Config {} => to_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::PriceAt { time } => {
            let cfg = CONFIG.load(deps.storage)?;
            to_binary(&Uint128::new(scheduled_price(
                cfg.start_price.u128(),
                cfg.end_price.u128(),
                cfg.duration_seconds,
                cfg.start_time,
                time,
            )))
        }
    }
}

/// The pricing decision: quote the swap at the scheduled price for the current
/// block time, bake in the fee, and return an exact `Delta`. Any degenerate
/// situation falls back to `Proceed` so the AMM's own curve fills the swap.
fn decide(deps: Deps, env: &Env, ctx: SwapContext) -> HookDecision {
    let cfg = match CONFIG.load(deps.storage) {
        Ok(c) => c,
        Err(_) => return HookDecision::Proceed,
    };
    // Explicit off switch: a retired schedule must never keep quoting.
    if !cfg.enabled {
        return HookDecision::Proceed;
    }
    let now = env.block.time.seconds();
    // Once the ramp has fully elapsed the schedule would quote `end_price`
    // forever, and since the quote is size-independent and zero-slippage a single
    // swap would drain a whole reserve side at that stale price. After the sale
    // closes, hand the swap back to the AMM's own constant-product curve.
    if now >= cfg.start_time.saturating_add(cfg.duration_seconds) {
        return HookDecision::Proceed;
    }
    let price = scheduled_price(
        cfg.start_price.u128(),
        cfg.end_price.u128(),
        cfg.duration_seconds,
        cfg.start_time,
        now,
    );
    // Only quote while the scheduled price tracks the live pool ratio. Off band
    // (or any overflow computing the band) the Delta is an arbitrage gift the
    // AMM settles from reserves without a constant-product re-check, so fall back
    // to Proceed.
    match within_tolerance(price, ctx.ansem_reserve, ctx.token_reserve, cfg.tolerance_bps) {
        Some(true) => {}
        _ => return HookDecision::Proceed,
    }
    // Output side per direction: a uchanse-in buys the token, a token-in sells
    // for uchanse.
    let out_reserve = if ctx.offer_ansem {
        ctx.token_reserve
    } else {
        ctx.ansem_reserve
    };
    let gross = match scheduled_out(ctx.input_amount, ctx.offer_ansem, out_reserve, price) {
        Some(g) => g,
        None => return HookDecision::Proceed, // safe fall-back to constant product
    };
    // Bake the fee into a smaller output; the difference stays in the pool. Done
    // in Uint256 so the `gross * BPS` intermediate cannot overflow u128 (which,
    // with overflow-checks = true, would abort the query and brick the swap).
    let net: u128 = (Uint256::from(gross) * Uint256::from(BPS - cfg.fee_bps as u128)
        / Uint256::from(BPS))
    .try_into()
    .map(|v: Uint128| v.u128())
    .unwrap_or(0);
    if net == 0 || net > out_reserve.u128() {
        return HookDecision::Proceed;
    }
    // Cap a single fill to a fraction of the out-reserve. The scheduled price is
    // zero-slippage, so without this cap one whale swap drains a full reserve
    // side at the scheduled price; a fill over the cap falls back to Proceed.
    let max_fill: u128 = (Uint256::from(out_reserve.u128())
        * Uint256::from(cfg.max_fill_bps as u128)
        / Uint256::from(BPS))
    .try_into()
    .map(|v: Uint128| v.u128())
    .unwrap_or(0);
    if net > max_fill {
        return HookDecision::Proceed;
    }
    HookDecision::Delta {
        amount_in: ctx.input_amount,
        amount_out: Uint128::new(net),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};

    // ── pure schedule math ───────────────────────────────────────────────────

    #[test]
    fn price_is_start_before_and_at_open() {
        // dutch auction: 2.0 -> 1.0 over 100s, opening at t=1000.
        let hi = 2 * PRICE_SCALE;
        let lo = PRICE_SCALE;
        assert_eq!(scheduled_price(hi, lo, 100, 1000, 900), hi, "before open");
        assert_eq!(scheduled_price(hi, lo, 100, 1000, 1000), hi, "at open");
    }

    #[test]
    fn price_ramps_linearly_and_clamps_at_end() {
        let hi = 2 * PRICE_SCALE;
        let lo = PRICE_SCALE;
        // Halfway through: exactly the midpoint of the band.
        assert_eq!(scheduled_price(hi, lo, 100, 1000, 1050), hi - (hi - lo) / 2);
        // 90% through.
        assert_eq!(scheduled_price(hi, lo, 100, 1000, 1090), hi - (hi - lo) * 90 / 100);
        // At and past the end: pinned to end_price.
        assert_eq!(scheduled_price(hi, lo, 100, 1000, 1100), lo);
        assert_eq!(scheduled_price(hi, lo, 100, 1000, 9999), lo, "past the end");
    }

    #[test]
    fn price_ramp_up_direction_also_works() {
        let lo = PRICE_SCALE;
        let hi = 3 * PRICE_SCALE;
        assert_eq!(scheduled_price(lo, hi, 100, 0, 0), lo);
        assert_eq!(scheduled_price(lo, hi, 100, 0, 50), lo + (hi - lo) / 2);
        assert_eq!(scheduled_price(lo, hi, 100, 0, 100), hi);
    }

    #[test]
    fn zero_duration_is_end_price() {
        assert_eq!(scheduled_price(5, 9, 0, 0, 0), 9);
    }

    #[test]
    fn scheduled_out_prices_both_directions() {
        // price = 2.0 uchanse per token base-unit.
        let price = 2 * PRICE_SCALE;
        // buy token with 1_000_000 uchanse -> 500_000 tokens.
        let out = scheduled_out(Uint128::new(1_000_000), true, Uint128::new(10_000_000), price).unwrap();
        assert_eq!(out, 500_000);
        // sell 500_000 tokens -> 1_000_000 uchanse.
        let out = scheduled_out(Uint128::new(500_000), false, Uint128::new(10_000_000), price).unwrap();
        assert_eq!(out, 1_000_000);
    }

    #[test]
    fn scheduled_out_degenerate_inputs_fall_back() {
        let price = PRICE_SCALE;
        assert!(scheduled_out(Uint128::zero(), true, Uint128::new(10), price).is_none());
        assert!(scheduled_out(Uint128::new(10), true, Uint128::zero(), price).is_none());
        assert!(scheduled_out(Uint128::new(10), true, Uint128::new(10), 0).is_none());
        // A fill larger than the reserve is refused (Proceed), never overfills.
        assert!(scheduled_out(Uint128::new(1_000_000), true, Uint128::new(5), 1).is_none());
    }

    #[test]
    fn dutch_auction_gives_more_tokens_as_time_passes() {
        // Same uchanse in, later in the sale -> strictly more token out, because
        // the price has decayed. This is the whole point of the mechanism.
        let hi = 2 * PRICE_SCALE;
        let lo = PRICE_SCALE;
        let early = scheduled_price(hi, lo, 100, 0, 0);
        let late = scheduled_price(hi, lo, 100, 0, 90);
        let out_early = scheduled_out(Uint128::new(1_000_000), true, Uint128::new(u128::MAX >> 8), early).unwrap();
        let out_late = scheduled_out(Uint128::new(1_000_000), true, Uint128::new(u128::MAX >> 8), late).unwrap();
        assert!(out_late > out_early, "later buyers should get more token");
    }

    // ── full decide() path ───────────────────────────────────────────────────

    fn ctx(input: u128, ar: u128, tr: u128, offer_ansem: bool) -> SwapContext {
        SwapContext {
            token_address: "token".into(),
            sender: "trader".into(),
            offer_ansem,
            input_amount: Uint128::new(input),
            ansem_reserve: Uint128::new(ar),
            token_reserve: Uint128::new(tr),
            default_fee_bps: 100,
        }
    }

    /// Widest gates (100% tolerance, 100% max fill, enabled): keeps the classic
    /// decide() assertions exercising only the schedule arithmetic.
    fn init(deps: DepsMut, env: &Env, start: u128, end: u128, dur: u64, start_time: u64, fee: u16) {
        init_full(deps, env, start, end, dur, start_time, fee, true, MAX_BPS, MAX_BPS);
    }

    #[allow(clippy::too_many_arguments)]
    fn init_full(
        deps: DepsMut,
        env: &Env,
        start: u128,
        end: u128,
        dur: u64,
        start_time: u64,
        fee: u16,
        enabled: bool,
        max_fill_bps: u16,
        tolerance_bps: u16,
    ) {
        instantiate(
            deps,
            env.clone(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                start_price: Uint128::new(start),
                end_price: Uint128::new(end),
                duration_seconds: dur,
                start_time: Some(start_time),
                fee_bps: fee,
                enabled: Some(enabled),
                max_fill_bps,
                tolerance_bps,
            },
        )
        .unwrap();
    }

    #[test]
    fn decide_returns_delta_and_charges_fee() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        // start the schedule at the current block time, 2.0 -> 1.0 over 100s.
        let t0 = env.block.time.seconds();
        init(deps.as_mut(), &env, 2 * PRICE_SCALE, PRICE_SCALE, 100, t0, 30);
        // at open (t == t0), price is 2.0: 1_000_000 uchanse buys ~500_000 token, minus 30bps.
        let d = decide(deps.as_ref(), &env, ctx(1_000_000, 10_000_000, 10_000_000, true));
        match d {
            HookDecision::Delta { amount_in, amount_out } => {
                assert_eq!(amount_in, Uint128::new(1_000_000));
                // 500_000 gross, less 30bps = 498_500.
                assert_eq!(amount_out, Uint128::new(498_500));
            }
            other => panic!("expected Delta, got {other:?}"),
        }
    }

    #[test]
    fn decide_prices_cheaper_later_in_the_sale() {
        let mut deps = mock_dependencies();
        let mut env = mock_env();
        let t0 = env.block.time.seconds();
        init(deps.as_mut(), &env, 2 * PRICE_SCALE, PRICE_SCALE, 100, t0, 0);
        let early = decide(deps.as_ref(), &env, ctx(1_000_000, 10_000_000, 10_000_000, true));
        // 90% through the ramp (still open; the schedule quotes Proceed once now
        // reaches start+duration). Price has decayed toward 1.1, so the same
        // uchanse buys strictly more token.
        env.block.time = env.block.time.plus_seconds(90);
        let late = decide(deps.as_ref(), &env, ctx(1_000_000, 10_000_000, 10_000_000, true));
        let (e, l) = match (early, late) {
            (HookDecision::Delta { amount_out: e, .. }, HookDecision::Delta { amount_out: l, .. }) => (e, l),
            other => panic!("expected two Deltas, got {other:?}"),
        };
        assert!(l > e, "later buyer gets more token out ({l} !> {e})");
    }

    #[test]
    fn decide_falls_back_to_proceed_when_fill_exceeds_reserve() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let t0 = env.block.time.seconds();
        // cheap price -> huge token-out, but reserve is tiny: must Proceed.
        init(deps.as_mut(), &env, PRICE_SCALE / 1000, PRICE_SCALE / 1000, 100, t0, 0);
        let d = decide(deps.as_ref(), &env, ctx(1_000_000, 10, 10, true));
        assert_eq!(d, HookDecision::Proceed);
    }

    #[test]
    fn decide_proceeds_with_no_config() {
        let deps = mock_dependencies();
        let env = mock_env();
        assert_eq!(
            decide(deps.as_ref(), &env, ctx(1_000, 1_000, 1_000, true)),
            HookDecision::Proceed
        );
    }

    /// Regression (HIGH): the scheduled price is size-independent and
    /// zero-slippage, so without a per-swap cap one whale swap drains a full
    /// reserve side at the scheduled price. A fill over `max_fill_bps` of the
    /// out-reserve must fall back to Proceed, while an in-cap swap still Deltas.
    #[test]
    fn whale_over_fill_cap_is_blocked() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let t0 = env.block.time.seconds();
        // flat price 1.0, balanced reserves (pool ratio 1.0 -> in band), fee 0,
        // fill cap = 10% of out-reserve, widest tolerance.
        init_full(deps.as_mut(), &env, PRICE_SCALE, PRICE_SCALE, 1000, t0, 0, true, 1000, MAX_BPS);
        // Whale: 5_000_000 uchanse buys 5_000_000 token = 50% of the 10_000_000
        // token reserve, far over the 10% cap -> Proceed.
        assert_eq!(
            decide(deps.as_ref(), &env, ctx(5_000_000, 10_000_000, 10_000_000, true)),
            HookDecision::Proceed,
            "a whole-reserve fill must be blocked"
        );
        // A swap inside the cap (5% of reserve) still gets the scheduled Delta.
        match decide(deps.as_ref(), &env, ctx(500_000, 10_000_000, 10_000_000, true)) {
            HookDecision::Delta { amount_out, .. } => {
                assert_eq!(amount_out, Uint128::new(500_000));
            }
            other => panic!("in-cap swap should Delta, got {other:?}"),
        }
    }

    /// Regression (HIGH): after the ramp completes the schedule would quote
    /// `end_price` forever; a single swap could then drain a reserve side at that
    /// stale price. Once `now >= start_time + duration` the Horn must Proceed.
    #[test]
    fn post_duration_falls_back_to_proceed() {
        let mut deps = mock_dependencies();
        let mut env = mock_env();
        let t0 = env.block.time.seconds();
        init_full(deps.as_mut(), &env, PRICE_SCALE, PRICE_SCALE, 100, t0, 0, true, MAX_BPS, MAX_BPS);
        // While open: a small in-band swap Deltas.
        match decide(deps.as_ref(), &env, ctx(100_000, 10_000_000, 10_000_000, true)) {
            HookDecision::Delta { .. } => {}
            other => panic!("open schedule should Delta, got {other:?}"),
        }
        // Past the end of the ramp: Proceed, regardless of size.
        env.block.time = env.block.time.plus_seconds(200);
        assert_eq!(
            decide(deps.as_ref(), &env, ctx(100_000, 10_000_000, 10_000_000, true)),
            HookDecision::Proceed,
            "a completed schedule must fall back to constant product"
        );
    }

    /// Regression: the scheduled price ignores the pool. When it has drifted off
    /// the live pool ratio the Delta would be an arbitrage gift; off the
    /// tolerance band the Horn must Proceed.
    #[test]
    fn off_band_price_proceeds() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let t0 = env.block.time.seconds();
        // Scheduled price 3.0 but pool ratio is 1.0 (balanced reserves); 1% band.
        init_full(deps.as_mut(), &env, 3 * PRICE_SCALE, 3 * PRICE_SCALE, 1000, t0, 0, true, MAX_BPS, 100);
        assert_eq!(
            decide(deps.as_ref(), &env, ctx(100_000, 10_000_000, 10_000_000, true)),
            HookDecision::Proceed,
            "an off-band scheduled price must Proceed"
        );
    }

    /// Regression: `start_price`/`end_price` have no upper bound, so an extreme
    /// price times a large reserve overflows the `within_tolerance` `Uint256`
    /// intermediates. It must degrade to `None` (→ Proceed) rather than panic in
    /// the read-only `before_swap` query, which would brick every swap.
    #[test]
    fn extreme_price_reserve_proceeds_without_panic() {
        // Directly on the band helper: the products overflow -> None.
        assert!(
            within_tolerance(u128::MAX, Uint128::MAX, Uint128::MAX, MAX_BPS).is_none(),
            "extreme price x reserve must degrade to None, not panic"
        );
        // And through decide(): a near-u128::MAX flat schedule with huge reserves
        // reaches within_tolerance, which must Proceed rather than trap.
        let mut deps = mock_dependencies();
        let env = mock_env();
        let t0 = env.block.time.seconds();
        init_full(deps.as_mut(), &env, u128::MAX, u128::MAX, 1000, t0, 0, true, MAX_BPS, MAX_BPS);
        assert_eq!(
            decide(deps.as_ref(), &env, ctx(1_000_000, u128::MAX, u128::MAX, true)),
            HookDecision::Proceed,
            "extreme price x reserve must Proceed, never panic"
        );
    }

    /// The explicit off switch retires the schedule without leaving it quoting.
    #[test]
    fn disabled_schedule_proceeds() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let t0 = env.block.time.seconds();
        init_full(deps.as_mut(), &env, PRICE_SCALE, PRICE_SCALE, 1000, t0, 0, false, MAX_BPS, MAX_BPS);
        assert_eq!(
            decide(deps.as_ref(), &env, ctx(100_000, 10_000_000, 10_000_000, true)),
            HookDecision::Proceed
        );
    }

    #[test]
    fn instantiate_rejects_bad_config() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        // over-cap fee
        let err = instantiate(
            deps.as_mut(),
            env.clone(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                start_price: Uint128::new(2),
                end_price: Uint128::new(1),
                duration_seconds: 100,
                start_time: None,
                fee_bps: 2000,
                enabled: None,
                max_fill_bps: 5000,
                tolerance_bps: 500,
            },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::FeeTooHigh {}));
        // zero duration
        let err = instantiate(
            deps.as_mut(),
            env.clone(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                start_price: Uint128::new(2),
                end_price: Uint128::new(1),
                duration_seconds: 0,
                start_time: None,
                fee_bps: 0,
                enabled: None,
                max_fill_bps: 5000,
                tolerance_bps: 500,
            },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::BadDuration {}));
        // zero price
        let err = instantiate(
            deps.as_mut(),
            env,
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                start_price: Uint128::zero(),
                end_price: Uint128::new(1),
                duration_seconds: 100,
                start_time: None,
                fee_bps: 0,
                enabled: None,
                max_fill_bps: 5000,
                tolerance_bps: 500,
            },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::BadPrice {}));
    }

    #[test]
    fn start_time_defaults_to_block_time() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        instantiate(
            deps.as_mut(),
            env.clone(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                start_price: Uint128::new(2),
                end_price: Uint128::new(1),
                duration_seconds: 100,
                start_time: None,
                fee_bps: 0,
                enabled: None,
                max_fill_bps: 5000,
                tolerance_bps: 500,
            },
        )
        .unwrap();
        let cfg = CONFIG.load(deps.as_ref().storage).unwrap();
        assert_eq!(cfg.start_time, env.block.time.seconds());
    }

    #[test]
    fn only_admin_updates() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        init(deps.as_mut(), &env, 2, 1, 100, 0, 0);
        let err = execute(
            deps.as_mut(),
            env,
            mock_info("mallory", &[]),
            ExecuteMsg::UpdateConfig {
                admin: None,
                start_price: None,
                end_price: None,
                duration_seconds: None,
                start_time: None,
                fee_bps: Some(50),
                enabled: None,
                max_fill_bps: None,
                tolerance_bps: None,
            },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));
    }
}
