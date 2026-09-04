//! Auction Horn — the pool's fee is not a parameter, it is a seat someone rents.
//!
//! A CosmWasm port of the auction-managed AMM (am-AMM) of Adams, Moallemi,
//! Reynolds and Robinson, the mechanism Bunni v2 ships and the one
//! `auction-vector` ports onto Solana. One sentence: the right to set the swap
//! fee is continuously auctioned, whoever holds it (the "manager") pays rent for
//! the privilege, and they collect the swap fee in return.
//!
//! What it buys is a price for something otherwise stolen. An arbitrageur who
//! corrects a stale quote takes the difference from the LPs and pays nothing —
//! LVR is the name for that leak. Under an auction the same actor is the one who
//! values the pool's flow most, so they win the seat, and what they were going
//! to extract becomes the ceiling on what they will bid. The conflict is
//! converted into rent.
//!
//! # How the two AMM callbacks are used
//!
//! - `before_swap` (a read-only QUERY) publishes `OverrideFee { fee_bps }` where
//!   `fee_bps` is the sitting manager's chosen fee, or the pool's `default_fee`
//!   when the seat is vacant. This is what makes the seat worth renting: the
//!   manager sets the price traders pay.
//! - `after_swap` (an EXECUTE, AMM-only) receives the AMM's fee **skim** as
//!   attached funds (see the pool's `skim_bps`) and routes it to the sitting
//!   manager as a **claimable balance**. That is the manager collecting the fee
//!   the seat entitles them to.
//!
//! The AMM caps any hook fee at 1000 bps; the fee bounds are validated against
//! the same cap at config time so a swap is never rejected mid-trade for an
//! over-cap fee.
//!
//! # Adaptations from `auction-vector` (Solana)
//!
//! **Blocks/slots become seconds.** Solana charges rent per `Clock::slot`; here
//! rent is charged per `block.time` second, the monotone counter CosmWasm hooks
//! reason about. Rent is charged lazily, exactly as in the source: a
//! `last_charged` cursor is advanced on the way into every callback and every
//! bid and the whole interval is charged at once, so the manager pays for every
//! second they held the seat whether or not anyone traded.
//!
//! **The bid IS the deposit.** The source separates `rent_per_slot` (the auction
//! variable) from `deposit` (the bond). The ANSEM spec is "highest deposit wins",
//! so here the contest is on the attached deposit and the rent rate is a single
//! pool-wide `rent_per_second` parameter. A challenger must beat the incumbent's
//! *remaining* deposit by `min_bid_increment_bps` and wait out `min_tenure`. This
//! keeps the honest core of the mechanism (a paid, decaying, displaceable seat)
//! and loses only the per-bid rent-rate discovery, which becomes governance.
//!
//! **Rent is denominated in the quote denom** (uchanse | uansem), the currency
//! the fee skim also arrives in, rather than in lamports/wSOL. The contract's
//! whole bank balance is `sum(deposits) + accrued_rent + sum(claimable)`.
//!
//! # Where the money moves, and the one placeholder
//!
//! The manager receives the swap-fee skim (their claimable). The charged rent is
//! the LPs' compensation; as in the source it accrues to `accrued_rent` and is
//! pulled by a single `admin` that **stands in for the LP set**. Distribution to
//! LPs is out of band and unverifiable on chain — a pool run this way is a
//! custodial arrangement with an auction on the front. Read that before shipping
//! it on a public surface; it is the same honest gap `auction-vector` documents.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_binary, Addr, BankMsg, Binary, Coin, CosmosMsg, Deps, DepsMut, Env,
    MessageInfo, Response, StdResult, Uint128,
};
use cw_storage_plus::{Item, Map};
use thiserror::Error;

/// Must match `amm::hooks::MAX_HOOK_FEE_BPS`.
const MAX_HOOK_FEE_BPS: u16 = 1000;
const BPS_DENOMINATOR: u128 = 10_000;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("fee bounds are invalid or exceed the {MAX_HOOK_FEE_BPS} bps cap")]
    BadFeeBounds {},
    #[error("displacing margin must be positive")]
    BadIncrement {},
    #[error("minimum tenure must be positive")]
    BadTenure {},
    #[error("fee {fee_bps} bps is outside the configured bounds")]
    FeeOutOfBounds { fee_bps: u16 },
    #[error("must attach a positive amount of exactly the quote denom {denom}")]
    BadFunds { denom: String },
    #[error("the sitting manager's minimum tenure has not elapsed")]
    TenureNotExpired {},
    #[error("bid does not clear the sitting manager by the required margin")]
    BidTooLow {},
    #[error("deposit must fund at least the minimum tenure at the rent rate")]
    DepositTooSmall {},
    #[error("signer is not the sitting manager")]
    NotManager {},
    #[error("nothing to claim")]
    NothingToClaim {},
    #[error("more was requested than has accrued")]
    InsufficientAccrual {},
    #[error("arithmetic overflow")]
    Overflow {},
    #[error("rent_per_second cannot be increased while a manager sits")]
    RentIncreaseWhileOccupied {},
    #[error("rent_per_second * min_tenure_seconds overflows the minimum deposit")]
    MinimumDepositOverflow {},
}

// ── mirrors of amm::hooks (serialize identically so the AMM round-trips without
//    a shared crate dependency) ────────────────────────────────────────────────

#[cw_serde]
pub struct SwapContext {
    pub token_address: String,
    pub sender: String,
    /// true = ANSEM/quote in, token out
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

// ── state ─────────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    /// The AMM. Only it may call `after_swap`; the trust chain of horn-floor.
    pub amm: Addr,
    /// Rent + skim currency (uchanse | uansem).
    pub quote_denom: String,
    /// The manager may set any fee in `[min_fee_bps, max_fee_bps]`, both <= cap.
    pub min_fee_bps: u16,
    pub max_fee_bps: u16,
    /// Fee in force while the seat is vacant.
    pub default_fee_bps: u16,
    /// How far above the incumbent's remaining deposit a challenger must go.
    pub min_bid_increment_bps: u16,
    /// Rent charged per second against the manager's deposit, in quote micro-units.
    pub rent_per_second: Uint128,
    /// Seconds a manager cannot be displaced for after taking the seat. Also
    /// sets the minimum deposit (`rent_per_second * min_tenure_seconds`), so a
    /// seat always costs a real window of rent to hold.
    pub min_tenure_seconds: u64,
}

