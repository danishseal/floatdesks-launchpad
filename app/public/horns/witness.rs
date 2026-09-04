//! Witness Horn — a `before_swap` pricing Horn that surcharges the swaps that
//! look like an *atomic arbitrage leg*, and pays the surcharge to the pool.
//!
//! # What the Solana original does, and why we cannot
//!
//! This is a port of Vector's `witness-vector`. That program prices a swap by
//! *what else is in its transaction*: it reads Solana's instructions sysvar,
//! enumerates the sibling top-level instructions of the very transaction it is
//! running inside, and charges more when it sees the transaction also touches a
//! named venue (Raydium/Meteora — the other leg of a route) or swaps this pool
//! more than once. The surcharge is expressed purely as an LP-fee override, so
//! it accrues to the pool's liquidity providers, never to the program. The
//! Vector docs are blunt that "this one has no Uniswap equivalent, because an
//! EVM hook cannot enumerate its transaction".
//!
//! **A CosmWasm hook cannot enumerate its transaction either, and the gap is
//! wider than v4's.** `before_swap` here is a *query* (see `amm::hooks`):
//! synchronous, read-only, and handed a `SwapContext` that describes only *this*
//! swap. There is no sysvar, no instruction list, no way from inside a query to
//! ask "what other messages are in the transaction that dispatched me". So the
//! primary signal the original leans on — top-level tx-introspection ("this
//! transaction also calls Raydium in the same breath") — is simply not
//! observable here. We cannot port it, and pretending otherwise would be a lie
//! in code.
//!
//! # The closest feasible approximation
//!
//! What we *can* observe is Vector's SECOND, weaker-but-unevadable signal, moved
//! from Solana's per-slot counter to a CometBFT per-block counter:
//!
//!   > the second and later swaps on a pool within one block are exactly the
//!   > signature of a sandwich, a backrun, or a same-block arbitrage.
//!
//! Atomic arbitrage has to be atomic to be riskless. On this chain that means
//! the legs land in the SAME BLOCK. A CosmWasm contract cannot see the sibling
//! messages of its own transaction, but across a `before_swap` query and an
//! `after_swap` execute it CAN accumulate state that persists between messages
//! in the same block, because `env.block.height` is stable for every message in
//! a block and committed writes from an earlier message in the block are visible
//! to a later one.
//!
//! So the mechanism is:
//!
//!   * `after_swap` (execute) records `(token_address, sender) -> {block, count}`,
//!     bumping `count` when the stored block equals the current block and
//!     resetting to 1 on a new block.
//!   * `before_swap` (query) reads that record. If the SAME sender has ALREADY
//!     swapped THIS pool at THIS block height (count > 0 for this block), the
//!     swap in front of us is a follow-up leg of a same-block bundle: we return
//!     `OverrideFee { surcharge_fee_bps }`. Otherwise we return
//!     `OverrideFee { base_fee_bps }`.
//!
//! The surcharge is an `OverrideFee`, exactly like the original's `lp_fee_override`
//! and like `horn-dynfee`. It raises the pool's own fee for that one swap; that
//! fee accrues to the pool / LPs through the AMM's normal fee routing. **This
//! Horn never takes custody of anything** — `after_swap` records state and takes
//! no funds, and there is no `Delta` and no treasury. The surcharge stays with
//! the pool, not the Horn.
//!
//! # What this approximation CANNOT catch (stated, not buried)
//!
//! The original's headline capability is gone and a few honest limits come with
//! the substitute:
//!
//!   1. **No cross-venue detection.** A single swap here that is one leg of an
//!      arb also hitting an external DEX in the same tx is invisible: we never
//!      see that sibling message. The original's `routed_fee` tier has no port.
//!      We only catch arbitrage/sandwiches that touch THIS pool at least twice
//!      in the block.
//!   2. **First leg always pays base.** The surcharge lands on the second and
//!      later swap of a (sender, pool, block) triple, because the first one is
//!      what creates the record. A single-swap-per-block strategy pays base.
//!   3. **Per-sender, so trivially sybil-evadable.** We key on `ctx.sender`. A
//!      searcher who splits the legs across two addresses in the same block
//!      shows up as two distinct first-swaps and dodges the surcharge. The
//!      original's slot counter was per-POOL and caught this; we cannot safely
//!      be per-pool, because a per-pool block counter would surcharge every
//!      ordinary trader who merely happens to land in a block after an
//!      arbitrageur — punishing bystanders. Per-sender overcharges nobody
//!      innocent at the cost of being evadable. That is the same "two ways to be
//!      wrong" trade the original documents, resolved toward never overcharging
//!      an honest trader, because a fee guessed high on a bystander is a real
//!      harm here where the original could lean on the unevadable per-pool slot
//!      count. (If a pool would rather catch more arbitrage at the cost of
//!      occasionally taxing an innocent same-block follower, that is a different
//!      Horn; this one does not make that trade.)
//!   4. **Split across blocks defeats it, on purpose.** Same as the original:
//!      splitting the legs across blocks dodges the surcharge and turns the
//!      arbitrageur into someone carrying inventory risk between blocks, which is
//!      a different, non-riskless job. That is a feature.
//!
//! # Robustness
//!
//! `before_swap` is a query and can never revert a swap on its own; a failed
//! state read defaults to the base fee rather than erroring. `after_swap`'s
//! failure WOULD revert the whole swap (see `amm::hooks::after_swap`), so it
//! must never fail on a routine swap: the only way it errors is a non-AMM
//! caller, which never happens on the swap path. It expects no funds (a witness
//! pool should not skim to this Horn); any funds that do arrive are simply left
//! in the contract balance rather than causing a revert.
//!
//! Config: `admin`, `base_fee_bps`, `surcharge_fee_bps`. The AMM caps any hook
//! fee at 1000 bps; we validate the same at config time so a swap is never
//! rejected for an over-cap fee mid-trade, and we require `surcharge >= base`
//! because a surcharge below the base tier could never actually raise a fee and
//! would sit there looking configured while doing nothing.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_binary, Addr, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult,
    Uint128,
};
use cw_storage_plus::{Item, Map};
use thiserror::Error;

