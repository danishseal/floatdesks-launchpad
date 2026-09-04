//! Arbitrage-improvement Horn — a `before_swap` pricing Horn that fills a swap at
//! a better price than the pool's own constant-product curve when an external
//! **reference price** says the pool is mispriced, and hands the trader the
//! improvement instead of letting a backrunner take it.
//!
//! # What this is a port of
//!
//! It ports `arb-vector` from the Vector (Solana) stack. That program reads a
//! second, deeper AMM venue (a Meteora DAMM pool) as its reference price; when
//! the pool it is attached to prices a swap worse for the trader than the
//! reference does, it fills part of the swap from its own inventory at a price
//! between the two, so the trader gets a better fill than the pool and the Horn
//! captures the spread that a Jito searcher's backrun would otherwise have taken.
//!
//! # The ANSEM adaptation, stated plainly
//!
//! **ANSEM has no second AMM venue to read as the reference price.** There is one
//! constant-product AMM per token. So this Horn uses the **ANSEM oracle contract**
//! as its reference instead of a second venue: it queries a configured oracle
//! address for a price and compares that against what the pool would pay.
//!
//! Consequences of that substitution, none of them hidden:
//!
//! - The oracle deployed on ansem-1 reports **CHANSE/USD** (micro-USD, 6 dp). A
//!   single CHANSE/USD number cannot by itself price an arbitrary `token/CHANSE`
//!   pool. This Horn therefore treats the configured oracle's returned price as
//!   the reference price of the pool's **token, quoted in micro-quote units per
//!   whole token** (`PRICE_SCALE = 1e6` = par). For a pool whose token *is* the
//!   asset that oracle tracks in quote terms this is exact; for a general token
//!   the operator must point `oracle` at an oracle instance that reports that
//!   token's quote price. The Horn cannot verify this and does not try to.
//!
//! - The Solana version closes its position atomically by selling the absorbed
//!   inventory back into the reference venue in the same transaction. **There is
//!   no venue to unwind against here**, so this Horn does not close a loop inside
//!   the swap. It reprices the swap toward the oracle and the improvement is a
//!   subsidy; a keeper is expected to rebalance the Horn's inventory over time.
//!
//! # How the improvement is delivered, and why exposure is *cumulative*
//!
//! A `before_swap` **query** cannot move funds, and an AMM `Delta` is settled by
//! the AMM **against the pool's reserves**, not against this contract's balance
//! (the same constraint `horn-floor` documents). So the extra output the trader
//! receives above the constant-product amount is **paid out of pool (LP)
//! reserves**, not out of this Horn's inventory. This Horn's own balance is only
//! ever *read*, never spent.
//!
//! That has a consequence the earlier draft of this module got wrong and this one
//! states honestly: **exposure to the LPs is unbounded-cumulative, capped only
//! per swap.** Each individual fill's improvement is capped at
//! `max_improvement_bps` of the pool's own output (the manipulation bound), but
//! nothing in a per-swap query stops the *sum* of those subsidies from growing
//! without limit under a wrong or stale oracle — every swap in the mispriced
//! direction bleeds a little more of the LPs' reserves, and the mispricing can
//! persist. Reading the Horn's inventory does **not** bound this: the tokens do
//! not come from inventory, so "the Horn is funded" underwrites nothing.
//!
//! # The cumulative bound: an on-chain subsidy budget
//!
//! To make the cumulative give-away actually bounded, this Horn keeps an on-chain
//! `SUBSIDY_BUDGET` (a `Uint128`), funded/set by the admin. `plan_fill` gates on
//! it: it will not authorize a fill whose improvement exceeds the remaining
//! budget. The budget is then **decremented as fills are observed**, via the
//! AMM's `after_swap` callback (the same callback `horn-feeshare` uses; this Horn
//! must be attached with the `AFTER_SWAP` flag set, or the budget never
//! decrements and the bound does not exist — see the operator note below).
//!
//! `after_swap` cannot recover the *exact* improvement it applied, because the
//! AMM's callback carries no pre-swap reserves and no default fee — only the
//! settled `output_amount`. It therefore decrements by a provable **upper bound**
//! on the improvement: given `output = pool_out + improvement` and
//! `improvement <= pool_out * m / BPS` (the per-swap cap, `m = max_improvement_bps`),
//! algebra gives `improvement <= output * m / (BPS + m)`. Decrementing by that
//! upper bound guarantees `Σ(actual improvements) <= Σ(upper bounds) <=` the
//! initial budget, so the cumulative LP give-away is genuinely capped by the
//! budget the admin funded. It is conservative (it may retire budget slightly
//! faster than the true give-away), which is the safe direction.
//!
//! A Horn-priced fill settles with a zero AMM fee (`fee_bps = 0` on a `Delta`),
//! so `fee_amount == 0` in the callback is the signal that this Horn actually
//! priced the swap; only then is the budget decremented. (On a pool whose default
//! fee is itself zero, ordinary swaps also arrive with `fee_amount == 0` and the
//! budget retires faster — still the safe direction, never unbounded.)
//!
//! # Safety: it can only ever decline
//!
//! Every failure mode degrades to `Proceed`, so the Horn can never break a swap:
//! - oracle query fails, or the reading is stale → `Proceed`;
//! - oracle does not price the pool better for the trader → `Proceed`;
//! - the edge is below `min_edge_bps` → `Proceed`;
//! - the improvement would exceed the remaining `SUBSIDY_BUDGET` → `Proceed`;
//! - the Horn's inventory of the output asset is below the improvement → `Proceed`;
//! - the improved fill would exceed the pool's out-side reserve → `Proceed`;
//! - any arithmetic overflows → `Proceed` (fail closed).
//!
//! The improvement handed over is additionally capped at `max_improvement_bps` of
//! the pool's own output — a manipulation bound built from the pool's price, which
//! an attacker can only move by trading against the pool at their own expense.
//! This is `arb-vector`'s property 3, carried over intact.
//!
//! # Operator note
//!
//! Because the subsidy is paid from LP reserves and only the budget bounds the
//! cumulative give-away, deploy this Horn only on a pool whose oracle is
//! correctly pointed, trusted and fresh, keep `max_improvement_bps` conservative,
//! **require freshness** (`require_fresh` is forced `true`; a stale oracle →
//! `Proceed`), and **attach it with both `BEFORE_SWAP` and `AFTER_SWAP` flags** so
//! the budget decrements. Fund the budget to the most you are willing to subsidize
//! the LPs by in total.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_binary, Addr, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult,
    Uint128, Uint256,
};
use cw_storage_plus::Item;
use thiserror::Error;

