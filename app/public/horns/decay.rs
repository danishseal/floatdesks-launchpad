//! Decay Horn — a `before_swap` pricing Horn whose fee starts high and falls,
//! and spikes when the market moves.
//!
//! Ported from Vector's `decay-vector`. Two mechanisms that turn out to be the
//! same shape (a fee that is a function of elapsed time), and the pool pays
//! whichever is higher at that moment:
//!
//! - **Clanker's descending launch fee.** The fee opens at `start_fee_bps` and
//!   decays linearly to `end_fee_bps` over `decay_seconds` from the launch
//!   time. A sniper in the first block pays for the privilege; by the time the
//!   pool is ordinary, so is the fee.
//! - **Bunni's surge fee.** A sharp price move arms a temporary surcharge that
//!   decays on an exponential half-life, so whoever moved the price cannot
//!   immediately trade back through the new one for free (the shape of a
//!   sandwich).
//!
//! # The surge reads no venue reserves
//!
//! The obvious way to detect a price move is to read the pool's reserves, which
//! binds the Horn to one venue. It is avoidable: the AMM's `after_swap`
//! callback hands us `input_amount` and `output_amount`, and their ratio is the
//! price the swap actually executed at. Comparing consecutive execution prices
//! measures the same move without reading pool state, so this Horn runs on a
//! bonding curve and a constant-product pool alike.
//!
//! # Exponential decay without floating point
//!
//! The surge halves every `half_life_seconds`. Whole half-lives are a shift;
//! the remainder is interpolated linearly inside the final halving, which
//! understates the surcharge slightly rather than overstating it. The fee errs
//! toward the trader.
//!
//! # Query vs execute
//!
//! `before_swap` is the AMM's synchronous, read-only QUERY, so it cannot store
//! anything; it just reads the schedule + armed surge and returns a fee.
//! Arming the surge needs mutable state, which happens in the `after_swap`
//! EXECUTE callback (matching `amm::hooks::HookExecute::AfterSwap`, and gated
//! to the configured AMM address exactly like the Fee-Share Horn).
//!
//! Safety: for any degenerate state (config missing, decay window zero, a
//! non-representable price) the fee falls back to the AMM's `default_fee_bps`
//! and is never above the 1000 bps cap.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_binary, Addr, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult,
    Uint128, Uint256,
};
use cw_storage_plus::Item;
use thiserror::Error;

const MAX_HOOK_FEE_BPS: u16 = 1000; // must match amm::hooks::MAX_HOOK_FEE_BPS
const BPS: u128 = 10_000;
/// Fixed-point scale for the recorded execution price (token per ANSEM). Large
/// enough to keep resolution on lopsided reserves, small enough that
/// `token_amt * PRICE_SCALE` stays inside Uint256 for any realistic swap.
const PRICE_SCALE: u128 = 1_000_000_000_000; // 1e12
/// Once the surge has halved this many times it is dust; report zero so a pool
/// that saw one violent block long ago is not still charging for it.
const MAX_HALVINGS: u64 = 32;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("fee bps must be <= {MAX_HOOK_FEE_BPS}")]
    FeeTooHigh {},
    #[error("the launch fee must start at or above its floor")]
    BadSchedule {},
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
    /// The AMM allowed to call `after_swap`; nothing else may arm the surge.
    pub amm: Addr,

    // Launch decay: linear from `start_fee_bps` down to `end_fee_bps` over
    // `decay_seconds`, measured from `launch_time` (unix seconds).
    pub launch_time: u64,
    pub decay_seconds: u64,
    pub start_fee_bps: u16,
    pub end_fee_bps: u16,

    // Surge (optional): armed by a price move, halves every `half_life_seconds`.
    /// Full surcharge (bps) the moment the surge arms. Zero disables the surge.
    pub surge_fee_bps: u16,
    pub half_life_seconds: u64,
    /// Move, in bps of the previous execution price, that arms the surge.
    pub trigger_bps: u16,

    // Mutable surge state.
    /// Unix second the surge last armed; zero means unarmed.
    pub armed_time: u64,
    /// Last observed execution price, token-per-ANSEM scaled by `PRICE_SCALE`.
    pub last_price: Uint128,
}

const CONFIG: Item<Config> = Item::new("config");

