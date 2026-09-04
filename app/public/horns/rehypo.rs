//! Rehypothecation Horn — "liquidity that earns while it waits."
//!
//! # What is being ported
//!
//! This is the CosmWasm/ANSEM adaptation of Vector's `rehypo-vector`, itself a
//! port of Bunni v2's headline feature (generalised in OpenZeppelin's
//! `ReHypothecationHook`). The one-sentence pitch of the original: pair the
//! steady APY of a lending vault with the swap fees of an AMM, by never letting
//! the value that backs a market sit idle. On Vector the mechanism is aggressive
//! — a `before_swap` callback pulls liquidity out of a yield source, supplies it
//! as a just-in-time fill on the very trade, and `after_swap` puts the proceeds
//! straight back, so the capital is out of the yield source for *zero slots*.
//!
//! # What DOES NOT port, and why (read this before trusting the name)
//!
//! Two hard facts of this environment remove the aggressive half of the design:
//!
//! 1. **CosmWasm has no just-in-time liquidity injection.** The AMM is a plain
//!    constant-product pool. A Horn is called *after* a swap has already priced
//!    and settled against the pool's own reserves (see `contracts/amm` hooks);
//!    there is no `before_swap` that can add depth to the curve for this trade,
//!    and a hook cannot re-enter the AMM mid-swap to become a second
//!    counterparty. So the "fill a slice of the trade out of the yield source"
//!    core of Bunni/rehypo-vector is simply not expressible here.
//!
//! 2. **ANSEM HAS NO LENDING PROTOCOL to rehypothecate into.** There is no
//!    Kamino / Save / marginfi / Aave-equivalent live on this chain. The Vector
//!    source is explicit that faking a lender is worse than omitting one,
//!    because an untested integration "looks finished". The same honesty applies
//!    here, harder: there is nothing real to integrate with at all.
//!
//! # What this Horn therefore actually is
//!
//! The honest, buildable subset: a **treasury that banks a slice of swap value
//! and can optionally deploy the idle portion into a PLUGGABLE, EXTERNAL yield
//! sink** — an interface, not a lender. Concretely:
//!
//! * `after_swap` (AMM callback) banks the fee skim the AMM forwards as attached
//!   funds. This is the "swap fees" leg of the pitch. It is deliberately trivial
//!   and NON-REVERTING: a Horn failure reverts the whole trade, so the callback
//!   only records value and never touches the external sink.
//!
//! * A `reserve_ratio_bps` splits the treasury's total value into a liquid
//!   reserve **held right here** and a deployed portion **placed in the yield
//!   sink to earn**. This is the "never let it sit idle" leg — the analogue of
//!   the yield source, reduced to what a message-passing chain can actually do.
//!
//! * `yield_sink` is an OPTIONAL external contract address. If it is `None`,
//!   the value simply **accrues (is held)** and this Horn is a passive treasury.
//!   There is no default sink and no address is invented; wiring a real one is a
//!   later, explicit governance action once such a contract exists on ANSEM.
//!
//! * `Rebalance {}` (permissionless) moves value between the held reserve and
//!   the sink to hit `reserve_ratio_bps`, the way the Vector source realises
//!   interest only at points a client controls (`poke`/deposit/withdraw) rather
//!   than inside the swap callback.
//!
//! * `Harvest {}` (permissionless) pulls accrued yield back from the sink into
//!   the held reserve, by querying the sink for this contract's balance and
//!   withdrawing anything above the principal we deployed.
//!
//! # The pluggable sink interface (deliberately generic)
//!
//! We do not know what a future ANSEM lending contract will look like, so the
//! sink boundary is a minimal, generic message/query pair that a real adapter
//! (or a thin shim in front of one) can satisfy:
//!
//! * `YieldSinkMsg::Deposit {}`   — funds attached; the sink puts them to work.
//! * `YieldSinkMsg::Withdraw { amount, denom }` — send `amount` back to us.
//! * `YieldSinkQuery::Balance { account }` -> `{ balance }` — our claim, in the
//!   quote denom, principal plus whatever interest has accrued.
//!
//! `DEPLOYED` is *our* accounting of principal sent to the sink. Following the
//! Bunni-$8.3M lesson quoted in the Vector source (an accounting update that
//! assumed a balance moved by the amount intended), the accounting here is
//! intentionally conservative: `Harvest` treats only `sink_balance - DEPLOYED`
//! as realisable yield and never books value it cannot see, and `Rebalance`
//! never deposits more than it physically holds.
//!
//! # Trust chain and denom
//!
//! `config.amm` is the only address allowed to call `after_swap` (same as every
//! other Horn). The treasury currency is the pool's quote denom
//! (`uchanse` | `uansem`). `Rebalance` and `Harvest` are permissionless: a
//! keeper or any holder can fire them, and value can only ever move between this
//! contract and the *configured* sink — never to a caller-supplied recipient.
//!
//! # Custody trust point (say it plainly)
//!
//! Be honest about where trust actually sits: **`admin` + `yield_sink` together
//! are a custody trust point.** `admin` picks the sink and the reserve ratio, so
//! a malicious admin who set a hostile sink and a low reserve ratio could route
//! the deployable portion of the treasury into that sink and have it kept. The
//! earlier claim that "nothing lets value leave to an arbitrary recipient" was
//! only true of *callers*; it was never true of `admin`. Three guards narrow
//! this, none of them a substitute for putting `admin` behind governance:
//!
//! 1. `MIN_RESERVE_RATIO_BPS` is a hard floor on the reserve ratio, so the
//!    maximum deployable fraction is capped strictly below 100% **on any single
//!    transaction**. Be honest about the scope of this: it is a per-transaction
//!    cap, NOT a standing guarantee that a hostile sink can only ever hold that
//!    fraction. A lying/malicious sink can defeat it cumulatively across the
//!    permissionless hourly rebalances: each cycle it reports `balance = 0`, the
//!    downward clamp (guard 3) writes the deployed principal off as a reported
//!    loss, and the next `Rebalance` re-deploys ~90% of the *remaining* reserve
//!    into that same sink. Compounded over enough cycles this drains nearly the
//!    entire treasury into the sink. The floor bounds the bite per transaction; it
//!    does not bound the total a determined hostile sink can capture over time.
//! 2. The sink cannot be cleared or repointed while principal is deployed
//!    (`DEPLOYED > 0`): a full withdraw-to-zero (or an explicit, event-logged
//!    `ReconcileDeployed`) must happen first, so a live sink relationship cannot
//!    be silently severed and the counter cannot drift with no way to correct it.
//! 3. `Harvest`/`Rebalance` trust the sink *downward*: they clamp `DEPLOYED` to
//!    the sink's reported balance, so a reported loss reconciles the treasury
//!    view instead of bricking withdrawals.
//!
//! What is deliberately NOT built yet, and should gate wiring a real sink: a
//! **sink allowlist** (governance-curated set of vetted sink addresses) and a
//! **timelock** on `admin` sink/ratio changes so holders can exit ahead of a
//! hostile retune. Until `admin` is a timelocked governance address behind a
//! governance-curated sink allowlist, **treat a configured sink as fully
//! trusted with the whole treasury**, not merely the per-transaction deployable
//! fraction: as guard 1 spells out, a hostile sink can capture nearly all of the
//! treasury cumulatively across rebalances, so the per-transaction floor is not a
//! standing bound on the loss. `admin` may retune the ratio (subject to the
//! floor) and set/replace/clear the sink (subject to the deployed-principal
//! guard).

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_binary, Addr, Binary, Coin, CosmosMsg, Deps, DepsMut, Env, MessageInfo,
    Response, StdResult, Uint128, WasmMsg,
};
use cw_storage_plus::Item;
use thiserror::Error;