const BPS: u128 = 10_000;

/// Fixed-point scale for the oracle reference price. `PRICE_SCALE` micro-quote
/// units == one whole token, i.e. a returned price of `1_000_000` is par (1 token
/// worth 1 quote unit). Matches the oracle's own 6-decimal micro convention.
pub const PRICE_SCALE: u128 = 1_000_000;

/// Hard ceiling on the improvement the Horn will offer over the pool price.
///
/// The manipulation bound (property 3 of `arb-vector`): capped low on purpose so
/// a misconfigured or shoved oracle cannot volunteer the pool to be drained. 5%
/// is far past any honest mispricing on a liquid pool.
pub const MAX_IMPROVEMENT_BPS: u16 = 500;

/// Conservative default for `max_improvement_bps` (0.5%). Well below the ceiling:
/// the per-swap cap is the only thing standing between a wrong oracle and a fast
/// drain of the budget, so keep it small unless the oracle is known-tight.
pub const DEFAULT_MAX_IMPROVEMENT_BPS: u16 = 50;

/// The trader's share of the edge, strictly below 100% so the Horn keeps a
/// positive spread and never prices *above* the reference.
pub const MAX_TRADER_BPS: u16 = 9_999;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("trader_bps must be <= 9999")]
    TraderTooHigh {},
    #[error("max_improvement_bps must be <= 500")]
    ImprovementTooHigh {},
    #[error("min_edge_bps must be <= 10000")]
    EdgeTooHigh {},
    #[error("require_fresh must be true: a stale oracle would let the cumulative LP subsidy grow unbounded")]
    MustRequireFresh {},
}

// ── mirrors of amm::hooks (serialize identically) ───────────────────────────

#[cw_serde]
pub struct SwapContext {
    pub token_address: String,
    pub sender: String,
    /// true = ANSEM/quote in, token out.
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

// ── minimal mirror of the ANSEM oracle's query surface ──────────────────────
// Only the shape this Horn reads. cw_serde does not deny unknown fields, so the
// oracle's fuller `PriceResponse` (sol price, heights, source…) deserializes
// fine into this subset.

#[cw_serde]
enum OracleQuery {
    /// Latest spot price. `require_fresh=Some(true)` fails the query if stale.
    Price { require_fresh: Option<bool> },
}

#[cw_serde]
struct OraclePriceResponse {
    /// Reference price in micro-quote units per whole token (see PRICE_SCALE).
    ansem_usd_price: Uint128,
    /// Whether the latest reading is within the oracle's max age.
    fresh: bool,
}

// minimal CW20 balance query, for the buy-direction inventory gate.
#[cw_serde]
enum Cw20Query {
    Balance { address: String },
}
#[cw_serde]
struct BalanceResponse {
    balance: Uint128,
}

// ── state ───────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    /// The ANSEM oracle contract queried for the reference price.
    pub oracle: Addr,
    /// The AMM — the only address allowed to call `after_swap` (which decrements
    /// the subsidy budget). Mirrors `horn-feeshare`.
    pub amm: Addr,
    /// The pool's native quote denom (uchanse | uansem). Used to read this Horn's
    /// own bank balance as inventory on the sell direction (token in, quote out).
    pub quote_denom: String,
    /// Share of the raw edge (reference_out - pool_out) handed to the trader as a
    /// better fill. The remainder is the Horn's spread. Strictly < 10000.
    pub trader_bps: u16,
    /// Smallest edge, as bps of the pool's own output, worth acting on. Below
    /// this the Horn declines rather than spend a delta on dust.
    pub min_edge_bps: u16,
    /// Ceiling on the improvement offered over the pool price. The manipulation
    /// bound; must be <= MAX_IMPROVEMENT_BPS.
    pub max_improvement_bps: u16,
    /// Require the oracle reading to be fresh. Forced `true` (see `validate_cfg`):
    /// a stale oracle → Proceed, so the cumulative subsidy cannot grow on a frozen
    /// price.
    pub require_fresh: bool,
}

const CONFIG: Item<Config> = Item::new("config");

/// Remaining cumulative subsidy the Horn may still authorize out of LP reserves.
/// Funded/set by the admin, decremented (by an upper bound on each applied
/// improvement) in `after_swap`. `plan_fill` will not authorize a fill whose
/// improvement exceeds this. This is the honest cumulative bound.
const SUBSIDY_BUDGET: Item<Uint128> = Item::new("subsidy_budget");

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub oracle: String,
    pub amm: String,
    pub quote_denom: String,
    pub trader_bps: u16,
    pub min_edge_bps: u16,
    pub max_improvement_bps: u16,
    /// Must be true (a stale oracle would un-bound the cumulative subsidy).
    pub require_fresh: bool,
    /// Initial cumulative subsidy budget (may be zero; top up later via
    /// `SetSubsidyBudget`).
    pub subsidy_budget: Uint128,
}