const MAX_HOOK_FEE_BPS: u16 = 1000; // must match amm::hooks::MAX_HOOK_FEE_BPS

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("fee bps must be <= {MAX_HOOK_FEE_BPS}")]
    FeeTooHigh {},
    #[error("surcharge fee must be >= base fee, or it can never apply")]
    SurchargeBelowBase {},
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
    /// The AMM — the only address allowed to call `after_swap`. Without this
    /// gate anyone could record a swap under a VICTIM's address for the current
    /// block and make the victim's next honest swap in that block pay the
    /// surcharge. The record is only trustworthy if the AMM writes it.
    pub amm: Addr,
    /// Fee for an ordinary swap: the first swap a sender makes on a pool in a
    /// block, and every single-swap-per-block trader.
    pub base_fee_bps: u16,
    /// Fee for a follow-up swap: the same sender's second and later swap on the
    /// same pool within one block — the signature of an atomic bundle leg.
    pub surcharge_fee_bps: u16,
}

/// Per (pool, sender) last-seen swap: the block it happened in and how many
/// swaps that sender made on that pool in that block. Overwritten in place per
/// pair, so the map holds at most one entry per distinct (pool, sender) — it is
/// bounded by unique traders, not by blocks.
#[cw_serde]
#[derive(Default)]
pub struct SwapRecord {
    pub block_height: u64,
    pub count: u32,
}

const CONFIG: Item<Config> = Item::new("config");
/// Key: (token_address, sender).
const SWAPS: Map<(&str, &str), SwapRecord> = Map::new("swaps");

// ── messages ────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub amm: String,
    pub base_fee_bps: u16,
    pub surcharge_fee_bps: u16,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// AMM callback — MUST match the AMM's `HookExecute::AfterSwap` shape. We use
    /// only `token_address` (the pool) and `sender`; the rest is ignored. No
    /// funds are expected.
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
        base_fee_bps: Option<u16>,
        surcharge_fee_bps: Option<u16>,
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
    /// Inspect the recorded activity for a (pool, sender) pair.
    #[returns(SwapRecord)]
    Activity {
        token_address: String,
        sender: String,
    },
}

// ── entry points ────────────────────────────────────────────────────────────

fn check_fees(base: u16, surcharge: u16) -> Result<(), ContractError> {
    if base > MAX_HOOK_FEE_BPS || surcharge > MAX_HOOK_FEE_BPS {
        return Err(ContractError::FeeTooHigh {});
    }
    if surcharge < base {
        return Err(ContractError::SurchargeBelowBase {});
    }
    Ok(())
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    cw2::set_contract_version(deps.storage, "ansem-horn-witness", env!("CARGO_PKG_VERSION"))?;
    check_fees(msg.base_fee_bps, msg.surcharge_fee_bps)?;
    CONFIG.save(
        deps.storage,
        &Config {
            admin: deps.api.addr_validate(&msg.admin)?,
            amm: deps.api.addr_validate(&msg.amm)?,
            base_fee_bps: msg.base_fee_bps,
            surcharge_fee_bps: msg.surcharge_fee_bps,
        },
    )?;
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
        ExecuteMsg::AfterSwap {
            token_address,
            sender,
            ..
        } => after_swap(deps, env, info, token_address, sender),
        ExecuteMsg::UpdateConfig {
            admin,
            base_fee_bps,
            surcharge_fee_bps,
        } => update_config(deps, info, admin, base_fee_bps, surcharge_fee_bps),
    }
}