// ── messages ────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub amm: String,
    /// Launch time in unix seconds. `None` (or 0) uses the block time at
    /// instantiate, so the decay window opens now.
    pub start_time: Option<u64>,
    pub decay_seconds: u64,
    pub start_fee_bps: u16,
    pub end_fee_bps: u16,
    pub surge_fee_bps: u16,
    pub half_life_seconds: u64,
    pub trigger_bps: u16,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// AMM callback — MUST match the AMM's `HookExecute::AfterSwap` shape.
    AfterSwap {
        token_address: String,
        sender: String,
        offer_ansem: bool,
        input_amount: Uint128,
        output_amount: Uint128,
        fee_amount: Uint128,
    },
    UpdateConfig {
        admin: Option<String>,
        amm: Option<String>,
        decay_seconds: Option<u64>,
        start_fee_bps: Option<u16>,
        end_fee_bps: Option<u16>,
        surge_fee_bps: Option<u16>,
        half_life_seconds: Option<u64>,
        trigger_bps: Option<u16>,
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
    /// The launch + surge fee this Horn would charge at `now_seconds` (or the
    /// current block time when omitted). Handy for UIs and tests.
    #[returns(FeeResponse)]
    FeeAt { now_seconds: Option<u64> },
}

#[cw_serde]
pub struct FeeResponse {
    pub launch_fee_bps: u16,
    pub surge_fee_bps: u16,
    pub fee_bps: u16,
}

// ── pure fee math (kept free of Deps so it is directly unit-testable) ────────

/// The launch fee at `now`: `start` at the open, `end` once the window has
/// passed, linear in between. Requires `start_fee_bps >= end_fee_bps`.
pub fn launch_fee(cfg: &Config, now: u64) -> u16 {
    if cfg.decay_seconds == 0 || now <= cfg.launch_time {
        return cfg.start_fee_bps;
    }
    let elapsed = now - cfg.launch_time;
    if elapsed >= cfg.decay_seconds {
        return cfg.end_fee_bps;
    }
    let span = cfg.start_fee_bps.saturating_sub(cfg.end_fee_bps) as u128;
    let shed = span * elapsed as u128 / cfg.decay_seconds as u128;
    cfg.start_fee_bps - shed as u16
}

/// The surge remaining at `now`, halving every `half_life_seconds`. Returns zero
/// once it has decayed past representable.
pub fn surge_fee(cfg: &Config, now: u64) -> u16 {
    if cfg.armed_time == 0 || cfg.half_life_seconds == 0 || cfg.surge_fee_bps == 0 {
        return 0;
    }
    let elapsed = now.saturating_sub(cfg.armed_time);
    let halvings = elapsed / cfg.half_life_seconds;
    if halvings >= MAX_HALVINGS {
        return 0;
    }
    // Shift in u64: a u16 shift by >= 16 would panic, and surge_fee_bps <= 1000
    // is already dust long before then.
    let after_halvings = (cfg.surge_fee_bps as u64) >> halvings;
    // Interpolate linearly across the part-way point of the next halving.
    let remainder = elapsed % cfg.half_life_seconds;
    let next = after_halvings / 2;
    let step = after_halvings - next;
    let shed = step * remainder / cfg.half_life_seconds;
    (after_halvings - shed) as u16
}

/// The fee this Horn charges at `now`: whichever of launch/surge is higher,
/// never above the cap.
pub fn fee_at(cfg: &Config, now: u64) -> u16 {
    launch_fee(cfg, now).max(surge_fee(cfg, now)).min(MAX_HOOK_FEE_BPS)
}

/// Execution price of a swap as token-per-ANSEM, scaled by `PRICE_SCALE`, from
/// the input/output the callback was handed. Normalised to one orientation so
/// consecutive buys and sells compare on the same axis. `None` for a degenerate
/// or non-representable trade (record nothing, arm nothing).
fn exec_price(offer_ansem: bool, input: Uint128, output: Uint128) -> Option<Uint128> {
    // token per ansem: on a buy ANSEM is the input and token the output; on a
    // sell it is the reverse.
    let (token_amt, ansem_amt) = if offer_ansem {
        (output, input)
    } else {
        (input, output)
    };
    if token_amt.is_zero() || ansem_amt.is_zero() {
        return None;
    }
    let scaled = Uint256::from(token_amt) * Uint256::from(PRICE_SCALE) / Uint256::from(ansem_amt);
    Uint128::try_from(scaled).ok().filter(|p| !p.is_zero())
}