#[cw_serde]
pub enum ExecuteMsg {
    UpdateConfig {
        admin: Option<String>,
        oracle: Option<String>,
        amm: Option<String>,
        quote_denom: Option<String>,
        trader_bps: Option<u16>,
        min_edge_bps: Option<u16>,
        max_improvement_bps: Option<u16>,
        require_fresh: Option<bool>,
    },
    /// Admin: set the remaining cumulative subsidy budget (absolute).
    SetSubsidyBudget { remaining: Uint128 },
    /// AMM callback — MUST match the AMM's `HookExecute::AfterSwap` shape. Used
    /// only to decrement the subsidy budget by an upper bound on the improvement
    /// this Horn applied to the swap. AMM-gated.
    AfterSwap {
        token_address: String,
        sender: String,
        offer_ansem: bool,
        input_amount: Uint128,
        output_amount: Uint128,
        fee_amount: Uint128,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(HookDecision)]
    BeforeSwap { ctx: SwapContext },
    #[returns(Config)]
    Config {},
    #[returns(Uint128)]
    SubsidyBudget {},
}

// ── pricing math (pure, Uint256 internally, fail-closed) ────────────────────

fn u(n: u128) -> Uint256 {
    Uint256::from(n)
}

/// Constant-product output for `input` against `(r_in, r_out)` with a bps fee.
/// Mirrors the AMM's own curve. `None` for any degenerate input, so the caller
/// falls back to `Proceed`.
fn cp_out(input: u128, r_in: u128, r_out: u128, fee_bps: u16) -> Option<u128> {
    if input == 0 || r_in == 0 || r_out == 0 || fee_bps as u128 >= BPS {
        return None;
    }
    let in_after = u(input) * u(BPS - fee_bps as u128) / u(BPS);
    if in_after.is_zero() {
        return None;
    }
    let num = u(r_out) * in_after;
    let den = u(r_in) + in_after;
    if den.is_zero() {
        return None;
    }
    let out = num / den;
    let out = Uint128::try_from(out).ok()?.u128();
    if out == 0 || out > r_out {
        None
    } else {
        Some(out)
    }
}

/// Reference output implied by the oracle price `price` (micro-quote per whole
/// token). Direction-aware and self-consistent on a round trip:
///   * buy  (quote in, token out): out = input * PRICE_SCALE / price
///   * sell (token in, quote out): out = input * price / PRICE_SCALE
fn ref_out(input: u128, price: u128, offer_ansem: bool) -> Option<u128> {
    if input == 0 || price == 0 {
        return None;
    }
    let out = if offer_ansem {
        u(input) * u(PRICE_SCALE) / u(price)
    } else {
        u(input) * u(price) / u(PRICE_SCALE)
    };
    let out = Uint128::try_from(out).ok()?.u128();
    if out == 0 {
        None
    } else {
        Some(out)
    }
}

/// Provable upper bound on the improvement a fill of size `output` could have
/// carried, given the per-swap cap `max_improvement_bps` (`m`):
///   `output = pool_out + improvement` and `improvement <= pool_out * m / BPS`
///   ⇒ `improvement <= output * m / (BPS + m)`.
/// Computed in Uint256 so it never overflows; saturates to `u128::MAX` in the
/// (impossible for real reserves) case it would not fit. This is what
/// `after_swap` retires from the budget — always ≥ the true improvement, so the
/// budget bounds the cumulative give-away from above.
fn improvement_upper_bound(output: u128, max_improvement_bps: u16) -> u128 {
    let m = max_improvement_bps as u128;
    let ub = u(output) * u(m) / u(BPS + m);
    Uint128::try_from(ub).map(|x| x.u128()).unwrap_or(u128::MAX)
}

/// Decide the improved fill.
///
/// Given what the pool would pay (`pool_out`) and what the reference implies
/// (`reference_out`), returns the improved `amount_out` (>= `pool_out`) if it is
/// worth acting on and every guard clears, else `None`. This is the whole
/// price-comparison + delta decision, factored out so it is directly unit-tested.
///
/// Guards, all fail-closed:
/// 1. reference must be strictly better for the trader than the pool;
/// 2. the raw edge must clear `min_edge_bps` of `pool_out`;
/// 3. the trader's share is capped at `max_improvement_bps` of `pool_out` (the
///    manipulation bound);
/// 4. the improvement must not exceed the remaining `budget` (cumulative bound)
///    nor the Horn's `inventory` of the output asset (per-swap solvency check);
/// 5. the improved fill must not exceed the pool's out-side reserve.
#[allow(clippy::too_many_arguments)]
fn plan_fill(
    pool_out: u128,
    reference_out: u128,
    inventory: u128,
    budget: u128,
    out_reserve: u128,
    trader_bps: u16,
    min_edge_bps: u16,
    max_improvement_bps: u16,
) -> Option<u128> {
    if reference_out <= pool_out {
        return None; // reference is not better for the trader
    }
    let raw_edge = reference_out - pool_out;

    // (2) edge threshold: raw_edge / pool_out >= min_edge_bps / BPS
    if u(raw_edge) * u(BPS) < u(pool_out) * u(min_edge_bps as u128) {
        return None;
    }

    // trader's slice of the edge …
    let trader_edge = u(raw_edge) * u(trader_bps as u128) / u(BPS);
    // … capped by the manipulation bound (3).
    let cap = u(pool_out) * u(max_improvement_bps as u128) / u(BPS);
    let improvement = if trader_edge < cap { trader_edge } else { cap };
    let improvement = Uint128::try_from(improvement).ok()?.u128();
    if improvement == 0 {
        return None;
    }

    // (4) cumulative-budget gate and per-swap funded-inventory gate.
    if improvement > budget {
        return None;
    }
    if improvement > inventory {
        return None;
    }

    let fill_out = pool_out.checked_add(improvement)?;
    // (5) never ask the AMM for more than the pool holds.
    if fill_out > out_reserve {
        return None;
    }
    Some(fill_out)
}