/// Record that `sender` swapped `token_address` in this block. Bumps the count
/// when the stored record is for the current block; resets to 1 on a new block
/// (a stale record belongs to a block that is over and is not carried forward).
///
/// Only the AMM may call this. That gate is what makes the record trustworthy:
/// otherwise anyone could pre-write a victim's address for the current block and
/// tax the victim's next swap.
fn after_swap(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    token_address: String,
    sender: String,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.amm {
        return Err(ContractError::Unauthorized {});
    }
    let here = env.block.height;
    let key = (token_address.as_str(), sender.as_str());
    let rec = SWAPS.may_load(deps.storage, key)?.unwrap_or_default();
    let next = if rec.block_height == here {
        SwapRecord {
            block_height: here,
            count: rec.count.saturating_add(1),
        }
    } else {
        SwapRecord {
            block_height: here,
            count: 1,
        }
    };
    SWAPS.save(deps.storage, key, &next)?;
    Ok(Response::new()
        .add_attribute("action", "after_swap")
        .add_attribute("token_address", token_address)
        .add_attribute("sender", sender)
        .add_attribute("block", here.to_string())
        .add_attribute("count", next.count.to_string()))
}

fn update_config(
    deps: DepsMut,
    info: MessageInfo,
    admin: Option<String>,
    base_fee_bps: Option<u16>,
    surcharge_fee_bps: Option<u16>,
) -> Result<Response, ContractError> {
    let mut cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    if let Some(a) = admin {
        cfg.admin = deps.api.addr_validate(&a)?;
    }
    if let Some(b) = base_fee_bps {
        cfg.base_fee_bps = b;
    }
    if let Some(s) = surcharge_fee_bps {
        cfg.surcharge_fee_bps = s;
    }
    check_fees(cfg.base_fee_bps, cfg.surcharge_fee_bps)?;
    CONFIG.save(deps.storage, &cfg)?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::BeforeSwap { ctx } => to_binary(&decide(deps, env, ctx)),
        QueryMsg::Config {} => to_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::Activity {
            token_address,
            sender,
        } => to_binary(
            &SWAPS
                .may_load(deps.storage, (&token_address, &sender))?
                .unwrap_or_default(),
        ),
    }
}