/// Whether `now` differs from `then` by more than `trigger_bps`. Direction does
/// not matter; a crash is as much a move as a spike.
fn moved_enough(then: Uint128, now: Uint128, trigger_bps: u16) -> bool {
    if then.is_zero() || trigger_bps == 0 {
        return false;
    }
    let diff = if now > then { now - then } else { then - now };
    // diff / then > trigger/BPS, rearranged to avoid the division.
    let lhs = Uint256::from(diff) * Uint256::from(BPS);
    let rhs = Uint256::from(then) * Uint256::from(trigger_bps as u128);
    lhs > rhs
}

// ── config validation ────────────────────────────────────────────────────────

fn check_config(cfg: &Config) -> Result<(), ContractError> {
    if cfg.start_fee_bps > MAX_HOOK_FEE_BPS
        || cfg.end_fee_bps > MAX_HOOK_FEE_BPS
        || cfg.surge_fee_bps > MAX_HOOK_FEE_BPS
    {
        return Err(ContractError::FeeTooHigh {});
    }
    if cfg.start_fee_bps < cfg.end_fee_bps {
        return Err(ContractError::BadSchedule {});
    }
    Ok(())
}

// ── entry points ────────────────────────────────────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    cw2::set_contract_version(deps.storage, "ansem-horn-decay", env!("CARGO_PKG_VERSION"))?;
    let launch_time = match msg.start_time {
        Some(t) if t != 0 => t,
        _ => env.block.time.seconds(),
    };
    let cfg = Config {
        admin: deps.api.addr_validate(&msg.admin)?,
        amm: deps.api.addr_validate(&msg.amm)?,
        launch_time,
        decay_seconds: msg.decay_seconds,
        start_fee_bps: msg.start_fee_bps,
        end_fee_bps: msg.end_fee_bps,
        surge_fee_bps: msg.surge_fee_bps,
        half_life_seconds: msg.half_life_seconds,
        trigger_bps: msg.trigger_bps,
        armed_time: 0,
        last_price: Uint128::zero(),
    };
    check_config(&cfg)?;
    CONFIG.save(deps.storage, &cfg)?;
    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("launch_time", launch_time.to_string()))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::AfterSwap {
            offer_ansem,
            input_amount,
            output_amount,
            ..
        } => after_swap(deps, env, info, offer_ansem, input_amount, output_amount),
        ExecuteMsg::UpdateConfig {
            admin,
            amm,
            decay_seconds,
            start_fee_bps,
            end_fee_bps,
            surge_fee_bps,
            half_life_seconds,
            trigger_bps,
        } => update_config(
            deps,
            info,
            admin,
            amm,
            decay_seconds,
            start_fee_bps,
            end_fee_bps,
            surge_fee_bps,
            half_life_seconds,
            trigger_bps,
        ),
    }
}

/// Record the execution price, and arm the surge if it jumped past the trigger.
/// A degenerate price (zero/unrepresentable) records nothing; this callback
/// never fails the swap for a price it could not use.
fn after_swap(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    offer_ansem: bool,
    input_amount: Uint128,
    output_amount: Uint128,
) -> Result<Response, ContractError> {
    let mut cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.amm {
        return Err(ContractError::Unauthorized {});
    }
    if let Some(price) = exec_price(offer_ansem, input_amount, output_amount) {
        let now = env.block.time.seconds();
        let mut armed = false;
        if moved_enough(cfg.last_price, price, cfg.trigger_bps) {
            cfg.armed_time = now;
            armed = true;
        }
        cfg.last_price = price;
        CONFIG.save(deps.storage, &cfg)?;
        return Ok(Response::new()
            .add_attribute("action", "after_swap")
            .add_attribute("price", price.to_string())
            .add_attribute("armed", armed.to_string()));
    }
    Ok(Response::new().add_attribute("action", "after_swap").add_attribute("price", "none"))
}