const BPS: u128 = 10_000;

/// Hard floor on `reserve_ratio_bps`: at least this fraction of the treasury is
/// always held liquid here, so the maximum deployable fraction is capped strictly
/// below 100% **on any single transaction** (Fix 2). 1000 bps = 10% minimum
/// reserve => at most 90% deployable per rebalance. This is a per-transaction cap
/// only, NOT a standing guarantee against a hostile sink: a lying sink that
/// reports `balance = 0` each cycle can, across successive permissionless
/// rebalances, have the downward clamp write off principal and then re-deploy ~90%
/// of the remainder again, cumulatively capturing nearly the whole treasury. See
/// the custody-trust-point note in the module header (guard 1).
pub const MIN_RESERVE_RATIO_BPS: u16 = 1_000;

/// Minimum wall-clock gap (seconds) between permissionless `Rebalance` calls.
/// Against a fee-charging sink, unthrottled round-trips are a griefing vector
/// (Fix 4); one hour is coarse enough to kill spam and fine enough for a keeper.
pub const MIN_REBALANCE_INTERVAL_SECS: u64 = 3_600;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("reserve ratio must be <= 10000 bps")]
    BadRatio {},
    #[error("reserve ratio must be >= {min} bps (deployable fraction is capped)")]
    ReserveTooLow { min: u16 },
    #[error("no yield sink configured")]
    NoSink {},
    #[error("cannot change yield_sink while principal is deployed (DEPLOYED > 0); \
             withdraw to zero via Rebalance or correct the counter with ReconcileDeployed first")]
    SinkChangeWhileDeployed {},
    #[error("rebalance called too soon; minimum interval is {min_secs}s")]
    RebalanceTooSoon { min_secs: u64 },
    #[error("nothing to do")]
    Noop {},
}

// ── state ───────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    /// The AMM — the only caller allowed to invoke `after_swap`.
    pub amm: Addr,
    /// The pool's quote denom (uchanse | uansem): the treasury currency.
    pub quote_denom: String,
    /// OPTIONAL external yield sink. `None` = value is simply held (accrues in
    /// place). No address is ever invented; there is no live ANSEM lender to
    /// point this at yet, so it stays unset until governance wires a real one.
    pub yield_sink: Option<Addr>,
    /// Fraction of total treasury value (in bps) to keep as a LIQUID RESERVE
    /// held in this contract. The remainder `(10000 - reserve_ratio_bps)` is the
    /// portion `Rebalance` deploys into the sink to earn. `10000` = hold
    /// everything (never deploy); `0` = deploy everything the sink will take.
    pub reserve_ratio_bps: u16,
}

const CONFIG: Item<Config> = Item::new("config");
/// Cumulative quote ever banked from swaps (display; live reserve is the balance).
const BANKED: Item<Uint128> = Item::new("banked");
/// Principal we have deposited into the yield sink, by OUR accounting.
const DEPLOYED: Item<Uint128> = Item::new("deployed");
/// Cumulative yield ever pulled back via `Harvest` (display).
const HARVESTED: Item<Uint128> = Item::new("harvested");
/// Unix seconds of the last `Rebalance` that moved value or reconciled (Fix 4
/// spam gate). `0` (unset) means one has never run.
const LAST_REBALANCE: Item<u64> = Item::new("last_rebalance");

// ── messages ────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub amm: String,
    pub quote_denom: String,
    /// Optional at genesis; typically `None` until a real sink exists.
    pub yield_sink: Option<String>,
    pub reserve_ratio_bps: u16,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// AMM callback — MUST match the AMM's `HookExecute::AfterSwap` shape. The
    /// fee skim arrives as attached funds and is banked into the reserve. This
    /// path never touches the external sink, so it can never revert a trade.
    AfterSwap {
        token_address: String,
        sender: String,
        offer_ansem: bool,
        input_amount: Uint128,
        output_amount: Uint128,
        fee_amount: Uint128,
    },
    /// PERMISSIONLESS: move value between the held reserve and the sink so the
    /// held portion matches `reserve_ratio_bps`. No-op (errors `Noop`) when
    /// already balanced or when no sink is configured.
    Rebalance {},
    /// PERMISSIONLESS: pull accrued yield (sink balance above deployed
    /// principal) back into the held reserve. Requires a configured sink.
    Harvest {},
    /// ADMIN-ONLY escape hatch (Fix 1): forcibly set the `DEPLOYED` principal
    /// counter to `amount`. This exists for exactly one situation — a sink
    /// relationship was severed, or the sink reports a permanent loss, and the
    /// on-chain counter no longer reflects reality with no `Rebalance`/`Harvest`
    /// path to correct it (e.g. the sink is gone, so its balance can't be
    /// queried). It moves no funds; it only repairs the accounting so the sink
    /// can then be cleared/repointed. Event-logged with the old and new values.
    ReconcileDeployed { amount: Uint128 },
    UpdateConfig {
        admin: Option<String>,
        amm: Option<String>,
        reserve_ratio_bps: Option<u16>,
        /// `Some(Some(addr))` sets/replaces the sink; `Some(None)` clears it;
        /// `None` leaves it unchanged.
        yield_sink: Option<Option<String>>,
    },
}