// ── entry points ────────────────────────────────────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    cw2::set_contract_version(deps.storage, "ansem-horn-arb", env!("CARGO_PKG_VERSION"))?;
    validate_cfg(msg.trader_bps, msg.min_edge_bps, msg.max_improvement_bps, msg.require_fresh)?;
    CONFIG.save(
        deps.storage,
        &Config {
            admin: deps.api.addr_validate(&msg.admin)?,
            oracle: deps.api.addr_validate(&msg.oracle)?,
            amm: deps.api.addr_validate(&msg.amm)?,
            quote_denom: msg.quote_denom,
            trader_bps: msg.trader_bps,
            min_edge_bps: msg.min_edge_bps,
            max_improvement_bps: msg.max_improvement_bps,
            require_fresh: msg.require_fresh,
        },
    )?;
    SUBSIDY_BUDGET.save(deps.storage, &msg.subsidy_budget)?;
    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("subsidy_budget", msg.subsidy_budget))
}

fn validate_cfg(
    trader_bps: u16,
    min_edge_bps: u16,
    max_improvement_bps: u16,
    require_fresh: bool,
) -> Result<(), ContractError> {
    if trader_bps > MAX_TRADER_BPS {
        return Err(ContractError::TraderTooHigh {});
    }
    if max_improvement_bps > MAX_IMPROVEMENT_BPS {
        return Err(ContractError::ImprovementTooHigh {});
    }
    if min_edge_bps as u128 > BPS {
        return Err(ContractError::EdgeTooHigh {});
    }
    // Fix #2 (LOW): require_fresh=false is a footgun with no independent max-age,
    // and (fix #1) a frozen oracle would make the cumulative subsidy unbounded.
    // Reject it outright rather than trust an operator to set it.
    if !require_fresh {
        return Err(ContractError::MustRequireFresh {});
    }
    Ok(())
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::UpdateConfig {
            admin,
            oracle,
            amm,
            quote_denom,
            trader_bps,
            min_edge_bps,
            max_improvement_bps,
            require_fresh,
        } => update_config(
            deps, info, admin, oracle, amm, quote_denom, trader_bps, min_edge_bps,
            max_improvement_bps, require_fresh,
        ),
        ExecuteMsg::SetSubsidyBudget { remaining } => set_subsidy_budget(deps, info, remaining),
        ExecuteMsg::AfterSwap {
            offer_ansem,
            output_amount,
            fee_amount,
            ..
        } => after_swap(deps, info, offer_ansem, output_amount, fee_amount),
    }
}

#[allow(clippy::too_many_arguments)]
fn update_config(
    deps: DepsMut,
    info: MessageInfo,
    admin: Option<String>,
    oracle: Option<String>,
    amm: Option<String>,
    quote_denom: Option<String>,
    trader_bps: Option<u16>,
    min_edge_bps: Option<u16>,
    max_improvement_bps: Option<u16>,
    require_fresh: Option<bool>,
) -> Result<Response, ContractError> {
    let mut cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    if let Some(a) = admin {
        cfg.admin = deps.api.addr_validate(&a)?;
    }
    if let Some(o) = oracle {
        cfg.oracle = deps.api.addr_validate(&o)?;
    }
    if let Some(a) = amm {
        cfg.amm = deps.api.addr_validate(&a)?;
    }
    if let Some(q) = quote_denom {
        cfg.quote_denom = q;
    }
    if let Some(t) = trader_bps {
        cfg.trader_bps = t;
    }
    if let Some(m) = min_edge_bps {
        cfg.min_edge_bps = m;
    }
    if let Some(m) = max_improvement_bps {
        cfg.max_improvement_bps = m;
    }
    if let Some(r) = require_fresh {
        cfg.require_fresh = r;
    }
    validate_cfg(cfg.trader_bps, cfg.min_edge_bps, cfg.max_improvement_bps, cfg.require_fresh)?;
    CONFIG.save(deps.storage, &cfg)?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

fn set_subsidy_budget(
    deps: DepsMut,
    info: MessageInfo,
    remaining: Uint128,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    SUBSIDY_BUDGET.save(deps.storage, &remaining)?;
    Ok(Response::new()
        .add_attribute("action", "set_subsidy_budget")
        .add_attribute("remaining", remaining))
}

/// AMM callback. The only purpose here is to retire budget for the improvement
/// this Horn just paid the trader out of LP reserves. AMM-gated; a non-AMM caller
/// cannot touch the budget.
///
/// `fee_amount == 0` is the signal that this Horn actually priced the swap (a
/// `Delta` settles with a zero AMM fee). Only then do we decrement, by the
/// provable upper bound on the improvement (`improvement_upper_bound`). On any
/// other swap we do nothing, so this callback never reverts a trade.
fn after_swap(
    deps: DepsMut,
    info: MessageInfo,
    _offer_ansem: bool,
    output_amount: Uint128,
    fee_amount: Uint128,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.amm {
        return Err(ContractError::Unauthorized {});
    }
    // A non-zero fee means the AMM ran its own curve (Proceed / OverrideFee), not
    // one of this Horn's zero-fee Deltas: no subsidy was paid, nothing to retire.
    if !fee_amount.is_zero() || output_amount.is_zero() {
        return Ok(Response::new()
            .add_attribute("action", "after_swap")
            .add_attribute("retired", "0"));
    }
    let retire = improvement_upper_bound(output_amount.u128(), cfg.max_improvement_bps);
    let budget = SUBSIDY_BUDGET.may_load(deps.storage)?.unwrap_or_default();
    let new_budget = budget.saturating_sub(Uint128::new(retire));
    SUBSIDY_BUDGET.save(deps.storage, &new_budget)?;
    Ok(Response::new()
        .add_attribute("action", "after_swap")
        .add_attribute("retired", Uint128::new(retire))
        .add_attribute("subsidy_budget", new_budget))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::BeforeSwap { ctx } => to_binary(&decide(deps, env, ctx)),
        QueryMsg::Config {} => to_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::SubsidyBudget {} => {
            to_binary(&SUBSIDY_BUDGET.may_load(deps.storage)?.unwrap_or_default())
        }
    }
}