#[allow(clippy::too_many_arguments)]
fn update_config(
    deps: DepsMut,
    info: MessageInfo,
    admin: Option<String>,
    amm: Option<String>,
    decay_seconds: Option<u64>,
    start_fee_bps: Option<u16>,
    end_fee_bps: Option<u16>,
    surge_fee_bps: Option<u16>,
    half_life_seconds: Option<u64>,
    trigger_bps: Option<u16>,
) -> Result<Response, ContractError> {
    let mut cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    if let Some(a) = admin {
        cfg.admin = deps.api.addr_validate(&a)?;
    }
    if let Some(a) = amm {
        cfg.amm = deps.api.addr_validate(&a)?;
    }
    if let Some(v) = decay_seconds {
        cfg.decay_seconds = v;
    }
    if let Some(v) = start_fee_bps {
        cfg.start_fee_bps = v;
    }
    if let Some(v) = end_fee_bps {
        cfg.end_fee_bps = v;
    }
    if let Some(v) = surge_fee_bps {
        cfg.surge_fee_bps = v;
    }
    if let Some(v) = half_life_seconds {
        cfg.half_life_seconds = v;
    }
    if let Some(v) = trigger_bps {
        cfg.trigger_bps = v;
    }
    check_config(&cfg)?;
    CONFIG.save(deps.storage, &cfg)?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::BeforeSwap { ctx } => to_binary(&decide(deps, env, ctx)),
        QueryMsg::Config {} => to_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::FeeAt { now_seconds } => {
            let cfg = CONFIG.load(deps.storage)?;
            let now = now_seconds.unwrap_or_else(|| env.block.time.seconds());
            to_binary(&FeeResponse {
                launch_fee_bps: launch_fee(&cfg, now),
                surge_fee_bps: surge_fee(&cfg, now),
                fee_bps: fee_at(&cfg, now),
            })
        }
    }
}