/// Generic pluggable-sink interface. A real ANSEM lending adapter (or a shim in
/// front of one) implements these. Kept minimal on purpose: no live lender
/// exists to pin a richer shape to.
#[cw_serde]
pub enum YieldSinkMsg {
    /// Attach `quote_denom` funds; the sink puts them to work.
    Deposit {},
    /// Send `amount` of `denom` back to the caller (this Horn).
    Withdraw { amount: Uint128, denom: String },
}

#[cw_serde]
enum YieldSinkQuery {
    /// Our claim on the sink, in base units of the quote denom (principal + accrued).
    Balance { account: String },
}
#[cw_serde]
struct SinkBalanceResponse {
    balance: Uint128,
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(Config)]
    Config {},
    #[returns(TreasuryResponse)]
    Treasury {},
}

#[cw_serde]
pub struct TreasuryResponse {
    /// Quote currency held liquid in this contract right now.
    pub held: Uint128,
    /// Principal deployed into the sink (our accounting).
    pub deployed: Uint128,
    /// held + deployed.
    pub total: Uint128,
    /// Cumulative quote ever banked from swaps.
    pub banked_total: Uint128,
    /// Cumulative yield ever harvested.
    pub harvested_total: Uint128,
    /// The configured reserve target.
    pub reserve_ratio_bps: u16,
    /// The configured sink, if any.
    pub yield_sink: Option<Addr>,
}

// ── pure reserve accounting (unit-tested) ────────────────────────────────────

/// What `Rebalance` should do to hit `reserve_ratio_bps`, given the liquid
/// `held` balance and the `deployed` principal.
///
/// Total value is conserved: `held + deployed`. The target held reserve is
/// `total * reserve_ratio_bps / 10000` (rounds down, i.e. slightly favours
/// deploying), and the target deployed is the rest. A positive delta means send
/// more to the sink; negative means pull some back. A deposit is additionally
/// capped at what we physically hold, which by construction it never exceeds but
/// is asserted rather than assumed.
#[derive(Debug, PartialEq, Eq)]
pub enum RebalanceAction {
    Deposit(Uint128),
    Withdraw(Uint128),
    None,
}

pub fn plan_rebalance(held: Uint128, deployed: Uint128, reserve_ratio_bps: u16) -> RebalanceAction {
    // Fix 5: all arithmetic goes through Uint128 checked helpers. A treasury
    // total that somehow overflowed u128 saturates rather than wrapping (and
    // with `overflow-checks` a plain `+` would panic); `multiply_ratio` floors
    // the reserve target, still slightly favouring deploying.
    let total = held.checked_add(deployed).unwrap_or(Uint128::MAX);
    let target_reserve = total.multiply_ratio(reserve_ratio_bps as u128, BPS);
    // total >= target_reserve by construction (ratio <= BPS), so this is safe.
    let target_deployed = total.checked_sub(target_reserve).unwrap_or(Uint128::zero());
    if target_deployed > deployed {
        // Deploy the difference, never more than we physically hold.
        let want = target_deployed - deployed;
        let capped = want.min(held);
        if capped.is_zero() {
            RebalanceAction::None
        } else {
            RebalanceAction::Deposit(capped)
        }
    } else if target_deployed < deployed {
        RebalanceAction::Withdraw(deployed - target_deployed)
    } else {
        RebalanceAction::None
    }
}

// ── entry points ────────────────────────────────────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    cw2::set_contract_version(deps.storage, "ansem-horn-rehypo", env!("CARGO_PKG_VERSION"))?;
    validate_ratio(msg.reserve_ratio_bps)?;
    let yield_sink = match msg.yield_sink {
        Some(s) => Some(deps.api.addr_validate(&s)?),
        None => None,
    };
    CONFIG.save(
        deps.storage,
        &Config {
            admin: deps.api.addr_validate(&msg.admin)?,
            amm: deps.api.addr_validate(&msg.amm)?,
            quote_denom: msg.quote_denom,
            yield_sink,
            reserve_ratio_bps: msg.reserve_ratio_bps,
        },
    )?;
    BANKED.save(deps.storage, &Uint128::zero())?;
    DEPLOYED.save(deps.storage, &Uint128::zero())?;
    HARVESTED.save(deps.storage, &Uint128::zero())?;
    LAST_REBALANCE.save(deps.storage, &0u64)?;
    Ok(Response::new().add_attribute("action", "instantiate"))
}

/// Enforce both the ceiling (Uint128 math would break above BPS) and the floor
/// (Fix 2: cap the deployable fraction strictly below 100%).
fn validate_ratio(reserve_ratio_bps: u16) -> Result<(), ContractError> {
    if reserve_ratio_bps as u128 > BPS {
        return Err(ContractError::BadRatio {});
    }
    if reserve_ratio_bps < MIN_RESERVE_RATIO_BPS {
        return Err(ContractError::ReserveTooLow {
            min: MIN_RESERVE_RATIO_BPS,
        });
    }
    Ok(())
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::AfterSwap { .. } => after_swap(deps, info),
        ExecuteMsg::Rebalance {} => rebalance(deps, env),
        ExecuteMsg::Harvest {} => harvest(deps, env),
        ExecuteMsg::ReconcileDeployed { amount } => reconcile_deployed(deps, info, amount),
        ExecuteMsg::UpdateConfig {
            admin,
            amm,
            reserve_ratio_bps,
            yield_sink,
        } => update_config(deps, info, admin, amm, reserve_ratio_bps, yield_sink),
    }
}