/// The fee seat. `manager == None` means vacant and the fee falls back to
/// `default_fee_bps`.
#[cw_serde]
pub struct Seat {
    pub manager: Option<Addr>,
    /// Fee in force (the manager's choice, or the default while vacant).
    pub fee_bps: u16,
    /// Remaining rent bond. Decays at `rent_per_second`; never negative.
    pub deposit: Uint128,
    /// Block second the current manager took the seat (tenure clock).
    pub seat_taken: u64,
    /// Block second rent was last charged to.
    pub last_charged: u64,
    /// How many times the seat has changed hands (display).
    pub seat_changes: u32,
}

const CONFIG: Item<Config> = Item::new("config");
const SEAT: Item<Seat> = Item::new("seat");
/// Rent charged and not yet withdrawn. Owed to the LP set (admin stand-in).
const ACCRUED_RENT: Item<Uint128> = Item::new("accrued_rent");
/// Cumulative rent ever charged (display only).
const LIFETIME_RENT: Item<Uint128> = Item::new("lifetime_rent");
/// Per-address claimable swap fees (the routed skim). A displaced manager keeps
/// what they earned, so this is keyed by address, not by "current manager".
const CLAIMABLE: Map<&Addr, Uint128> = Map::new("claimable");

// ── messages ──────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub amm: String,
    pub quote_denom: String,
    pub min_fee_bps: u16,
    pub max_fee_bps: u16,
    pub default_fee_bps: u16,
    pub min_bid_increment_bps: u16,
    pub rent_per_second: Uint128,
    pub min_tenure_seconds: u64,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Take, or top up, the fee seat. Attach the deposit in the quote denom.
    /// `fee_bps` is the fee the manager wants the pool to charge (in bounds).
    /// A challenger must beat the incumbent's remaining deposit by the margin
    /// and wait out the tenure; the incumbent may top up and re-set their fee at
    /// any time. The displaced manager's remaining deposit is refunded.
    Bid { fee_bps: u16 },
    /// Claim the swap fees routed to you (works for a displaced manager too).
    Claim {},
    /// Sitting manager only: relinquish the seat and refund the remaining rent.
    Withdraw {},
    /// AMM callback — matches `amm::hooks::HookExecute::AfterSwap`. The fee skim
    /// arrives as attached funds and is credited to the sitting manager.
    AfterSwap {
        token_address: String,
        sender: String,
        offer_ansem: bool,
        input_amount: Uint128,
        output_amount: Uint128,
        fee_amount: Uint128,
    },
    /// Admin (the LP stand-in) pulls accrued rent.
    WithdrawRent { recipient: String, amount: Uint128 },
    /// `amm` is deliberately absent: it is immutable after instantiate. A wrong
    /// value would make the real AMM's `after_swap` fail auth and revert every
    /// buy on the pool (a pool halt), so it cannot be changed by config at all.
    UpdateConfig {
        admin: Option<String>,
        min_fee_bps: Option<u16>,
        max_fee_bps: Option<u16>,
        default_fee_bps: Option<u16>,
        min_bid_increment_bps: Option<u16>,
        rent_per_second: Option<Uint128>,
        min_tenure_seconds: Option<u64>,
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
    #[returns(SeatResponse)]
    Seat {},
    #[returns(Uint128)]
    Claimable { address: String },
    #[returns(RentResponse)]
    Rent {},
}

#[cw_serde]
pub struct SeatResponse {
    pub manager: Option<Addr>,
    /// The fee that would be charged right now, projecting rent decay.
    pub effective_fee_bps: u16,
    /// The manager's set fee (meaningful only while a solvent manager sits).
    pub fee_bps: u16,
    /// Deposit remaining after projecting rent to `now`.
    pub deposit_remaining: Uint128,
    pub seat_taken: u64,
    pub seat_changes: u32,
    /// True once the manager's projected deposit is exhausted (or vacant).
    pub vacant: bool,
}