/// The pricing decision: override the fee with whichever of the launch schedule
/// or the live surge is higher. A missing/unreadable config falls back to the
/// AMM's own default fee (`Proceed`) rather than erroring — a swap must never
/// revert because the fee lookup hiccuped.
fn decide(deps: Deps, env: Env, _ctx: SwapContext) -> HookDecision {
    let cfg = match CONFIG.load(deps.storage) {
        Ok(c) => c,
        Err(_) => return HookDecision::Proceed,
    };
    let now = env.block.time.seconds();
    HookDecision::OverrideFee { fee_bps: fee_at(&cfg, now) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};

    fn cfg() -> Config {
        Config {
            admin: Addr::unchecked("admin"),
            amm: Addr::unchecked("amm"),
            launch_time: 1_000,
            decay_seconds: 100,
            start_fee_bps: 1_000, // 10% (also the cap)
            end_fee_bps: 30,      // 0.3%
            surge_fee_bps: 500,   // 5%
            half_life_seconds: 10,
            trigger_bps: 100, // 1%
            armed_time: 0,
            last_price: Uint128::zero(),
        }
    }

    #[test]
    fn launch_fee_falls_monotonically_to_its_floor() {
        let c = cfg();
        let mut previous = u16::MAX;
        for now in 1_000..=1_100 {
            let f = launch_fee(&c, now);
            assert!(f <= previous, "fee rose at {now}");
            assert!(f >= c.end_fee_bps, "fee fell below the floor at {now}");
            previous = f;
        }
        assert_eq!(launch_fee(&c, 1_000), 1_000, "opens at the start fee");
        assert_eq!(launch_fee(&c, 1_100), 30, "lands exactly on the floor");
        assert_eq!(launch_fee(&c, 9_999), 30, "and stays there");
        assert_eq!(launch_fee(&c, 1_050), 515, "halfway sheds half the span");
    }

    #[test]
    fn a_swap_before_the_window_pays_the_opening_fee() {
        // Not a discount: a pool that somehow trades early must not be cheap.
        let c = cfg();
        assert_eq!(launch_fee(&c, 1), c.start_fee_bps);
    }

    #[test]
    fn zero_decay_window_is_a_flat_start_fee() {
        let mut c = cfg();
        c.decay_seconds = 0;
        assert_eq!(launch_fee(&c, 5_000), c.start_fee_bps);
    }

    #[test]
    fn surge_halves_on_schedule_and_reaches_zero() {
        let mut c = cfg();
        c.armed_time = 500;
        assert_eq!(surge_fee(&c, 500), 500, "full surge at the trigger");
        assert_eq!(surge_fee(&c, 510), 250, "one half-life");
        assert_eq!(surge_fee(&c, 520), 125, "two");
        assert_eq!(surge_fee(&c, 530), 62, "three (integer-floored)");
        assert_eq!(surge_fee(&c, 500 + 10 * 32), 0, "eventually nothing");
    }

    #[test]
    fn surge_never_rises_between_seconds() {
        let mut c = cfg();
        c.armed_time = 500;
        let mut previous = u16::MAX;
        for now in 500..800 {
            let s = surge_fee(&c, now);
            assert!(s <= previous, "surge rose at {now}: {s} > {previous}");
            previous = s;
        }
    }

    #[test]
    fn an_unarmed_surge_charges_nothing() {
        let c = cfg();
        assert_eq!(surge_fee(&c, 5_000), 0);
    }

    #[test]
    fn the_pool_pays_whichever_is_higher_and_never_over_cap() {
        let mut c = cfg();
        c.armed_time = 1_200; // long after the launch window closed
        let at = 1_200;
        assert_eq!(launch_fee(&c, at), 30);
        assert_eq!(surge_fee(&c, at), 500);
        assert_eq!(fee_at(&c, at), 500, "surge wins once launch has settled");
        // Even a pathological combo is clamped to the cap.
        c.start_fee_bps = 1_000;
        c.surge_fee_bps = 1_000;
        c.armed_time = 1_000;
        assert_eq!(fee_at(&c, 1_000), MAX_HOOK_FEE_BPS);
    }

    #[test]
    fn only_a_move_past_the_trigger_arms_it() {
        let one = Uint128::new(PRICE_SCALE);
        // 1% trigger: half a percent must not arm, two percent must.
        assert!(!moved_enough(one, Uint128::new(PRICE_SCALE * 1005 / 1000), 100));
        assert!(moved_enough(one, Uint128::new(PRICE_SCALE * 102 / 100), 100));
        // Direction does not matter; a crash arms it too.
        assert!(moved_enough(one, Uint128::new(PRICE_SCALE * 98 / 100), 100));
        // The first swap, with no history, arms nothing.
        assert!(!moved_enough(Uint128::zero(), one, 100));
        // A zero trigger never arms.
        assert!(!moved_enough(one, Uint128::new(PRICE_SCALE * 2), 0));
    }

    #[test]
    fn execution_price_is_token_per_ansem_both_directions() {
        // Buy: 100 ANSEM in, 200 token out -> 2 token per ANSEM.
        let buy = exec_price(true, Uint128::new(100), Uint128::new(200)).unwrap();
        // Sell: 200 token in, 100 ANSEM out -> the same 2 token per ANSEM.
        let sell = exec_price(false, Uint128::new(200), Uint128::new(100)).unwrap();
        assert_eq!(buy, sell, "a buy and a sell at the same price agree");
        assert_eq!(buy, Uint128::new(2 * PRICE_SCALE));
        // No price from a zero leg.
        assert!(exec_price(true, Uint128::zero(), Uint128::new(5)).is_none());
        assert!(exec_price(true, Uint128::new(5), Uint128::zero()).is_none());
    }

    #[test]
    fn config_rejects_over_cap_or_inverted_schedule() {
        let mut deps = mock_dependencies();
        let over = instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                amm: "amm".into(),
                start_time: None,
                decay_seconds: 100,
                start_fee_bps: 2_000, // > cap
                end_fee_bps: 30,
                surge_fee_bps: 0,
                half_life_seconds: 0,
                trigger_bps: 0,
            },
        )
        .unwrap_err();
        assert!(matches!(over, ContractError::FeeTooHigh {}));

        let inverted = instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                amm: "amm".into(),
                start_time: None,
                decay_seconds: 100,
                start_fee_bps: 30,
                end_fee_bps: 100, // end above start
                surge_fee_bps: 0,
                half_life_seconds: 0,
                trigger_bps: 0,
            },
        )
        .unwrap_err();
        assert!(matches!(inverted, ContractError::BadSchedule {}));
    }

    #[test]
    fn before_swap_overrides_with_the_decaying_fee() {
        let mut deps = mock_dependencies();
        let mut env = mock_env();
        env.block.time = cosmwasm_std::Timestamp::from_seconds(1_000);
        instantiate(
            deps.as_mut(),
            env.clone(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                amm: "amm".into(),
                start_time: Some(1_000),
                decay_seconds: 100,
                start_fee_bps: 1_000,
                end_fee_bps: 30,
                surge_fee_bps: 0,
                half_life_seconds: 0,
                trigger_bps: 0,
            },
        )
        .unwrap();
        let ctx = SwapContext {
            token_address: "t".into(),
            sender: "trader".into(),
            offer_ansem: true,
            input_amount: Uint128::new(1_000),
            ansem_reserve: Uint128::new(1_000_000),
            token_reserve: Uint128::new(1_000_000),
            default_fee_bps: 100,
        };
        // At the open: full start fee.
        assert_eq!(
            decide(deps.as_ref(), env.clone(), ctx.clone()),
            HookDecision::OverrideFee { fee_bps: 1_000 }
        );
        // Past the window: the floor.
        env.block.time = cosmwasm_std::Timestamp::from_seconds(2_000);
        assert_eq!(
            decide(deps.as_ref(), env, ctx),
            HookDecision::OverrideFee { fee_bps: 30 }
        );
    }

    #[test]
    fn after_swap_arms_surge_only_from_the_amm_and_lifts_before_swap() {
        let mut deps = mock_dependencies();
        let mut env = mock_env();
        env.block.time = cosmwasm_std::Timestamp::from_seconds(1_000);
        instantiate(
            deps.as_mut(),
            env.clone(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                amm: "amm".into(),
                start_time: Some(1_000),
                decay_seconds: 100,
                start_fee_bps: 1_000,
                end_fee_bps: 30,
                surge_fee_bps: 500,
                half_life_seconds: 10,
                trigger_bps: 100, // 1%
            },
        )
        .unwrap();

        // A stranger cannot drive the price/surge.
        let strangers = execute(
            deps.as_mut(),
            env.clone(),
            mock_info("not_amm", &[]),
            ExecuteMsg::AfterSwap {
                token_address: "t".into(),
                sender: "x".into(),
                offer_ansem: true,
                input_amount: Uint128::new(100),
                output_amount: Uint128::new(200),
                fee_amount: Uint128::zero(),
            },
        )
        .unwrap_err();
        assert!(matches!(strangers, ContractError::Unauthorized {}));

        // First AMM swap establishes a baseline price (arms nothing).
        let after = |deps: DepsMut, env: &Env, out: u128| {
            execute(
                deps,
                env.clone(),
                mock_info("amm", &[]),
                ExecuteMsg::AfterSwap {
                    token_address: "t".into(),
                    sender: "trader".into(),
                    offer_ansem: true,
                    input_amount: Uint128::new(100),
                    output_amount: Uint128::new(out),
                    fee_amount: Uint128::zero(),
                },
            )
            .unwrap()
        };
        after(deps.as_mut(), &env, 200); // price 2.0

        // Well past the launch window, the fee has settled to the floor.
        env.block.time = cosmwasm_std::Timestamp::from_seconds(2_000);
        let cfg_now = CONFIG.load(&deps.storage).unwrap();
        assert_eq!(fee_at(&cfg_now, 2_000), 30);

        // A big move (2.0 -> 2.4, +20%) arms the surge.
        after(deps.as_mut(), &env, 240);
        let cfg_now = CONFIG.load(&deps.storage).unwrap();
        assert_eq!(cfg_now.armed_time, 2_000, "surge armed at the swap time");
        assert_eq!(surge_fee(&cfg_now, 2_000), 500, "full surge right after the move");
        assert_eq!(fee_at(&cfg_now, 2_000), 500, "before_swap now charges the surge");
        // And it decays away.
        assert_eq!(fee_at(&cfg_now, 2_010), 250);
    }

    #[test]
    fn a_tiny_move_does_not_arm() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        instantiate(
            deps.as_mut(),
            env.clone(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                amm: "amm".into(),
                start_time: Some(env.block.time.seconds()),
                decay_seconds: 100,
                start_fee_bps: 300,
                end_fee_bps: 30,
                surge_fee_bps: 500,
                half_life_seconds: 10,
                trigger_bps: 100, // 1%
            },
        )
        .unwrap();
        let after = |deps: DepsMut, out: u128| {
            execute(
                deps,
                env.clone(),
                mock_info("amm", &[]),
                ExecuteMsg::AfterSwap {
                    token_address: "t".into(),
                    sender: "trader".into(),
                    offer_ansem: true,
                    input_amount: Uint128::new(10_000),
                    output_amount: Uint128::new(out),
                    fee_amount: Uint128::zero(),
                },
            )
            .unwrap();
        };
        after(deps.as_mut(), 20_000); // baseline 2.0
        after(deps.as_mut(), 20_050); // +0.25%, under the 1% trigger
        let cfg_now = CONFIG.load(&deps.storage).unwrap();
        assert_eq!(cfg_now.armed_time, 0, "a sub-trigger move must not arm");
    }
}