/// Bank the AMM's fee skim. NON-REVERTING by construction: it only reads
/// `info.funds` and writes the banked counter, and never calls the sink, so an
/// unconfigured or misbehaving sink can never break a live trade.
fn after_swap(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.amm {
        return Err(ContractError::Unauthorized {});
    }
    let added: Uint128 = info
        .funds
        .iter()
        .filter(|c| c.denom == cfg.quote_denom)
        .map(|c| c.amount)
        .sum();
    if !added.is_zero() {
        let total = BANKED.may_load(deps.storage)?.unwrap_or_default() + added;
        BANKED.save(deps.storage, &total)?;
    }
    // The skimmed funds now sit in this contract's balance as liquid reserve.
    // Deploying them to the sink is deferred to the permissionless `Rebalance`,
    // exactly so this callback can never fail a swap.
    Ok(Response::new()
        .add_attribute("action", "after_swap")
        .add_attribute("banked", added))
}

/// Permissionless: move value between the held reserve and the sink to hit the
/// configured reserve ratio.
fn rebalance(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let sink = cfg.yield_sink.clone().ok_or(ContractError::NoSink {})?;

    // Fix 4: throttle permissionless round-trips. Against a fee-charging sink,
    // unlimited Rebalance calls let an attacker bleed the treasury on fees.
    let now = env.block.time.seconds();
    let last = LAST_REBALANCE.may_load(deps.storage)?.unwrap_or(0);
    if last != 0 && now < last.saturating_add(MIN_REBALANCE_INTERVAL_SECS) {
        return Err(ContractError::RebalanceTooSoon {
            min_secs: MIN_REBALANCE_INTERVAL_SECS,
        });
    }

    let held = deps
        .querier
        .query_balance(&env.contract.address, &cfg.quote_denom)?
        .amount;
    let mut deployed = DEPLOYED.may_load(deps.storage)?.unwrap_or_default();

    // Fix 3: trust the sink downward. Query what the sink says we hold and clamp
    // our principal counter to it if it reports less (a loss). Without this a
    // reported loss leaves `deployed > sink_balance`, and a later withdraw for
    // `deployed - target` would ask the sink for more than it has and brick.
    // Trusting the sink DOWNward is safe (it can only shrink our claim, never
    // inflate it); we never trust it upward here.
    let sink_balance: SinkBalanceResponse = deps.querier.query_wasm_smart(
        sink.to_string(),
        &YieldSinkQuery::Balance {
            account: env.contract.address.to_string(),
        },
    )?;
    let mut reconciled = false;
    if sink_balance.balance < deployed {
        deployed = sink_balance.balance;
        reconciled = true;
    }

    let action = plan_rebalance(held, deployed, cfg.reserve_ratio_bps);
    let (msg, attr) = match action {
        RebalanceAction::None => {
            if reconciled {
                // The clamp is a real state repair; persist it and stamp the
                // interval rather than rolling back with an error.
                DEPLOYED.save(deps.storage, &deployed)?;
                LAST_REBALANCE.save(deps.storage, &now)?;
                return Ok(Response::new()
                    .add_attribute("action", "rebalance")
                    .add_attribute("reconciled_deployed_to", deployed));
            }
            return Err(ContractError::Noop {});
        }
        RebalanceAction::Deposit(amount) => {
            // Optimistic: credit principal now; the funds leave in this same tx.
            deployed += amount;
            (
                CosmosMsg::Wasm(WasmMsg::Execute {
                    contract_addr: sink.to_string(),
                    msg: to_binary(&YieldSinkMsg::Deposit {})?,
                    funds: vec![Coin {
                        denom: cfg.quote_denom.clone(),
                        amount,
                    }],
                }),
                ("deposit", amount),
            )
        }
        RebalanceAction::Withdraw(amount) => {
            // Reduce principal now; the funds arrive from the sink in this tx.
            // `amount` is `deployed - target_deployed` by construction, so this
            // subtraction can never underflow.
            deployed = deployed
                .checked_sub(amount)
                .map_err(cosmwasm_std::StdError::overflow)?;
            (
                CosmosMsg::Wasm(WasmMsg::Execute {
                    contract_addr: sink.to_string(),
                    msg: to_binary(&YieldSinkMsg::Withdraw {
                        amount,
                        denom: cfg.quote_denom.clone(),
                    })?,
                    funds: vec![],
                }),
                ("withdraw", amount),
            )
        }
    };
    DEPLOYED.save(deps.storage, &deployed)?;
    LAST_REBALANCE.save(deps.storage, &now)?;
    Ok(Response::new()
        .add_message(msg)
        .add_attribute("action", "rebalance")
        .add_attribute("reconciled", reconciled.to_string())
        .add_attribute(attr.0, attr.1))
}

/// Permissionless: query the sink for our claim and pull anything above the
/// principal we deployed back into the held reserve. Conservative: only
/// `sink_balance - deployed` is treated as realisable, so we never ask for value
/// the sink does not report.
fn harvest(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let sink = cfg.yield_sink.clone().ok_or(ContractError::NoSink {})?;
    let deployed = DEPLOYED.may_load(deps.storage)?.unwrap_or_default();

    let claim: SinkBalanceResponse = deps.querier.query_wasm_smart(
        sink.to_string(),
        &YieldSinkQuery::Balance {
            account: env.contract.address.to_string(),
        },
    )?;
    // Fix 3: if the sink reports LESS than our recorded principal, it took a
    // loss. Clamp `deployed` down to the reported balance and PERSIST it (return
    // Ok, not an error, or the repair would roll back), so the corrupted view
    // can never brick a later withdraw. There is no yield to pull in this case.
    if claim.balance < deployed {
        DEPLOYED.save(deps.storage, &claim.balance)?;
        return Ok(Response::new()
            .add_attribute("action", "harvest")
            .add_attribute("reconciled_deployed_to", claim.balance)
            .add_attribute("yield", Uint128::zero()));
    }
    let yield_amount = claim.balance.saturating_sub(deployed);
    if yield_amount.is_zero() {
        return Err(ContractError::Noop {});
    }
    // Pull only the interest; principal (`deployed`) stays at work and is left
    // untouched in our accounting.
    let total_harvested = HARVESTED.may_load(deps.storage)?.unwrap_or_default() + yield_amount;
    HARVESTED.save(deps.storage, &total_harvested)?;

    let msg = CosmosMsg::Wasm(WasmMsg::Execute {
        contract_addr: sink.to_string(),
        msg: to_binary(&YieldSinkMsg::Withdraw {
            amount: yield_amount,
            denom: cfg.quote_denom.clone(),
        })?,
        funds: vec![],
    });
    Ok(Response::new()
        .add_message(msg)
        .add_attribute("action", "harvest")
        .add_attribute("yield", yield_amount))
}