/// The pricing decision. Surcharge if the same sender has ALREADY swapped this
/// pool at this block height (a follow-up leg of a same-block bundle); base fee
/// otherwise. A failed config/state read defaults to `Proceed` / base rather
/// than erroring, because a query must never make a swap revert.
fn decide(deps: Deps, env: Env, ctx: SwapContext) -> HookDecision {
    let cfg = match CONFIG.load(deps.storage) {
        Ok(c) => c,
        Err(_) => return HookDecision::Proceed,
    };
    let follow_up = SWAPS
        .may_load(deps.storage, (&ctx.token_address, &ctx.sender))
        .ok()
        .flatten()
        .map(|r| r.block_height == env.block.height && r.count > 0)
        .unwrap_or(false);
    let fee_bps = if follow_up {
        cfg.surcharge_fee_bps
    } else {
        cfg.base_fee_bps
    };
    HookDecision::OverrideFee { fee_bps }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};

    const AMM: &str = "amm";
    const POOL: &str = "pooltoken";

    fn setup(deps: DepsMut, base: u16, surcharge: u16) {
        instantiate(
            deps,
            mock_env(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                amm: AMM.into(),
                base_fee_bps: base,
                surcharge_fee_bps: surcharge,
            },
        )
        .unwrap();
    }

    fn ctx_for(sender: &str) -> SwapContext {
        SwapContext {
            token_address: POOL.into(),
            sender: sender.into(),
            offer_ansem: true,
            input_amount: Uint128::new(1_000),
            ansem_reserve: Uint128::new(1_000_000),
            token_reserve: Uint128::new(1_000_000),
            default_fee_bps: 30,
        }
    }

    fn record_swap(deps: DepsMut, env: &Env, caller: &str, sender: &str) -> Result<Response, ContractError> {
        after_swap(deps, env.clone(), mock_info(caller, &[]), POOL.into(), sender.into())
    }

    #[test]
    fn config_rejects_over_cap_fee() {
        let mut deps = mock_dependencies();
        let err = instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                amm: AMM.into(),
                base_fee_bps: 100,
                surcharge_fee_bps: 2000, // > 1000 cap
            },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::FeeTooHigh {}));
    }

    #[test]
    fn config_rejects_surcharge_below_base() {
        let mut deps = mock_dependencies();
        let err = instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                amm: AMM.into(),
                base_fee_bps: 100,
                surcharge_fee_bps: 50, // below base can never apply
            },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::SurchargeBelowBase {}));
    }

    #[test]
    fn first_swap_of_a_block_gets_base() {
        // No record yet -> base fee.
        let mut deps = mock_dependencies();
        setup(deps.as_mut(), 30, 300);
        assert_eq!(
            decide(deps.as_ref(), mock_env(), ctx_for("trader")),
            HookDecision::OverrideFee { fee_bps: 30 }
        );
    }

    #[test]
    fn second_swap_same_block_is_surcharged() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut(), 30, 300);
        let env = mock_env();

        // First leg lands: base fee, then AMM records it.
        assert_eq!(
            decide(deps.as_ref(), env.clone(), ctx_for("trader")),
            HookDecision::OverrideFee { fee_bps: 30 }
        );
        record_swap(deps.as_mut(), &env, AMM, "trader").unwrap();

        // Second leg, same sender, same block -> surcharge.
        assert_eq!(
            decide(deps.as_ref(), env.clone(), ctx_for("trader")),
            HookDecision::OverrideFee { fee_bps: 300 }
        );

        // A DIFFERENT sender in the same block is still a first leg -> base.
        assert_eq!(
            decide(deps.as_ref(), env, ctx_for("other")),
            HookDecision::OverrideFee { fee_bps: 30 }
        );
    }

    #[test]
    fn new_block_resets_to_base() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut(), 30, 300);
        let env = mock_env();

        record_swap(deps.as_mut(), &env, AMM, "trader").unwrap();
        // Same block: surcharge.
        assert_eq!(
            decide(deps.as_ref(), env.clone(), ctx_for("trader")),
            HookDecision::OverrideFee { fee_bps: 300 }
        );

        // Next block: the stale record is not carried forward -> base again.
        let mut later = env.clone();
        later.block.height += 1;
        assert_eq!(
            decide(deps.as_ref(), later.clone(), ctx_for("trader")),
            HookDecision::OverrideFee { fee_bps: 30 }
        );

        // And a swap in the new block resets the counter to 1 (its own follow-up
        // would surcharge, but the first one here is base).
        record_swap(deps.as_mut(), &later, AMM, "trader").unwrap();
        let rec = SWAPS
            .may_load(deps.as_ref().storage, (POOL, "trader"))
            .unwrap()
            .unwrap();
        assert_eq!(rec.count, 1);
        assert_eq!(rec.block_height, later.block.height);
    }

    #[test]
    fn count_climbs_within_a_block() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut(), 30, 300);
        let env = mock_env();
        record_swap(deps.as_mut(), &env, AMM, "trader").unwrap();
        record_swap(deps.as_mut(), &env, AMM, "trader").unwrap();
        record_swap(deps.as_mut(), &env, AMM, "trader").unwrap();
        let rec = SWAPS
            .may_load(deps.as_ref().storage, (POOL, "trader"))
            .unwrap()
            .unwrap();
        assert_eq!(rec.count, 3);
    }

    #[test]
    fn after_swap_rejects_non_amm_caller() {
        // A non-AMM caller must not be able to poison a victim's record.
        let mut deps = mock_dependencies();
        setup(deps.as_mut(), 30, 300);
        let env = mock_env();
        let err = record_swap(deps.as_mut(), &env, "attacker", "victim").unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));
        // Nothing was written, so the victim still prices at base.
        assert_eq!(
            decide(deps.as_ref(), env, ctx_for("victim")),
            HookDecision::OverrideFee { fee_bps: 30 }
        );
    }

    #[test]
    fn unconfigured_defaults_to_proceed() {
        // No CONFIG saved -> decide never panics, returns Proceed.
        let deps = mock_dependencies();
        assert_eq!(
            decide(deps.as_ref(), mock_env(), ctx_for("trader")),
            HookDecision::Proceed
        );
    }
}