#[cw_serde]
pub struct RentResponse {
    pub accrued_rent: Uint128,
    pub lifetime_rent: Uint128,
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn valid_bounds(c: &Config) -> bool {
    c.min_fee_bps <= c.max_fee_bps
        && c.max_fee_bps <= MAX_HOOK_FEE_BPS
        && c.default_fee_bps >= c.min_fee_bps
        && c.default_fee_bps <= c.max_fee_bps
}

/// The smallest deposit that displaces `current`, rounded up, never less than
/// `current + 1`. Rounding up and the `max(1)` are the pool's side of the
/// argument: without them the seat churns on a single micro-unit.
fn displacing_bid(current: Uint128, bps: u16) -> Uint128 {
    let c = current.u128();
    let margin = (c.saturating_mul(bps as u128) + (BPS_DENOMINATOR - 1)) / BPS_DENOMINATOR;
    current + Uint128::new(margin.max(1))
}

/// Smallest deposit that may hold the seat: a full tenure of rent.
fn minimum_deposit(cfg: &Config) -> Uint128 {
    cfg.rent_per_second
        .checked_mul(Uint128::from(cfg.min_tenure_seconds))
        .unwrap_or(Uint128::MAX)
}

/// Charge every second since the cursor, advance it, and return what was
/// charged. When the deposit cannot cover the interval it pays all of it and the
/// seat vacates: the deposit saturates at zero and never runs a debt.
fn charge_rent(seat: &mut Seat, cfg: &Config, now: u64) -> Uint128 {
    if seat.manager.is_none() {
        seat.last_charged = now;
        return Uint128::zero();
    }
    let elapsed = now.saturating_sub(seat.last_charged);
    seat.last_charged = now;
    if elapsed == 0 {
        return Uint128::zero();
    }
    let owed = cfg
        .rent_per_second
        .checked_mul(Uint128::from(elapsed))
        .unwrap_or(Uint128::MAX);
    if owed >= seat.deposit {
        let all = seat.deposit;
        seat.deposit = Uint128::zero();
        vacate(seat, cfg);
        all
    } else {
        seat.deposit -= owed;
        owed
    }
}

/// Empty the seat and fall back to the default fee.
fn vacate(seat: &mut Seat, cfg: &Config) {
    seat.manager = None;
    seat.seat_taken = 0;
    seat.fee_bps = cfg.default_fee_bps;
    // deposit is left as the caller set it (zeroed on exhaustion, refunded on
    // withdraw/displacement before this is called).
}

/// The fee in force right now, projecting rent decay without mutating state.
/// Used by the `before_swap` query, which cannot write.
fn projected_fee(seat: &Seat, cfg: &Config, now: u64) -> u16 {
    match &seat.manager {
        None => cfg.default_fee_bps,
        Some(_) => {
            let elapsed = now.saturating_sub(seat.last_charged);
            let owed = cfg
                .rent_per_second
                .checked_mul(Uint128::from(elapsed))
                .unwrap_or(Uint128::MAX);
            if owed >= seat.deposit {
                cfg.default_fee_bps
            } else {
                seat.fee_bps
            }
        }
    }
}

fn projected_deposit(seat: &Seat, cfg: &Config, now: u64) -> Uint128 {
    if seat.manager.is_none() {
        return Uint128::zero();
    }
    let elapsed = now.saturating_sub(seat.last_charged);
    let owed = cfg
        .rent_per_second
        .checked_mul(Uint128::from(elapsed))
        .unwrap_or(Uint128::MAX);
    seat.deposit.saturating_sub(owed)
}

fn only_quote(funds: &[Coin], denom: &str) -> Result<Uint128, ContractError> {
    if funds.iter().any(|c| c.denom != denom) {
        return Err(ContractError::BadFunds { denom: denom.to_string() });
    }
    Ok(funds
        .iter()
        .filter(|c| c.denom == denom)
        .map(|c| c.amount)
        .sum())
}

// ── entry points ──────────────────────────────────────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    cw2::set_contract_version(deps.storage, "ansem-horn-auction", env!("CARGO_PKG_VERSION"))?;
    let cfg = Config {
        admin: deps.api.addr_validate(&msg.admin)?,
        amm: deps.api.addr_validate(&msg.amm)?,
        quote_denom: msg.quote_denom,
        min_fee_bps: msg.min_fee_bps,
        max_fee_bps: msg.max_fee_bps,
        default_fee_bps: msg.default_fee_bps,
        min_bid_increment_bps: msg.min_bid_increment_bps,
        rent_per_second: msg.rent_per_second,
        min_tenure_seconds: msg.min_tenure_seconds,
    };
    if !valid_bounds(&cfg) {
        return Err(ContractError::BadFeeBounds {});
    }
    if cfg.min_bid_increment_bps == 0 {
        return Err(ContractError::BadIncrement {});
    }
    if cfg.min_tenure_seconds == 0 {
        return Err(ContractError::BadTenure {});
    }
    // `minimum_deposit` (rent_per_second * min_tenure_seconds) must not overflow,
    // else it saturates to MAX and the seat can never be taken.
    if cfg
        .rent_per_second
        .checked_mul(Uint128::from(cfg.min_tenure_seconds))
        .is_err()
    {
        return Err(ContractError::MinimumDepositOverflow {});
    }
    CONFIG.save(deps.storage, &cfg)?;
    SEAT.save(
        deps.storage,
        &Seat {
            manager: None,
            fee_bps: cfg.default_fee_bps,
            deposit: Uint128::zero(),
            seat_taken: 0,
            last_charged: env.block.time.seconds(),
            seat_changes: 0,
        },
    )?;
    ACCRUED_RENT.save(deps.storage, &Uint128::zero())?;
    LIFETIME_RENT.save(deps.storage, &Uint128::zero())?;
    Ok(Response::new().add_attribute("action", "instantiate"))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Bid { fee_bps } => bid(deps, env, info, fee_bps),
        ExecuteMsg::Claim {} => claim(deps, info),
        ExecuteMsg::Withdraw {} => withdraw(deps, env, info),
        ExecuteMsg::AfterSwap { .. } => after_swap(deps, env, info),
        ExecuteMsg::WithdrawRent { recipient, amount } => {
            withdraw_rent(deps, env, info, recipient, amount)
        }
        ExecuteMsg::UpdateConfig {
            admin,
            min_fee_bps,
            max_fee_bps,
            default_fee_bps,
            min_bid_increment_bps,
            rent_per_second,
            min_tenure_seconds,
        } => update_config(
            deps,
            env,
            info,
            admin,
            min_fee_bps,
            max_fee_bps,
            default_fee_bps,
            min_bid_increment_bps,
            rent_per_second,
            min_tenure_seconds,
        ),
    }
}

/// Add `charged` to both the withdrawable accrual and the lifetime counter.
fn bank_rent(deps: &mut DepsMut, charged: Uint128) -> StdResult<()> {
    if charged.is_zero() {
        return Ok(());
    }
    let accrued = ACCRUED_RENT.may_load(deps.storage)?.unwrap_or_default() + charged;
    ACCRUED_RENT.save(deps.storage, &accrued)?;
    let life = LIFETIME_RENT.may_load(deps.storage)?.unwrap_or_default() + charged;
    LIFETIME_RENT.save(deps.storage, &life)?;
    Ok(())
}

fn bid(
    mut deps: DepsMut,
    env: Env,
    info: MessageInfo,
    fee_bps: u16,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let now = env.block.time.seconds();

    if fee_bps < cfg.min_fee_bps || fee_bps > cfg.max_fee_bps {
        return Err(ContractError::FeeOutOfBounds { fee_bps });
    }
    let deposit_in = only_quote(&info.funds, &cfg.quote_denom)?;
    if deposit_in.is_zero() {
        return Err(ContractError::BadFunds { denom: cfg.quote_denom });
    }

    // Settle what the sitting manager owes before reading their deposit. This is
    // also what lets an exhausted seat be taken at its vacant price.
    let mut seat = SEAT.load(deps.storage)?;
    let charged = charge_rent(&mut seat, &cfg, now);
    bank_rent(&mut deps, charged)?;

    let bidder = info.sender.clone();
    let occupied = seat.manager.is_some();
    let incumbent = seat.manager.as_ref() == Some(&bidder);

    let min_dep = minimum_deposit(&cfg);
    let mut msgs: Vec<CosmosMsg> = vec![];

    if incumbent {
        // Top up and re-price. No margin, no wait. Fee already bound-checked.
        seat.deposit += deposit_in;
        seat.fee_bps = fee_bps;
        if seat.deposit < min_dep {
            return Err(ContractError::DepositTooSmall {});
        }
    } else {
        if occupied {
            // A challenger must wait out the tenure and clear the margin over
            // the incumbent's *remaining* deposit.
            if now < seat.seat_taken.saturating_add(cfg.min_tenure_seconds) {
                return Err(ContractError::TenureNotExpired {});
            }
            if deposit_in < displacing_bid(seat.deposit, cfg.min_bid_increment_bps) {
                return Err(ContractError::BidTooLow {});
            }
            // Refund the displaced manager their remaining deposit.
            let prev = seat.manager.clone().unwrap();
            let refund = seat.deposit;
            if !refund.is_zero() {
                msgs.push(CosmosMsg::Bank(BankMsg::Send {
                    to_address: prev.to_string(),
                    amount: vec![Coin { denom: cfg.quote_denom.clone(), amount: refund }],
                }));
            }
        }
        if deposit_in < min_dep {
            return Err(ContractError::DepositTooSmall {});
        }
        seat.manager = Some(bidder.clone());
        seat.deposit = deposit_in;
        seat.fee_bps = fee_bps;
        seat.seat_taken = now;
        seat.seat_changes = seat.seat_changes.saturating_add(1);
    }
    seat.last_charged = now;
    SEAT.save(deps.storage, &seat)?;

    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "bid")
        .add_attribute("manager", bidder.to_string())
        .add_attribute("fee_bps", fee_bps.to_string())
        .add_attribute("deposit", seat.deposit))
}