/// ADMIN-ONLY escape hatch (Fix 1): overwrite the `DEPLOYED` principal counter.
/// Moves no funds — it only corrects accounting when a sink relationship has
/// been severed or reports a permanent loss and no `Rebalance`/`Harvest` path
/// can reach the truth (e.g. the sink contract is gone and cannot be queried).
/// After reconciling to `0` the sink can be cleared/repointed via UpdateConfig.
fn reconcile_deployed(
    deps: DepsMut,
    info: MessageInfo,
    amount: Uint128,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    let old = DEPLOYED.may_load(deps.storage)?.unwrap_or_default();
    DEPLOYED.save(deps.storage, &amount)?;
    Ok(Response::new()
        .add_attribute("action", "reconcile_deployed")
        .add_attribute("old_deployed", old)
        .add_attribute("new_deployed", amount))
}

#[allow(clippy::too_many_arguments)]
fn update_config(
    deps: DepsMut,
    info: MessageInfo,
    admin: Option<String>,
    amm: Option<String>,
    reserve_ratio_bps: Option<u16>,
    yield_sink: Option<Option<String>>,
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
    if let Some(r) = reserve_ratio_bps {
        validate_ratio(r)?;
        cfg.reserve_ratio_bps = r;
    }
    if let Some(s) = yield_sink {
        let new_sink = match s {
            Some(addr) => Some(deps.api.addr_validate(&addr)?),
            None => None,
        };
        // Fix 1: clearing or repointing the sink while principal is still out
        // there would strand it with no recovery path and no way to reconcile
        // the counter. Force a full withdraw-to-zero (Rebalance) or an explicit
        // ReconcileDeployed first. A no-op "change" to the same address is fine.
        if new_sink != cfg.yield_sink {
            let deployed = DEPLOYED.may_load(deps.storage)?.unwrap_or_default();
            if !deployed.is_zero() {
                return Err(ContractError::SinkChangeWhileDeployed {});
            }
        }
        cfg.yield_sink = new_sink;
    }
    CONFIG.save(deps.storage, &cfg)?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

// ── queries ─────────────────────────────────────────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::Treasury {} => {
            let cfg = CONFIG.load(deps.storage)?;
            let held = deps
                .querier
                .query_balance(&env.contract.address, &cfg.quote_denom)?
                .amount;
            let deployed = DEPLOYED.may_load(deps.storage)?.unwrap_or_default();
            to_binary(&TreasuryResponse {
                held,
                deployed,
                total: held + deployed,
                banked_total: BANKED.may_load(deps.storage)?.unwrap_or_default(),
                harvested_total: HARVESTED.may_load(deps.storage)?.unwrap_or_default(),
                reserve_ratio_bps: cfg.reserve_ratio_bps,
                yield_sink: cfg.yield_sink,
            })
        }
    }
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{
        mock_dependencies, mock_dependencies_with_balance, mock_env, mock_info, MockApi,
        MockQuerier,
    };
    use cosmwasm_std::{coins, from_binary, ContractResult, MemoryStorage, OwnedDeps, SystemResult, WasmQuery};

    const DENOM: &str = "uchanse";

    type TestDeps = OwnedDeps<MemoryStorage, MockApi, MockQuerier>;

    /// Wire a mocked yield sink: the contract physically holds `contract_bal` of
    /// the quote denom, and the sink answers every `Balance` query with
    /// `sink_reports` (`None` = the sink refuses/errors the query, e.g. it is
    /// gone or reverting). Withdraw/Deposit execute messages are emitted but, as
    /// in any unit test, not run — so a "refuse-withdraw" sink is modelled by the
    /// balance query erroring, which is the only sink response this code reads.
    fn mock_sink_deps(contract_bal: u128, sink_reports: Option<u128>) -> TestDeps {
        let mut deps = mock_dependencies_with_balance(&coins(contract_bal, DENOM));
        deps.querier.update_wasm(move |q| match q {
            WasmQuery::Smart { .. } => match sink_reports {
                Some(b) => SystemResult::Ok(ContractResult::Ok(
                    to_binary(&SinkBalanceResponse {
                        balance: Uint128::new(b),
                    })
                    .unwrap(),
                )),
                None => SystemResult::Ok(ContractResult::Err("sink refuses".into())),
            },
            _ => SystemResult::Ok(ContractResult::Err("unexpected".into())),
        });
        deps
    }

    /// Advance to a mock env well past the rebalance interval so the throttle
    /// (Fix 4) never trips on a first call, and force `LAST_REBALANCE` for
    /// throttle-specific tests via the returned env's time.
    fn env_at(secs: u64) -> Env {
        let mut env = mock_env();
        env.block.time = cosmwasm_std::Timestamp::from_seconds(secs);
        env
    }

    fn init(deps: DepsMut, ratio: u16, sink: Option<&str>) {
        let msg = InstantiateMsg {
            admin: "admin".into(),
            amm: "amm".into(),
            quote_denom: DENOM.into(),
            yield_sink: sink.map(|s| s.to_string()),
            reserve_ratio_bps: ratio,
        };
        instantiate(deps, mock_env(), mock_info("creator", &[]), msg).unwrap();
    }

    // ── pure reserve accounting ──────────────────────────────────────────────

    #[test]
    fn plan_deploys_the_non_reserve_portion() {
        // 1000 held, nothing deployed, keep 20% => deploy 800.
        assert_eq!(
            plan_rebalance(Uint128::new(1000), Uint128::zero(), 2000),
            RebalanceAction::Deposit(Uint128::new(800))
        );
    }

    #[test]
    fn plan_withdraws_when_over_deployed() {
        // total 1000, 900 deployed, keep 50% => target deployed 500 => pull 400.
        assert_eq!(
            plan_rebalance(Uint128::new(100), Uint128::new(900), 5000),
            RebalanceAction::Withdraw(Uint128::new(400))
        );
    }

    #[test]
    fn plan_is_noop_when_balanced() {
        // total 1000, keep 30% => target held 300, deployed 700 — already there.
        assert_eq!(
            plan_rebalance(Uint128::new(300), Uint128::new(700), 3000),
            RebalanceAction::None
        );
    }

    #[test]
    fn plan_hold_everything_never_deploys() {
        assert_eq!(
            plan_rebalance(Uint128::new(1000), Uint128::zero(), 10_000),
            RebalanceAction::None
        );
    }

    #[test]
    fn plan_deploy_everything_leaves_no_reserve() {
        assert_eq!(
            plan_rebalance(Uint128::new(1000), Uint128::zero(), 0),
            RebalanceAction::Deposit(Uint128::new(1000))
        );
    }

    #[test]
    fn plan_deposit_never_exceeds_held() {
        // Odd split where the arithmetic target could tempt over-depositing; the
        // deposit is still bounded by what we physically hold (here == want).
        let action = plan_rebalance(Uint128::new(333), Uint128::new(0), 0);
        match action {
            RebalanceAction::Deposit(a) => assert!(a <= Uint128::new(333)),
            _ => panic!("expected deposit"),
        }
    }

    #[test]
    fn plan_rounds_toward_deploying() {
        // total 3, keep 50% => target reserve floor(1.5)=1, deploy 2.
        assert_eq!(
            plan_rebalance(Uint128::new(3), Uint128::zero(), 5000),
            RebalanceAction::Deposit(Uint128::new(2))
        );
    }

    // ── after_swap banking ───────────────────────────────────────────────────

    #[test]
    fn after_swap_banks_attached_skim() {
        let mut deps = mock_dependencies();
        init(deps.as_mut(), 2000, None);
        let msg = ExecuteMsg::AfterSwap {
            token_address: "tok".into(),
            sender: "trader".into(),
            offer_ansem: true,
            input_amount: Uint128::new(1_000),
            output_amount: Uint128::new(990),
            fee_amount: Uint128::new(10),
        };
        let res = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("amm", &coins(10, DENOM)),
            msg,
        )
        .unwrap();
        assert_eq!(res.attributes.iter().find(|a| a.key == "banked").unwrap().value, "10");

        let bin = query(deps.as_ref(), mock_env(), QueryMsg::Treasury {}).unwrap();
        let t: TreasuryResponse = from_binary(&bin).unwrap();
        assert_eq!(t.banked_total, Uint128::new(10));
    }

    #[test]
    fn after_swap_rejects_non_amm() {
        let mut deps = mock_dependencies();
        init(deps.as_mut(), 2000, None);
        let msg = ExecuteMsg::AfterSwap {
            token_address: "tok".into(),
            sender: "trader".into(),
            offer_ansem: true,
            input_amount: Uint128::new(1),
            output_amount: Uint128::new(1),
            fee_amount: Uint128::new(0),
        };
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("not_amm", &coins(10, DENOM)),
            msg,
        )
        .unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
    }

    #[test]
    fn after_swap_is_noop_safe_on_empty_funds() {
        let mut deps = mock_dependencies();
        init(deps.as_mut(), 2000, None);
        let msg = ExecuteMsg::AfterSwap {
            token_address: "tok".into(),
            sender: "trader".into(),
            offer_ansem: false,
            input_amount: Uint128::new(1),
            output_amount: Uint128::new(1),
            fee_amount: Uint128::zero(),
        };
        // No attached funds: must not error, banked stays zero.
        let res = execute(deps.as_mut(), mock_env(), mock_info("amm", &[]), msg).unwrap();
        assert_eq!(res.attributes.iter().find(|a| a.key == "banked").unwrap().value, "0");
        let bin = query(deps.as_ref(), mock_env(), QueryMsg::Treasury {}).unwrap();
        let t: TreasuryResponse = from_binary(&bin).unwrap();
        assert_eq!(t.banked_total, Uint128::zero());
    }

    // ── rebalance / harvest gating ───────────────────────────────────────────

    #[test]
    fn rebalance_without_sink_errors() {
        let mut deps = mock_dependencies_with_balance(&coins(1_000, DENOM));
        init(deps.as_mut(), 2000, None);
        let err = execute(deps.as_mut(), mock_env(), mock_info("keeper", &[]), ExecuteMsg::Rebalance {})
            .unwrap_err();
        assert_eq!(err, ContractError::NoSink {});
    }

    #[test]
    fn rebalance_emits_deposit_to_sink() {
        // Held 1000, keep 20% => deploy 800 to the sink. Sink starts empty (0),
        // deployed starts 0, so the downward clamp is a no-op here.
        let mut deps = mock_sink_deps(1_000, Some(0));
        init(deps.as_mut(), 2000, Some("sink"));
        let res = execute(deps.as_mut(), mock_env(), mock_info("keeper", &[]), ExecuteMsg::Rebalance {})
            .unwrap();
        assert_eq!(res.messages.len(), 1);
        // Deployed principal was credited optimistically.
        let bin = query(deps.as_ref(), mock_env(), QueryMsg::Treasury {}).unwrap();
        let t: TreasuryResponse = from_binary(&bin).unwrap();
        assert_eq!(t.deployed, Uint128::new(800));
    }

    #[test]
    fn harvest_without_sink_errors() {
        let mut deps = mock_dependencies();
        init(deps.as_mut(), 2000, None);
        let err = execute(deps.as_mut(), mock_env(), mock_info("keeper", &[]), ExecuteMsg::Harvest {})
            .unwrap_err();
        assert_eq!(err, ContractError::NoSink {});
    }

    // ── config ───────────────────────────────────────────────────────────────

    #[test]
    fn bad_ratio_rejected_at_instantiate() {
        let mut deps = mock_dependencies();
        let msg = InstantiateMsg {
            admin: "admin".into(),
            amm: "amm".into(),
            quote_denom: DENOM.into(),
            yield_sink: None,
            reserve_ratio_bps: 10_001,
        };
        let err = instantiate(deps.as_mut(), mock_env(), mock_info("c", &[]), msg).unwrap_err();
        assert_eq!(err, ContractError::BadRatio {});
    }

    #[test]
    fn admin_can_set_and_clear_sink_and_ratio() {
        let mut deps = mock_dependencies();
        init(deps.as_mut(), 2000, None);
        // set sink + ratio
        execute(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            ExecuteMsg::UpdateConfig {
                admin: None,
                amm: None,
                reserve_ratio_bps: Some(5000),
                yield_sink: Some(Some("sink".into())),
            },
        )
        .unwrap();
        let cfg: Config =
            from_binary(&query(deps.as_ref(), mock_env(), QueryMsg::Config {}).unwrap()).unwrap();
        assert_eq!(cfg.reserve_ratio_bps, 5000);
        assert_eq!(cfg.yield_sink, Some(Addr::unchecked("sink")));
        // clear sink
        execute(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            ExecuteMsg::UpdateConfig {
                admin: None,
                amm: None,
                reserve_ratio_bps: None,
                yield_sink: Some(None),
            },
        )
        .unwrap();
        let cfg: Config =
            from_binary(&query(deps.as_ref(), mock_env(), QueryMsg::Config {}).unwrap()).unwrap();
        assert_eq!(cfg.yield_sink, None);
    }

    #[test]
    fn non_admin_cannot_update_config() {
        let mut deps = mock_dependencies();
        init(deps.as_mut(), 2000, None);
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("intruder", &[]),
            ExecuteMsg::UpdateConfig {
                admin: None,
                amm: None,
                reserve_ratio_bps: Some(1),
                yield_sink: None,
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
    }

    // ── Fix 2: reserve-ratio floor ───────────────────────────────────────────

    #[test]
    fn ratio_below_floor_rejected_at_instantiate() {
        let mut deps = mock_dependencies();
        let msg = InstantiateMsg {
            admin: "admin".into(),
            amm: "amm".into(),
            quote_denom: DENOM.into(),
            yield_sink: None,
            reserve_ratio_bps: MIN_RESERVE_RATIO_BPS - 1,
        };
        let err = instantiate(deps.as_mut(), mock_env(), mock_info("c", &[]), msg).unwrap_err();
        assert_eq!(
            err,
            ContractError::ReserveTooLow {
                min: MIN_RESERVE_RATIO_BPS
            }
        );
    }

    #[test]
    fn ratio_below_floor_rejected_in_update_config() {
        let mut deps = mock_dependencies();
        init(deps.as_mut(), 2000, None);
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            ExecuteMsg::UpdateConfig {
                admin: None,
                amm: None,
                reserve_ratio_bps: Some(0),
                yield_sink: None,
            },
        )
        .unwrap_err();
        assert_eq!(
            err,
            ContractError::ReserveTooLow {
                min: MIN_RESERVE_RATIO_BPS
            }
        );
    }

    // ── Fix 1: no sink change while principal is deployed ─────────────────────

    #[test]
    fn cannot_clear_or_repoint_sink_while_deployed() {
        let mut deps = mock_dependencies();
        init(deps.as_mut(), 2000, Some("sink"));
        DEPLOYED
            .save(deps.as_mut().storage, &Uint128::new(100))
            .unwrap();

        // clearing is blocked
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            ExecuteMsg::UpdateConfig {
                admin: None,
                amm: None,
                reserve_ratio_bps: None,
                yield_sink: Some(None),
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::SinkChangeWhileDeployed {});

        // repointing to a different sink is blocked
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            ExecuteMsg::UpdateConfig {
                admin: None,
                amm: None,
                reserve_ratio_bps: None,
                yield_sink: Some(Some("sink2".into())),
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::SinkChangeWhileDeployed {});

        // a no-op "change" to the SAME address is allowed (nothing severed)
        execute(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            ExecuteMsg::UpdateConfig {
                admin: None,
                amm: None,
                reserve_ratio_bps: None,
                yield_sink: Some(Some("sink".into())),
            },
        )
        .unwrap();
    }

    // ── Fix 1: ReconcileDeployed escape hatch ────────────────────────────────

    #[test]
    fn reconcile_deployed_admin_only_and_unblocks_sink_change() {
        let mut deps = mock_dependencies();
        init(deps.as_mut(), 2000, Some("sink"));
        DEPLOYED
            .save(deps.as_mut().storage, &Uint128::new(800))
            .unwrap();

        // non-admin cannot reconcile
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("intruder", &[]),
            ExecuteMsg::ReconcileDeployed {
                amount: Uint128::zero(),
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});

        // admin reconciles the severed counter back to zero
        let res = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            ExecuteMsg::ReconcileDeployed {
                amount: Uint128::zero(),
            },
        )
        .unwrap();
        assert_eq!(
            res.attributes.iter().find(|a| a.key == "old_deployed").unwrap().value,
            "800"
        );
        let t: TreasuryResponse =
            from_binary(&query(deps.as_ref(), mock_env(), QueryMsg::Treasury {}).unwrap()).unwrap();
        assert_eq!(t.deployed, Uint128::zero());

        // with principal reconciled to zero, clearing the sink now succeeds
        execute(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            ExecuteMsg::UpdateConfig {
                admin: None,
                amm: None,
                reserve_ratio_bps: None,
                yield_sink: Some(None),
            },
        )
        .unwrap();
        let cfg: Config =
            from_binary(&query(deps.as_ref(), mock_env(), QueryMsg::Config {}).unwrap()).unwrap();
        assert_eq!(cfg.yield_sink, None);
    }

    // ── Fix 3: Harvest against a mocked sink ─────────────────────────────────

    #[test]
    fn harvest_inflated_balance_pulls_only_the_yield() {
        // Sink reports 900, we deployed 800 => 100 is realisable yield.
        let mut deps = mock_sink_deps(0, Some(900));
        init(deps.as_mut(), 2000, Some("sink"));
        DEPLOYED
            .save(deps.as_mut().storage, &Uint128::new(800))
            .unwrap();

        let res = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("keeper", &[]),
            ExecuteMsg::Harvest {},
        )
        .unwrap();
        assert_eq!(res.messages.len(), 1, "one withdraw message for the yield");
        assert_eq!(
            res.attributes.iter().find(|a| a.key == "yield").unwrap().value,
            "100"
        );
        let t: TreasuryResponse =
            from_binary(&query(deps.as_ref(), mock_env(), QueryMsg::Treasury {}).unwrap()).unwrap();
        assert_eq!(t.deployed, Uint128::new(800), "principal stays at work");
        assert_eq!(t.harvested_total, Uint128::new(100));
    }

    #[test]
    fn harvest_deflated_balance_clamps_deployed_down() {
        // Sink took a loss: reports 500, we recorded 800. No yield; the counter
        // must be repaired DOWN to 500 and PERSISTED (Ok, not rolled back).
        let mut deps = mock_sink_deps(0, Some(500));
        init(deps.as_mut(), 2000, Some("sink"));
        DEPLOYED
            .save(deps.as_mut().storage, &Uint128::new(800))
            .unwrap();

        let res = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("keeper", &[]),
            ExecuteMsg::Harvest {},
        )
        .unwrap();
        assert_eq!(res.messages.len(), 0, "nothing to withdraw on a loss");
        assert_eq!(
            res.attributes
                .iter()
                .find(|a| a.key == "reconciled_deployed_to")
                .unwrap()
                .value,
            "500"
        );
        let t: TreasuryResponse =
            from_binary(&query(deps.as_ref(), mock_env(), QueryMsg::Treasury {}).unwrap()).unwrap();
        assert_eq!(t.deployed, Uint128::new(500), "view repaired to the truth");
    }

    #[test]
    fn harvest_equal_balance_is_noop() {
        let mut deps = mock_sink_deps(0, Some(800));
        init(deps.as_mut(), 2000, Some("sink"));
        DEPLOYED
            .save(deps.as_mut().storage, &Uint128::new(800))
            .unwrap();
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("keeper", &[]),
            ExecuteMsg::Harvest {},
        )
        .unwrap_err();
        assert_eq!(err, ContractError::Noop {});
    }

    #[test]
    fn harvest_against_refusing_sink_errors_gracefully() {
        // Sink refuses the Balance query (gone / reverting): harvest surfaces the
        // error rather than corrupting state.
        let mut deps = mock_sink_deps(0, None);
        init(deps.as_mut(), 2000, Some("sink"));
        DEPLOYED
            .save(deps.as_mut().storage, &Uint128::new(800))
            .unwrap();
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("keeper", &[]),
            ExecuteMsg::Harvest {},
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Std(_)));
    }

    // ── Fix 3: Rebalance downward clamp prevents a bricked withdraw ───────────

    #[test]
    fn rebalance_clamps_deployed_down_and_does_not_over_withdraw() {
        // Recorded 800 deployed, but the sink only holds 500 (a loss). Held 100.
        // After clamping to 500: total 600, keep 20% => target deployed 480, so
        // withdraw only 20 — well within the sink's real 500, so no brick.
        let mut deps = mock_sink_deps(100, Some(500));
        init(deps.as_mut(), 2000, Some("sink"));
        DEPLOYED
            .save(deps.as_mut().storage, &Uint128::new(800))
            .unwrap();

        let res = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("keeper", &[]),
            ExecuteMsg::Rebalance {},
        )
        .unwrap();
        assert_eq!(res.messages.len(), 1);
        assert_eq!(
            res.attributes.iter().find(|a| a.key == "withdraw").unwrap().value,
            "20"
        );
        let t: TreasuryResponse =
            from_binary(&query(deps.as_ref(), mock_env(), QueryMsg::Treasury {}).unwrap()).unwrap();
        // clamped 800 -> 500, then withdrew 20 -> 480.
        assert_eq!(t.deployed, Uint128::new(480));
    }

    #[test]
    fn rebalance_against_refusing_sink_errors_gracefully() {
        let mut deps = mock_sink_deps(1_000, None);
        init(deps.as_mut(), 2000, Some("sink"));
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("keeper", &[]),
            ExecuteMsg::Rebalance {},
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Std(_)));
    }

    // ── Fix 4: rebalance spam throttle ───────────────────────────────────────

    #[test]
    fn rebalance_is_throttled_by_min_interval() {
        let mut deps = mock_sink_deps(1_000, Some(0));
        init(deps.as_mut(), 2000, Some("sink"));

        // First call at t=10_000 succeeds and stamps LAST_REBALANCE.
        execute(
            deps.as_mut(),
            env_at(10_000),
            mock_info("keeper", &[]),
            ExecuteMsg::Rebalance {},
        )
        .unwrap();

        // A second call moments later is rejected.
        let err = execute(
            deps.as_mut(),
            env_at(10_000 + MIN_REBALANCE_INTERVAL_SECS - 1),
            mock_info("attacker", &[]),
            ExecuteMsg::Rebalance {},
        )
        .unwrap_err();
        assert_eq!(
            err,
            ContractError::RebalanceTooSoon {
                min_secs: MIN_REBALANCE_INTERVAL_SECS
            }
        );

        // Past the interval it is allowed again (deployed is already 800 and the
        // sink reports 0, so it clamps back down and reconciles — still Ok).
        let res = execute(
            deps.as_mut(),
            env_at(10_000 + MIN_REBALANCE_INTERVAL_SECS + 1),
            mock_info("keeper", &[]),
            ExecuteMsg::Rebalance {},
        )
        .unwrap();
        assert_eq!(
            res.attributes.iter().find(|a| a.key == "action").unwrap().value,
            "rebalance"
        );
    }
}