/// The Horn's decision. Any missing precondition returns `Proceed` so a swap is
/// never broken by this Horn (see the module docs' safety list).
fn decide(deps: Deps, env: Env, ctx: SwapContext) -> HookDecision {
    let cfg = match CONFIG.load(deps.storage) {
        Ok(c) => c,
        Err(_) => return HookDecision::Proceed,
    };

    // Reserves by direction.
    let (in_reserve, out_reserve) = if ctx.offer_ansem {
        (ctx.ansem_reserve.u128(), ctx.token_reserve.u128())
    } else {
        (ctx.token_reserve.u128(), ctx.ansem_reserve.u128())
    };

    // What the pool itself would pay.
    let pool_out = match cp_out(ctx.input_amount.u128(), in_reserve, out_reserve, ctx.default_fee_bps) {
        Some(p) => p,
        None => return HookDecision::Proceed,
    };

    // The reference price. A failed or stale oracle is a reason to stand down,
    // never to fail somebody else's swap.
    let price: OraclePriceResponse = match deps.querier.query_wasm_smart(
        cfg.oracle.clone(),
        &OracleQuery::Price {
            require_fresh: Some(cfg.require_fresh),
        },
    ) {
        Ok(p) => p,
        Err(_) => return HookDecision::Proceed,
    };
    if cfg.require_fresh && !price.fresh {
        return HookDecision::Proceed;
    }
    let reference_out = match ref_out(ctx.input_amount.u128(), price.ansem_usd_price.u128(), ctx.offer_ansem) {
        Some(r) => r,
        None => return HookDecision::Proceed,
    };

    // Cumulative subsidy budget: the honest bound on total LP give-away.
    let budget = SUBSIDY_BUDGET.may_load(deps.storage).ok().flatten().unwrap_or_default().u128();

    // Per-swap funded-inventory gate: the Horn's own balance of the OUTPUT asset.
    // On a buy the output is the CW20 token; on a sell it is the native quote
    // denom. This is a solvency sanity check, NOT the cumulative bound (the
    // subsidy is paid from pool reserves, not this balance).
    let inventory = if ctx.offer_ansem {
        deps.querier
            .query_wasm_smart::<BalanceResponse>(
                ctx.token_address.clone(),
                &Cw20Query::Balance {
                    address: env.contract.address.to_string(),
                },
            )
            .map(|r| r.balance.u128())
            .unwrap_or(0)
    } else {
        deps.querier
            .query_balance(&env.contract.address, &cfg.quote_denom)
            .map(|c| c.amount.u128())
            .unwrap_or(0)
    };

    match plan_fill(
        pool_out,
        reference_out,
        inventory,
        budget,
        out_reserve,
        cfg.trader_bps,
        cfg.min_edge_bps,
        cfg.max_improvement_bps,
    ) {
        Some(fill_out) => HookDecision::Delta {
            amount_in: ctx.input_amount,
            amount_out: Uint128::new(fill_out),
        },
        None => HookDecision::Proceed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
    use cosmwasm_std::{
        coins, from_binary, to_binary, Coin, ContractResult, OwnedDeps, SystemResult, WasmQuery,
    };

    // ── cp_out ──────────────────────────────────────────────────────────────

    #[test]
    fn cp_out_matches_constant_product_with_fee() {
        // 1_000 in against 1e9/1e9, 100bps fee. in_after = 990.
        // out = 1e9*990 / (1e9+990) ≈ 989.
        let out = cp_out(1_000, 1_000_000_000, 1_000_000_000, 100).unwrap();
        assert_eq!(out, 989);
    }

    #[test]
    fn cp_out_degenerate_is_none() {
        assert!(cp_out(0, 10, 10, 30).is_none());
        assert!(cp_out(10, 0, 10, 30).is_none());
        assert!(cp_out(10, 10, 0, 30).is_none());
        assert!(cp_out(10, 10, 10, 10_000).is_none()); // 100% fee
    }

    // ── ref_out (price comparison primitive) ────────────────────────────────

    #[test]
    fn ref_out_is_direction_aware_and_round_trips() {
        // price = 2_000_000 micro-quote per token => 1 token worth 2 quote.
        // buy: 100 quote in -> 100 * 1e6 / 2e6 = 50 tokens.
        assert_eq!(ref_out(100, 2_000_000, true).unwrap(), 50);
        // sell: 50 tokens in -> 50 * 2e6 / 1e6 = 100 quote.
        assert_eq!(ref_out(50, 2_000_000, false).unwrap(), 100);
    }

    #[test]
    fn ref_out_zero_price_is_none() {
        assert!(ref_out(100, 0, true).is_none());
        assert!(ref_out(0, 2_000_000, true).is_none());
    }

    // ── improvement_upper_bound (the budget-retirement primitive) ───────────

    #[test]
    fn upper_bound_is_at_least_the_true_improvement() {
        // pool_out 1_000, improvement 49 (the 5% cap) => output 1_049.
        // ub = 1_049 * 500 / 10_500 = 49 (floor). Never below the true 49.
        assert!(improvement_upper_bound(1_049, 500) >= 49);
        // A smaller true improvement under the same output/cap is still bounded.
        // output 1_038 (pool 989 + 49) => 1_038*500/10_500 = 49.
        assert_eq!(improvement_upper_bound(1_038, 500), 49);
        // zero cap => zero retirement.
        assert_eq!(improvement_upper_bound(1_000, 0), 0);
    }

    // ── plan_fill: the price-comparison + delta decision ────────────────────
    // Signature: (pool_out, reference_out, inventory, budget, out_reserve,
    //             trader_bps, min_edge_bps, max_improvement_bps)

    #[test]
    fn no_fill_when_reference_not_better() {
        // reference equals / below pool: nothing to do.
        assert!(plan_fill(1_000, 1_000, u128::MAX, u128::MAX, u128::MAX, 5_000, 0, 500).is_none());
        assert!(plan_fill(1_000, 900, u128::MAX, u128::MAX, u128::MAX, 5_000, 0, 500).is_none());
    }

    #[test]
    fn fill_hands_trader_half_the_edge() {
        // pool 1_000, reference 1_100 -> raw edge 100, trader_bps 5_000 -> +50.
        let fill = plan_fill(1_000, 1_100, u128::MAX, u128::MAX, u128::MAX, 5_000, 0, 500).unwrap();
        assert_eq!(fill, 1_050);
    }

    #[test]
    fn improvement_is_capped_by_manipulation_bound() {
        // A huge reference (a shoved/misconfigured oracle) still only yields the
        // capped improvement: max_improvement_bps 500 = 5% of pool 1_000 = 50.
        let fill = plan_fill(1_000, 100_000, u128::MAX, u128::MAX, u128::MAX, 9_999, 0, 500).unwrap();
        assert_eq!(fill, 1_050); // pool + 5% cap, not the full runaway edge
    }

    #[test]
    fn min_edge_gate_declines_dust() {
        // raw edge 5 on pool 1_000 = 50 bps; min_edge_bps 100 (1%) => decline.
        assert!(plan_fill(1_000, 1_005, u128::MAX, u128::MAX, u128::MAX, 5_000, 100, 500).is_none());
        // raise the edge past the gate: 1_020 = 200 bps > 100 => acts.
        assert!(plan_fill(1_000, 1_020, u128::MAX, u128::MAX, u128::MAX, 5_000, 100, 500).is_some());
    }

    #[test]
    fn insufficient_inventory_declines() {
        // improvement would be 50 but the Horn holds only 40 → decline.
        assert!(plan_fill(1_000, 1_100, 40, u128::MAX, u128::MAX, 5_000, 0, 500).is_none());
        // exactly enough → acts.
        assert!(plan_fill(1_000, 1_100, 50, u128::MAX, u128::MAX, 5_000, 0, 500).is_some());
    }

    #[test]
    fn insufficient_budget_declines() {
        // improvement would be 50 but only 49 budget remains → decline.
        assert!(plan_fill(1_000, 1_100, u128::MAX, 49, u128::MAX, 5_000, 0, 500).is_none());
        // exactly enough budget → acts.
        assert!(plan_fill(1_000, 1_100, u128::MAX, 50, u128::MAX, 5_000, 0, 500).is_some());
    }

    #[test]
    fn fill_never_exceeds_out_reserve() {
        // improved fill 1_050 but the pool only holds 1_040 → decline (the AMM
        // would reject the delta anyway; we fail closed first).
        assert!(plan_fill(1_000, 1_100, u128::MAX, u128::MAX, 1_040, 5_000, 0, 500).is_none());
        assert!(plan_fill(1_000, 1_100, u128::MAX, u128::MAX, 1_050, 5_000, 0, 500).is_some());
    }

    #[test]
    fn zero_improvement_after_rounding_declines() {
        // trader_bps small enough that the trader's slice rounds to 0.
        assert!(plan_fill(1_000, 1_001, u128::MAX, u128::MAX, u128::MAX, 1, 0, 500).is_none());
    }

    #[test]
    fn large_reserves_do_not_overflow() {
        // near-u128 reserves must not panic; the Uint256 math absorbs the product.
        let big = u128::MAX / 2;
        let _ = cp_out(1_000_000, big, big, 100);
        let _ = plan_fill(big, big, u128::MAX, u128::MAX, big, 5_000, 0, 500);
    }

    // ── config / instantiate ────────────────────────────────────────────────

    fn good_init() -> InstantiateMsg {
        InstantiateMsg {
            admin: "admin".into(),
            oracle: "oracle".into(),
            amm: "amm".into(),
            quote_denom: "uchanse".into(),
            trader_bps: 5_000,
            min_edge_bps: 0,
            max_improvement_bps: 500,
            require_fresh: true,
            subsidy_budget: Uint128::new(1_000_000),
        }
    }

    #[test]
    fn instantiate_rejects_out_of_range_bps() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let info = mock_info("admin", &[]);
        // improvement above ceiling.
        let bad = InstantiateMsg { max_improvement_bps: 5_000, ..good_init() };
        assert_eq!(
            instantiate(deps.as_mut(), env.clone(), info.clone(), bad).unwrap_err(),
            ContractError::ImprovementTooHigh {}
        );
        // trader share at 100% is rejected (would zero the Horn's spread).
        let bad2 = InstantiateMsg { trader_bps: 10_000, ..good_init() };
        assert_eq!(
            instantiate(deps.as_mut(), env, info, bad2).unwrap_err(),
            ContractError::TraderTooHigh {}
        );
    }

    #[test]
    fn instantiate_rejects_require_fresh_false() {
        let mut deps = mock_dependencies();
        let bad = InstantiateMsg { require_fresh: false, ..good_init() };
        assert_eq!(
            instantiate(deps.as_mut(), mock_env(), mock_info("admin", &[]), bad).unwrap_err(),
            ContractError::MustRequireFresh {}
        );
    }

    #[test]
    fn update_config_rejects_require_fresh_false() {
        let mut deps = mock_dependencies();
        instantiate(deps.as_mut(), mock_env(), mock_info("admin", &[]), good_init()).unwrap();
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            ExecuteMsg::UpdateConfig {
                admin: None, oracle: None, amm: None, quote_denom: None, trader_bps: None,
                min_edge_bps: None, max_improvement_bps: None, require_fresh: Some(false),
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::MustRequireFresh {});
    }

    #[test]
    fn instantiate_and_load_config() {
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            InstantiateMsg { max_improvement_bps: 300, ..good_init() },
        )
        .unwrap();
        let cfg = CONFIG.load(deps.as_ref().storage).unwrap();
        assert_eq!(cfg.trader_bps, 5_000);
        assert_eq!(cfg.max_improvement_bps, 300);
        assert_eq!(cfg.quote_denom, "uchanse");
        assert_eq!(cfg.amm, Addr::unchecked("amm"));
        assert_eq!(SUBSIDY_BUDGET.load(deps.as_ref().storage).unwrap(), Uint128::new(1_000_000));
    }

    // ── budget admin + after_swap decrement ─────────────────────────────────

    #[test]
    fn set_subsidy_budget_is_admin_only() {
        let mut deps = mock_dependencies();
        instantiate(deps.as_mut(), mock_env(), mock_info("admin", &[]), good_init()).unwrap();
        // stranger rejected
        assert_eq!(
            execute(
                deps.as_mut(), mock_env(), mock_info("mallory", &[]),
                ExecuteMsg::SetSubsidyBudget { remaining: Uint128::new(5) },
            ).unwrap_err(),
            ContractError::Unauthorized {}
        );
        // admin ok
        execute(
            deps.as_mut(), mock_env(), mock_info("admin", &[]),
            ExecuteMsg::SetSubsidyBudget { remaining: Uint128::new(777) },
        ).unwrap();
        assert_eq!(SUBSIDY_BUDGET.load(deps.as_ref().storage).unwrap(), Uint128::new(777));
    }

    fn after_swap_msg(output: u128, fee: u128) -> ExecuteMsg {
        ExecuteMsg::AfterSwap {
            token_address: "token".into(),
            sender: "alice".into(),
            offer_ansem: true,
            input_amount: Uint128::new(1_000),
            output_amount: Uint128::new(output),
            fee_amount: Uint128::new(fee),
        }
    }

    #[test]
    fn after_swap_is_amm_gated() {
        let mut deps = mock_dependencies();
        instantiate(deps.as_mut(), mock_env(), mock_info("admin", &[]), good_init()).unwrap();
        // a non-AMM caller cannot touch the budget.
        assert_eq!(
            execute(deps.as_mut(), mock_env(), mock_info("alice", &[]), after_swap_msg(1_038, 0))
                .unwrap_err(),
            ContractError::Unauthorized {}
        );
        assert_eq!(SUBSIDY_BUDGET.load(deps.as_ref().storage).unwrap(), Uint128::new(1_000_000));
    }

    #[test]
    fn after_swap_only_retires_on_zero_fee_delta() {
        let mut deps = mock_dependencies();
        instantiate(deps.as_mut(), mock_env(), mock_info("admin", &[]), good_init()).unwrap();
        // a normal swap (non-zero fee) retires nothing.
        execute(deps.as_mut(), mock_env(), mock_info("amm", &[]), after_swap_msg(1_038, 7)).unwrap();
        assert_eq!(SUBSIDY_BUDGET.load(deps.as_ref().storage).unwrap(), Uint128::new(1_000_000));
        // a zero-fee delta retires the upper bound (1_038*500/10_500 = 49).
        execute(deps.as_mut(), mock_env(), mock_info("amm", &[]), after_swap_msg(1_038, 0)).unwrap();
        assert_eq!(SUBSIDY_BUDGET.load(deps.as_ref().storage).unwrap(), Uint128::new(999_951));
    }

    /// The cumulative bound: repeated fills can never give away more than the
    /// funded budget. Retire until it saturates at zero and stays there.
    #[test]
    fn cumulative_subsidy_is_bounded_by_the_budget() {
        let mut deps = mock_dependencies();
        // fund a small budget: 120. Each 1_038-output delta retires 49.
        instantiate(
            deps.as_mut(), mock_env(), mock_info("admin", &[]),
            InstantiateMsg { subsidy_budget: Uint128::new(120), ..good_init() },
        ).unwrap();
        let retire = improvement_upper_bound(1_038, 500);
        assert_eq!(retire, 49);
        // three deltas: 120 -> 71 -> 22 -> 0 (saturating), never negative.
        for _ in 0..3 {
            execute(deps.as_mut(), mock_env(), mock_info("amm", &[]), after_swap_msg(1_038, 0)).unwrap();
        }
        assert_eq!(SUBSIDY_BUDGET.load(deps.as_ref().storage).unwrap(), Uint128::zero());
        // once exhausted, plan_fill would decline any further improvement.
        assert!(plan_fill(1_000, 1_100, u128::MAX, 0, u128::MAX, 5_000, 0, 500).is_none());
    }

    // ── decide(): full path against a mocked querier ────────────────────────

    type Deps = OwnedDeps<
        cosmwasm_std::MemoryStorage,
        cosmwasm_std::testing::MockApi,
        cosmwasm_std::testing::MockQuerier,
    >;

    /// Instantiate, then wire a querier that answers the oracle `Price` query and
    /// the CW20 `Balance` query. `oracle_price = None` simulates the oracle being
    /// down (query errors). Native (sell-side) inventory is set separately.
    fn wired_deps(oracle_price: Option<(u128, bool)>, token_balance: u128) -> Deps {
        let mut deps = mock_dependencies();
        instantiate(deps.as_mut(), mock_env(), mock_info("admin", &[]), good_init()).unwrap();
        deps.querier.update_wasm(move |q| match q {
            WasmQuery::Smart { contract_addr, .. } if contract_addr == "oracle" => {
                match oracle_price {
                    Some((price, fresh)) => SystemResult::Ok(ContractResult::Ok(
                        to_binary(&OraclePriceResponse {
                            ansem_usd_price: Uint128::new(price),
                            fresh,
                        })
                        .unwrap(),
                    )),
                    None => SystemResult::Ok(ContractResult::Err("oracle down".into())),
                }
            }
            WasmQuery::Smart { contract_addr, .. } if contract_addr == "token" => {
                SystemResult::Ok(ContractResult::Ok(
                    to_binary(&BalanceResponse { balance: Uint128::new(token_balance) }).unwrap(),
                ))
            }
            _ => SystemResult::Ok(ContractResult::Err("unexpected query".into())),
        });
        deps
    }

    fn buy_ctx() -> SwapContext {
        // ansem in, token out. cp_out(1_000, 1e6, 1e6, 100) = 989.
        SwapContext {
            token_address: "token".into(),
            sender: "alice".into(),
            offer_ansem: true,
            input_amount: Uint128::new(1_000),
            ansem_reserve: Uint128::new(1_000_000),
            token_reserve: Uint128::new(1_000_000),
            default_fee_bps: 100,
        }
    }

    #[test]
    fn decide_oracle_down_proceeds() {
        let deps = wired_deps(None, 1_000_000);
        assert_eq!(decide(deps.as_ref(), mock_env(), buy_ctx()), HookDecision::Proceed);
    }

    #[test]
    fn decide_stale_oracle_proceeds() {
        // price would give a big edge, but fresh=false with require_fresh → stand down.
        let deps = wired_deps(Some((900_000, false)), 1_000_000);
        assert_eq!(decide(deps.as_ref(), mock_env(), buy_ctx()), HookDecision::Proceed);
    }

    #[test]
    fn decide_buy_reads_cw20_inventory_and_deltas() {
        // fresh price 900_000 => ref_out = 1_000*1e6/900_000 = 1_111 > pool 989.
        // raw_edge 122, trader 5_000 => 61, capped at 5% of 989 = 49 => fill 1_038.
        let deps = wired_deps(Some((900_000, true)), 1_000_000);
        match decide(deps.as_ref(), mock_env(), buy_ctx()) {
            HookDecision::Delta { amount_in, amount_out } => {
                assert_eq!(amount_in, Uint128::new(1_000));
                assert_eq!(amount_out, Uint128::new(1_038));
            }
            other => panic!("expected Delta, got {other:?}"),
        }
        // same edge but the Horn holds too little of the token → Proceed.
        let deps = wired_deps(Some((900_000, true)), 10);
        assert_eq!(decide(deps.as_ref(), mock_env(), buy_ctx()), HookDecision::Proceed);
    }

    #[test]
    fn decide_sell_reads_native_inventory_and_deltas() {
        // token in, quote (ansem) out. pool_out 989. price 1_100_000 =>
        // ref_out = 1_000*1_100_000/1e6 = 1_100 > 989, fill 1_038 quote out.
        let mut deps = wired_deps(Some((1_100_000, true)), 0);
        // fund the native quote inventory on the contract address.
        let contract = mock_env().contract.address;
        deps.querier.update_balance(contract.clone(), coins(1_000_000, "uchanse"));
        let mut ctx = buy_ctx();
        ctx.offer_ansem = false;
        match decide(deps.as_ref(), mock_env(), ctx.clone()) {
            HookDecision::Delta { amount_out, .. } => assert_eq!(amount_out, Uint128::new(1_038)),
            other => panic!("expected Delta, got {other:?}"),
        }
        // drain the native inventory → the funded-inventory gate declines.
        deps.querier.update_balance(contract, Vec::<Coin>::new());
        assert_eq!(decide(deps.as_ref(), mock_env(), ctx), HookDecision::Proceed);
    }

    #[test]
    fn decide_declines_when_budget_exhausted() {
        let mut deps = wired_deps(Some((900_000, true)), 1_000_000);
        // zero the budget: even a good, funded, fresh edge must Proceed now.
        SUBSIDY_BUDGET.save(deps.as_mut().storage, &Uint128::zero()).unwrap();
        assert_eq!(decide(deps.as_ref(), mock_env(), buy_ctx()), HookDecision::Proceed);
    }

    #[test]
    fn decision_wire_format_round_trips() {
        let back: HookDecision = from_binary(&to_binary(&HookDecision::Proceed).unwrap()).unwrap();
        assert_eq!(back, HookDecision::Proceed);
    }
}