fn claim(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let amount = CLAIMABLE.may_load(deps.storage, &info.sender)?.unwrap_or_default();
    if amount.is_zero() {
        return Err(ContractError::NothingToClaim {});
    }
    CLAIMABLE.remove(deps.storage, &info.sender);
    Ok(Response::new()
        .add_message(CosmosMsg::Bank(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: vec![Coin { denom: cfg.quote_denom, amount }],
        }))
        .add_attribute("action", "claim")
        .add_attribute("amount", amount))
}

fn withdraw(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let now = env.block.time.seconds();
    let mut deps = deps;
    let mut seat = SEAT.load(deps.storage)?;
    let charged = charge_rent(&mut seat, &cfg, now);
    bank_rent(&mut deps, charged)?;

    // charge_rent may already have vacated an exhausted seat; either way only
    // the sitting manager may withdraw.
    if seat.manager.as_ref() != Some(&info.sender) {
        return Err(ContractError::NotManager {});
    }
    let refund = seat.deposit;
    seat.deposit = Uint128::zero();
    vacate(&mut seat, &cfg);
    seat.last_charged = now;
    SEAT.save(deps.storage, &seat)?;

    let mut res = Response::new()
        .add_attribute("action", "withdraw")
        .add_attribute("refund", refund);
    if !refund.is_zero() {
        res = res.add_message(CosmosMsg::Bank(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: vec![Coin { denom: cfg.quote_denom, amount: refund }],
        }));
    }
    Ok(res)
}

fn after_swap(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.amm {
        return Err(ContractError::Unauthorized {});
    }
    let now = env.block.time.seconds();
    let mut deps = deps;
    let mut seat = SEAT.load(deps.storage)?;
    let charged = charge_rent(&mut seat, &cfg, now);
    bank_rent(&mut deps, charged)?;

    // The skim already landed as attached funds. Propagate a denom mismatch
    // rather than silently treating it as a zero skim: `unwrap_or_default` there
    // would strand the funds in the contract and hide the AMM misconfiguration.
    // The AMM is the only authorized caller and always sends the quote denom, so
    // an error here means the wiring is wrong and should be visible.
    let skim = only_quote(&info.funds, &cfg.quote_denom)?;

    let mut credited_to = "lp".to_string();
    if !skim.is_zero() {
        match &seat.manager {
            Some(mgr) => {
                let cur = CLAIMABLE.may_load(deps.storage, mgr)?.unwrap_or_default();
                CLAIMABLE.save(deps.storage, mgr, &(cur + skim))?;
                credited_to = mgr.to_string();
            }
            None => {
                // No solvent manager to receive the fee: it becomes LP revenue.
                bank_rent(&mut deps, skim)?;
            }
        }
    }
    SEAT.save(deps.storage, &seat)?;

    Ok(Response::new()
        .add_attribute("action", "after_swap")
        .add_attribute("skim", skim)
        .add_attribute("credited_to", credited_to))
}

fn withdraw_rent(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    recipient: String,
    amount: Uint128,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    let now = env.block.time.seconds();
    let mut deps = deps;
    let mut seat = SEAT.load(deps.storage)?;
    let charged = charge_rent(&mut seat, &cfg, now);
    bank_rent(&mut deps, charged)?;
    SEAT.save(deps.storage, &seat)?;

    let accrued = ACCRUED_RENT.may_load(deps.storage)?.unwrap_or_default();
    if amount > accrued {
        return Err(ContractError::InsufficientAccrual {});
    }
    ACCRUED_RENT.save(deps.storage, &(accrued - amount))?;
    let recipient = deps.api.addr_validate(&recipient)?;
    Ok(Response::new()
        .add_message(CosmosMsg::Bank(BankMsg::Send {
            to_address: recipient.to_string(),
            amount: vec![Coin { denom: cfg.quote_denom, amount }],
        }))
        .add_attribute("action", "withdraw_rent")
        .add_attribute("amount", amount))
}

#[allow(clippy::too_many_arguments)]
fn update_config(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    admin: Option<String>,
    min_fee_bps: Option<u16>,
    max_fee_bps: Option<u16>,
    default_fee_bps: Option<u16>,
    min_bid_increment_bps: Option<u16>,
    rent_per_second: Option<Uint128>,
    min_tenure_seconds: Option<u64>,
) -> Result<Response, ContractError> {
    let mut deps = deps;
    let old_cfg = CONFIG.load(deps.storage)?;
    if info.sender != old_cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    let now = env.block.time.seconds();

    // Settle rent at the OLD rate BEFORE any change takes effect. Rent is charged
    // lazily over `now - last_charged` at whatever rate is current when the next
    // callback fires. If we changed `rent_per_second` first, the next charge would
    // re-price every already-elapsed second at the new rate — an admin could raise
    // the rate and have the next `charge_rent` seize the sitting manager's whole
    // bond into `accrued_rent`. Settling here pins those seconds to the old rate
    // and advances `last_charged` to `now`, so the new rate only ever bills the
    // future.
    let mut seat = SEAT.load(deps.storage)?;
    let charged = charge_rent(&mut seat, &old_cfg, now);
    bank_rent(&mut deps, charged)?;
    let manager_sits = seat.manager.is_some();
    SEAT.save(deps.storage, &seat)?; // last_charged == now after this

    // `amm` is intentionally not settable (immutable after instantiate).
    let mut cfg = old_cfg.clone();
    if let Some(a) = admin {
        cfg.admin = deps.api.addr_validate(&a)?;
    }
    if let Some(v) = min_fee_bps {
        cfg.min_fee_bps = v;
    }
    if let Some(v) = max_fee_bps {
        cfg.max_fee_bps = v;
    }
    if let Some(v) = default_fee_bps {
        cfg.default_fee_bps = v;
    }
    if let Some(v) = min_bid_increment_bps {
        cfg.min_bid_increment_bps = v;
    }
    if let Some(v) = rent_per_second {
        // Even with rent settled, a rate *increase* while a manager sits would
        // start billing the bond they posted under the old rate at a higher price
        // than they agreed to, and can still vacate them early. Forbid raising the
        // rate on an occupied seat; a decrease, or any change to a vacant seat, is
        // fine.
        if manager_sits && v > old_cfg.rent_per_second {
            return Err(ContractError::RentIncreaseWhileOccupied {});
        }
        cfg.rent_per_second = v;
    }
    if let Some(v) = min_tenure_seconds {
        cfg.min_tenure_seconds = v;
    }
    if !valid_bounds(&cfg) {
        return Err(ContractError::BadFeeBounds {});
    }
    if cfg.min_bid_increment_bps == 0 {
        return Err(ContractError::BadIncrement {});
    }
    if cfg.min_tenure_seconds == 0 {
        return Err(ContractError::BadTenure {});
    }
    // `minimum_deposit` is `rent_per_second * min_tenure_seconds`. If that
    // overflows it saturates to MAX and no deposit can ever hold the seat — the
    // seat becomes un-takeable. Reject the config instead.
    if cfg
        .rent_per_second
        .checked_mul(Uint128::from(cfg.min_tenure_seconds))
        .is_err()
    {
        return Err(ContractError::MinimumDepositOverflow {});
    }
    CONFIG.save(deps.storage, &cfg)?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::BeforeSwap { ctx } => to_binary(&decide(deps, env, ctx)),
        QueryMsg::Config {} => to_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::Seat {} => to_binary(&seat_response(deps, env)?),
        QueryMsg::Claimable { address } => {
            let addr = deps.api.addr_validate(&address)?;
            to_binary(&CLAIMABLE.may_load(deps.storage, &addr)?.unwrap_or_default())
        }
        QueryMsg::Rent {} => to_binary(&RentResponse {
            accrued_rent: ACCRUED_RENT.may_load(deps.storage)?.unwrap_or_default(),
            lifetime_rent: LIFETIME_RENT.may_load(deps.storage)?.unwrap_or_default(),
        }),
    }
}

/// The pricing decision: the manager's fee if a solvent manager sits, otherwise
/// the default. A failed load defaults to `Proceed` (the AMM's own default fee)
/// rather than erroring — a swap must never revert because this lookup hiccuped.
fn decide(deps: Deps, env: Env, _ctx: SwapContext) -> HookDecision {
    let cfg = match CONFIG.load(deps.storage) {
        Ok(c) => c,
        Err(_) => return HookDecision::Proceed,
    };
    let seat = match SEAT.load(deps.storage) {
        Ok(s) => s,
        Err(_) => return HookDecision::Proceed,
    };
    let fee_bps = projected_fee(&seat, &cfg, env.block.time.seconds());
    HookDecision::OverrideFee { fee_bps }
}

fn seat_response(deps: Deps, env: Env) -> StdResult<SeatResponse> {
    let cfg = CONFIG.load(deps.storage)?;
    let seat = SEAT.load(deps.storage)?;
    let now = env.block.time.seconds();
    let remaining = projected_deposit(&seat, &cfg, now);
    let vacant = seat.manager.is_none() || remaining.is_zero();
    Ok(SeatResponse {
        manager: seat.manager.clone(),
        effective_fee_bps: projected_fee(&seat, &cfg, now),
        fee_bps: seat.fee_bps,
        deposit_remaining: remaining,
        seat_taken: seat.seat_taken,
        seat_changes: seat.seat_changes,
        vacant,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
    use cosmwasm_std::{from_binary, Coin};

    const QUOTE: &str = "uchanse";

    fn cfg_msg() -> InstantiateMsg {
        InstantiateMsg {
            admin: "admin".into(),
            amm: "amm".into(),
            quote_denom: QUOTE.into(),
            min_fee_bps: 10,
            max_fee_bps: 1000,
            default_fee_bps: 30,
            min_bid_increment_bps: 500, // 5%
            rent_per_second: Uint128::new(1), // 1 uchanse/sec
            min_tenure_seconds: 100,
        }
    }

    fn setup() -> cosmwasm_std::OwnedDeps<
        cosmwasm_std::MemoryStorage,
        cosmwasm_std::testing::MockApi,
        cosmwasm_std::testing::MockQuerier,
    > {
        let mut deps = mock_dependencies();
        instantiate(deps.as_mut(), mock_env(), mock_info("admin", &[]), cfg_msg()).unwrap();
        deps
    }

    fn coins(n: u128) -> Vec<Coin> {
        vec![Coin { denom: QUOTE.into(), amount: Uint128::new(n) }]
    }

    fn fee_now(deps: &cosmwasm_std::OwnedDeps<
        cosmwasm_std::MemoryStorage,
        cosmwasm_std::testing::MockApi,
        cosmwasm_std::testing::MockQuerier,
    >, env: &Env) -> u16 {
        let ctx = SwapContext {
            token_address: "t".into(),
            sender: "s".into(),
            offer_ansem: true,
            input_amount: Uint128::new(1),
            ansem_reserve: Uint128::new(1),
            token_reserve: Uint128::new(1),
            default_fee_bps: 30,
        };
        match query(deps.as_ref(), env.clone(), QueryMsg::BeforeSwap { ctx }).unwrap() {
            b => match from_binary::<HookDecision>(&b).unwrap() {
                HookDecision::OverrideFee { fee_bps } => fee_bps,
                other => panic!("expected OverrideFee, got {:?}", other),
            },
        }
    }

    #[test]
    fn vacant_seat_serves_default_fee() {
        let deps = setup();
        assert_eq!(fee_now(&deps, &mock_env()), 30);
    }

    #[test]
    fn config_rejects_over_cap_bounds() {
        let mut deps = mock_dependencies();
        let mut msg = cfg_msg();
        msg.max_fee_bps = 2000; // > 1000 cap
        let err = instantiate(deps.as_mut(), mock_env(), mock_info("admin", &[]), msg).unwrap_err();
        assert!(matches!(err, ContractError::BadFeeBounds {}));
    }

    #[test]
    fn bid_takes_seat_and_sets_fee() {
        let mut deps = setup();
        let env = mock_env();
        // 200 deposit funds >= min_tenure(100) * rent(1) = 100.
        bid(deps.as_mut(), env.clone(), mock_info("alice", &coins(200)), 250).unwrap();
        // before_swap now serves alice's fee.
        assert_eq!(fee_now(&deps, &env), 250);
        let seat = SEAT.load(deps.as_ref().storage).unwrap();
        assert_eq!(seat.manager, Some(Addr::unchecked("alice")));
        assert_eq!(seat.deposit, Uint128::new(200));
    }

    #[test]
    fn bid_rejects_out_of_bounds_fee() {
        let mut deps = setup();
        let err = bid(deps.as_mut(), mock_env(), mock_info("alice", &coins(200)), 5).unwrap_err();
        assert!(matches!(err, ContractError::FeeOutOfBounds { .. }));
    }

    #[test]
    fn bid_rejects_deposit_below_min_tenure() {
        let mut deps = setup();
        // 50 < 100 minimum.
        let err = bid(deps.as_mut(), mock_env(), mock_info("alice", &coins(50)), 250).unwrap_err();
        assert!(matches!(err, ContractError::DepositTooSmall {}));
    }

    #[test]
    fn outbid_blocked_during_tenure() {
        let mut deps = setup();
        let mut env = mock_env();
        bid(deps.as_mut(), env.clone(), mock_info("alice", &coins(200)), 250).unwrap();
        // 50s later, still inside the 100s tenure.
        env.block.time = env.block.time.plus_seconds(50);
        let err = bid(deps.as_mut(), env, mock_info("bob", &coins(1000)), 300).unwrap_err();
        assert!(matches!(err, ContractError::TenureNotExpired {}));
    }

    #[test]
    fn outbid_needs_margin_over_remaining_deposit() {
        let mut deps = setup();
        let mut env = mock_env();
        bid(deps.as_mut(), env.clone(), mock_info("alice", &coins(200)), 250).unwrap();
        // Past the tenure. 120s of rent charged => alice deposit 200-120 = 80.
        env.block.time = env.block.time.plus_seconds(120);
        // displacing_bid(80, 5%) = 80 + ceil(4) = 84. A bid of 83 must fail...
        let err = bid(deps.as_mut(), env.clone(), mock_info("bob", &coins(83)), 300).unwrap_err();
        assert!(matches!(err, ContractError::BidTooLow {}));
        // ...but 100 (>= 84 and >= min_tenure 100) succeeds and refunds alice her
        // remaining 80.
        let res = bid(deps.as_mut(), env.clone(), mock_info("bob", &coins(100)), 300).unwrap();
        let refund = res.messages.iter().find_map(|m| match &m.msg {
            CosmosMsg::Bank(BankMsg::Send { to_address, amount }) => {
                Some((to_address.clone(), amount[0].amount))
            }
            _ => None,
        });
        assert_eq!(refund, Some(("alice".to_string(), Uint128::new(80))));
        assert_eq!(fee_now(&deps, &env), 300);
        let seat = SEAT.load(deps.as_ref().storage).unwrap();
        assert_eq!(seat.manager, Some(Addr::unchecked("bob")));
        assert_eq!(seat.deposit, Uint128::new(100));
        assert_eq!(seat.seat_changes, 2);
    }

    #[test]
    fn incumbent_tops_up_without_margin_or_wait() {
        let mut deps = setup();
        let mut env = mock_env();
        bid(deps.as_mut(), env.clone(), mock_info("alice", &coins(200)), 250).unwrap();
        env.block.time = env.block.time.plus_seconds(30); // 30 rent charged -> 170
        // Same manager tops up 50 and re-prices to 400; no tenure/margin gate.
        bid(deps.as_mut(), env.clone(), mock_info("alice", &coins(50)), 400).unwrap();
        let seat = SEAT.load(deps.as_ref().storage).unwrap();
        assert_eq!(seat.deposit, Uint128::new(220)); // 170 + 50
        assert_eq!(fee_now(&deps, &env), 400);
        // Rent charged so far is banked as LP revenue.
        assert_eq!(
            ACCRUED_RENT.load(deps.as_ref().storage).unwrap(),
            Uint128::new(30)
        );
    }

    #[test]
    fn rent_decay_vacates_and_reverts_to_default_fee() {
        let mut deps = setup();
        let mut env = mock_env();
        bid(deps.as_mut(), env.clone(), mock_info("alice", &coins(200)), 250).unwrap();
        // 250s > 200 deposit at 1/sec: seat is exhausted.
        env.block.time = env.block.time.plus_seconds(250);
        // Projection (read-only) already shows the default fee.
        assert_eq!(fee_now(&deps, &env), 30);
        // An after_swap now settles the vacancy and the whole 200 becomes rent.
        after_swap(
            deps.as_mut(),
            env.clone(),
            mock_info("amm", &coins(0)), // zero skim
        )
        .unwrap();
        let seat = SEAT.load(deps.as_ref().storage).unwrap();
        assert!(seat.manager.is_none());
        assert_eq!(seat.deposit, Uint128::zero());
        assert_eq!(ACCRUED_RENT.load(deps.as_ref().storage).unwrap(), Uint128::new(200));
    }

    #[test]
    fn after_swap_routes_skim_to_manager_then_claim() {
        let mut deps = setup();
        let env = mock_env();
        bid(deps.as_mut(), env.clone(), mock_info("alice", &coins(200)), 250).unwrap();
        // AMM forwards a 40-uchanse skim in the same second (no rent yet).
        after_swap(deps.as_mut(), env.clone(), mock_info("amm", &coins(40))).unwrap();
        let claimable = CLAIMABLE
            .load(deps.as_ref().storage, &Addr::unchecked("alice"))
            .unwrap();
        assert_eq!(claimable, Uint128::new(40));
        // Alice claims it.
        let res = claim(deps.as_mut(), mock_info("alice", &[])).unwrap();
        match &res.messages[0].msg {
            CosmosMsg::Bank(BankMsg::Send { to_address, amount }) => {
                assert_eq!(to_address, "alice");
                assert_eq!(amount[0].amount, Uint128::new(40));
            }
            _ => panic!("expected bank send"),
        }
        assert!(CLAIMABLE
            .may_load(deps.as_ref().storage, &Addr::unchecked("alice"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn displaced_manager_keeps_earned_fees() {
        let mut deps = setup();
        let mut env = mock_env();
        bid(deps.as_mut(), env.clone(), mock_info("alice", &coins(200)), 250).unwrap();
        // Alice earns a 30 skim.
        after_swap(deps.as_mut(), env.clone(), mock_info("amm", &coins(30))).unwrap();
        // Bob displaces her after tenure.
        env.block.time = env.block.time.plus_seconds(150);
        bid(deps.as_mut(), env.clone(), mock_info("bob", &coins(200)), 300).unwrap();
        // Alice still holds her 30 and can claim it though she no longer sits.
        let res = claim(deps.as_mut(), mock_info("alice", &[])).unwrap();
        match &res.messages[0].msg {
            CosmosMsg::Bank(BankMsg::Send { amount, .. }) => {
                assert_eq!(amount[0].amount, Uint128::new(30));
            }
            _ => panic!("expected bank send"),
        }
    }

    #[test]
    fn after_swap_rejects_non_amm() {
        let mut deps = setup();
        let err = after_swap(
            deps.as_mut(),
            mock_env(),
            mock_info("attacker", &coins(40)),
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));
    }

    #[test]
    fn withdraw_refunds_remaining_and_vacates() {
        let mut deps = setup();
        let mut env = mock_env();
        bid(deps.as_mut(), env.clone(), mock_info("alice", &coins(200)), 250).unwrap();
        env.block.time = env.block.time.plus_seconds(60); // 60 rent -> 140 left
        let res = withdraw(deps.as_mut(), env.clone(), mock_info("alice", &[])).unwrap();
        match &res.messages[0].msg {
            CosmosMsg::Bank(BankMsg::Send { to_address, amount }) => {
                assert_eq!(to_address, "alice");
                assert_eq!(amount[0].amount, Uint128::new(140));
            }
            _ => panic!("expected bank send"),
        }
        assert_eq!(fee_now(&deps, &env), 30); // back to default
        assert_eq!(ACCRUED_RENT.load(deps.as_ref().storage).unwrap(), Uint128::new(60));
    }

    #[test]
    fn withdraw_rent_admin_only_and_bounded() {
        let mut deps = setup();
        let env = mock_env();
        bid(deps.as_mut(), env.clone(), mock_info("alice", &coins(200)), 250).unwrap();
        // Accrue some rent.
        let mut later = env.clone();
        later.block.time = later.block.time.plus_seconds(40);
        after_swap(deps.as_mut(), later.clone(), mock_info("amm", &coins(0))).unwrap();
        // Non-admin refused.
        let err = withdraw_rent(
            deps.as_mut(),
            later.clone(),
            mock_info("alice", &[]),
            "alice".into(),
            Uint128::new(10),
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));
        // Over-withdrawal refused (only 40 accrued).
        let err = withdraw_rent(
            deps.as_mut(),
            later.clone(),
            mock_info("admin", &[]),
            "treasury".into(),
            Uint128::new(41),
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::InsufficientAccrual {}));
        // Exact withdrawal ok.
        let res = withdraw_rent(
            deps.as_mut(),
            later,
            mock_info("admin", &[]),
            "treasury".into(),
            Uint128::new(40),
        )
        .unwrap();
        assert_eq!(res.messages.len(), 1);
        assert_eq!(ACCRUED_RENT.load(deps.as_ref().storage).unwrap(), Uint128::zero());
    }

    /// Fix 1 (HIGH): an admin rate change must settle the sitting manager's owed
    /// rent at the OLD rate before the new rate applies, so a rate change can
    /// never retroactively re-price the seconds already elapsed. Also asserts the
    /// two guards that make this airtight: a rate *increase* while a manager sits
    /// is rejected outright, and `amm` cannot be changed at all.
    #[test]
    fn admin_rate_change_settles_at_old_rate() {
        let mut deps = mock_dependencies();
        // rent 2/sec, min_tenure 10 => min_deposit 20.
        let mut msg = cfg_msg();
        msg.rent_per_second = Uint128::new(2);
        msg.min_tenure_seconds = 10;
        instantiate(deps.as_mut(), mock_env(), mock_info("admin", &[]), msg).unwrap();

        let mut env = mock_env();
        bid(deps.as_mut(), env.clone(), mock_info("alice", &coins(200)), 250).unwrap();

        // 30s pass. Owed at the OLD rate is 2*30 = 60.
        env.block.time = env.block.time.plus_seconds(30);

        // A rate INCREASE while alice sits is refused — this is the seizure the
        // audit flagged (raise the rate, next charge banks her whole bond). Her
        // deposit is untouched by the failed attempt.
        let err = update_config(
            deps.as_mut(),
            env.clone(),
            mock_info("admin", &[]),
            None, None, None, None, None,
            Some(Uint128::new(1000)),
            None,
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::RentIncreaseWhileOccupied {}));

        // A DECREASE is allowed, and must settle the 30 elapsed seconds at the OLD
        // rate (60), not the new one (30). If it billed at the new rate this would
        // read 30.
        update_config(
            deps.as_mut(),
            env.clone(),
            mock_info("admin", &[]),
            None, None, None, None, None,
            Some(Uint128::new(1)),
            None,
        )
        .unwrap();
        assert_eq!(
            ACCRUED_RENT.load(deps.as_ref().storage).unwrap(),
            Uint128::new(60),
            "elapsed seconds must be charged at the old rate"
        );
        let seat = SEAT.load(deps.as_ref().storage).unwrap();
        assert_eq!(seat.deposit, Uint128::new(140)); // 200 - 60
        assert_eq!(seat.last_charged, env.block.time.seconds());

        // Future seconds now bill at the NEW rate (1/sec): 10s -> +10 rent.
        env.block.time = env.block.time.plus_seconds(10);
        after_swap(deps.as_mut(), env.clone(), mock_info("amm", &coins(0))).unwrap();
        assert_eq!(
            ACCRUED_RENT.load(deps.as_ref().storage).unwrap(),
            Uint128::new(70) // 60 + 10 at the new rate
        );
        let seat = SEAT.load(deps.as_ref().storage).unwrap();
        assert_eq!(seat.deposit, Uint128::new(130)); // 140 - 10
    }

    /// Fix 4 (LOW): a config whose `rent_per_second * min_tenure_seconds` would
    /// overflow is rejected, so `minimum_deposit` can never saturate to MAX and
    /// strand the seat as un-takeable.
    #[test]
    fn config_rejects_min_deposit_overflow() {
        let mut deps = mock_dependencies();
        let mut msg = cfg_msg();
        msg.rent_per_second = Uint128::MAX;
        msg.min_tenure_seconds = 2;
        let err = instantiate(deps.as_mut(), mock_env(), mock_info("admin", &[]), msg).unwrap_err();
        assert!(matches!(err, ContractError::MinimumDepositOverflow {}));
    }

    /// Fix 3 (LOW): a denom mismatch on the skim is propagated, not silently
    /// swallowed into a 0 skim that would strand the funds.
    #[test]
    fn after_swap_rejects_wrong_denom() {
        let mut deps = setup();
        let env = mock_env();
        bid(deps.as_mut(), env.clone(), mock_info("alice", &coins(200)), 250).unwrap();
        let wrong = vec![Coin { denom: "uwrong".into(), amount: Uint128::new(40) }];
        let err = after_swap(deps.as_mut(), env, mock_info("amm", &wrong)).unwrap_err();
        assert!(matches!(err, ContractError::BadFunds { .. }));
    }

    /// Property test: the contract's bank balance always equals the sum of what it
    /// owes — `Σ deposits + accrued_rent + Σ claimable` — across a long randomized
    /// sequence of every state-changing op. `charge_rent` only ever *moves* value
    /// between those buckets (deposit -> accrued), so the identity must hold after
    /// every operation regardless of how time advances.
    #[test]
    fn balance_equals_obligations_over_random_ops() {
        // Deterministic LCG so the sequence is reproducible without a rng dep.
        let mut rng: u64 = 0x1234_5678_9abc_def0;
        let mut next = |bound: u64| -> u64 {
            rng = rng
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (rng >> 33) % bound
        };

        let mut deps = setup(); // rent 1/sec, min_tenure 100 => min_deposit 100
        let mut env = mock_env();
        // Model of the contract's bank balance: everything paid in, minus every
        // BankMsg::Send it emits.
        let mut balance: u128 = 0;

        // Sum of all quote-denom BankMsg::Send amounts in a response = outflow.
        fn sends(res: &Response) -> u128 {
            res.messages
                .iter()
                .filter_map(|m| match &m.msg {
                    CosmosMsg::Bank(BankMsg::Send { amount, .. }) => {
                        Some(amount.iter().map(|c| c.amount.u128()).sum::<u128>())
                    }
                    _ => None,
                })
                .sum()
        }

        let managers = ["alice", "bob"];

        // Dump / reload the whole store — MemoryStorage is not Clone, so model the
        // tx boundary through the Storage trait.
        use cosmwasm_std::{Order, Storage};
        fn snapshot_store(s: &dyn Storage) -> Vec<(Vec<u8>, Vec<u8>)> {
            s.range(None, None, Order::Ascending).collect()
        }
        fn restore_store(s: &mut dyn Storage, snap: &[(Vec<u8>, Vec<u8>)]) {
            let keys: Vec<Vec<u8>> =
                s.range(None, None, Order::Ascending).map(|(k, _)| k).collect();
            for k in keys {
                s.remove(&k);
            }
            for (k, v) in snap {
                s.set(k, v);
            }
        }

        for _ in 0..400 {
            // On the real chain a failed message reverts every storage write it
            // made. The mock storage has no tx boundary, so snapshot before each
            // op and restore on Err to model that atomicity; only a committed op
            // moves the balance model.
            let snapshot = snapshot_store(deps.as_ref().storage);
            let outcome: Result<u128, ()> = match next(7) {
                0 => {
                    // advance time (rent accrues by projection only)
                    env.block.time = env.block.time.plus_seconds(next(40) + 1);
                    Ok(balance)
                }
                1 => {
                    // bid
                    let who = managers[next(2) as usize];
                    let dep = (next(400) + 1) as u128;
                    let cfg = CONFIG.load(deps.as_ref().storage).unwrap();
                    let fee = cfg.min_fee_bps as u64
                        + next((cfg.max_fee_bps - cfg.min_fee_bps + 1) as u64);
                    bid(
                        deps.as_mut(),
                        env.clone(),
                        mock_info(who, &coins(dep)),
                        fee as u16,
                    )
                    .map(|res| balance + dep - sends(&res))
                    .map_err(|_| ())
                }
                2 => {
                    // after_swap with a random skim (may be 0)
                    let skim = next(80) as u128;
                    after_swap(deps.as_mut(), env.clone(), mock_info("amm", &coins(skim)))
                        .map(|res| balance + skim - sends(&res))
                        .map_err(|_| ())
                }
                3 => {
                    // claim
                    let who = managers[next(2) as usize];
                    claim(deps.as_mut(), mock_info(who, &[]))
                        .map(|res| balance - sends(&res))
                        .map_err(|_| ())
                }
                4 => {
                    // withdraw (relinquish seat)
                    let who = managers[next(2) as usize];
                    withdraw(deps.as_mut(), env.clone(), mock_info(who, &[]))
                        .map(|res| balance - sends(&res))
                        .map_err(|_| ())
                }
                5 => {
                    // withdraw_rent (admin pulls accrued)
                    let accrued = ACCRUED_RENT.load(deps.as_ref().storage).unwrap().u128();
                    let amount = if accrued > 0 { next((accrued + 1) as u64) as u128 } else { 0 };
                    withdraw_rent(
                        deps.as_mut(),
                        env.clone(),
                        mock_info("admin", &[]),
                        "treasury".into(),
                        Uint128::new(amount),
                    )
                    .map(|res| balance - sends(&res))
                    .map_err(|_| ())
                }
                _ => {
                    // update_config: try a random rent (accepted or rejected)
                    let new_rent = Uint128::new((next(3) + 1) as u128); // 1..=3
                    update_config(
                        deps.as_mut(),
                        env.clone(),
                        mock_info("admin", &[]),
                        None, None, None, None, None,
                        Some(new_rent),
                        None,
                    )
                    .map(|_| balance)
                    .map_err(|_| ())
                }
            };
            match outcome {
                Ok(new_balance) => balance = new_balance,
                Err(()) => restore_store(deps.as_mut().storage, &snapshot), // revert partial writes
            }

            // Invariant: balance == Σ deposits + accrued_rent + Σ claimable.
            let seat = SEAT.load(deps.as_ref().storage).unwrap();
            let accrued = ACCRUED_RENT.load(deps.as_ref().storage).unwrap().u128();
            let claimable: u128 = managers
                .iter()
                .map(|m| {
                    CLAIMABLE
                        .may_load(deps.as_ref().storage, &Addr::unchecked(*m))
                        .unwrap()
                        .unwrap_or_default()
                        .u128()
                })
                .sum();
            assert_eq!(
                balance,
                seat.deposit.u128() + accrued + claimable,
                "balance must equal deposits + accrued_rent + claimable"
            );
        }
    }
}
