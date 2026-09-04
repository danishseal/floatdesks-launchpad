//! Gauge Horn — a vesting gate that bounds (not eliminates) JIT reward capture,
//! ported to ANSEM.
//!
//! ## What the source does (Vector `gauge-vector`, Super DCA's gauge)
//!
//! On Solana, the gauge streams a reward to a pool's liquidity providers and
//! fixes the one thing that makes every incentive programme leak. Paying for
//! liquidity is unsafe because liquidity can *arrive one instruction before the
//! payment and leave one instruction after it* — just-in-time (JIT) liquidity
//! that takes a share of the reward without ever having borne any risk. The
//! source closes this by refusing to let a position leave before it has stayed:
//! a position younger than `min_stay_slots` cannot be removed, and topping a
//! position up resets its clock. "Reward only liquidity that was actually
//! present."
//!
//! ## The ANSEM adaptation (LP → staker), and why it is different
//!
//! On ANSEM a token *graduates* into a constant-product AMM pool whose LP is
//! **permanently locked** — there are no withdrawable LP positions to reward or
//! to donate into. So the classic "reward the LPs" target does not exist here.
//! The value that Horns capture is instead paid to **Horn Vault stakers**
//! (holders who stake `uansem`/`uchanse`, see `ansem-horn-vault`). The Fee-Share
//! Horn does this the simple way: on every swap the AMM skims a slice of the fee
//! and this-style Horn forwards it straight into the Vault, which splits it
//! pro-rata across whoever is staked *at that instant*.
//!
//! Pro-rata-at-that-instant is exactly the JIT hole, moved from LPs to stakers:
//! an attacker stakes a large amount one transaction before the swap's reward
//! lands, collects a majority pro-rata share, and unstakes one transaction
//! after. The Vault is deliberately age-blind (its `DepositReward` is
//! permissionless and its accounting is a plain MasterChef accumulator), so the
//! anti-JIT property cannot live inside the Vault. This Horn adds it in front.
//!
//! ## Mechanic: a vesting gate in front of the Vault
//!
//! `after_swap` never forwards the skim synchronously. It splits the skim by the
//! pool's ANSEM/CHANSE percentage and parks each side in a per-sink **vesting
//! buffer**, stamped `mature_at = now + min_stake_seconds`. A separate,
//! permissionless `Settle` later deposits into the Vault only the buffered value
//! that has *matured* (its `mature_at` has passed) and only into a sink that
//! currently has stakers; an empty sink's matured value is retained and deposited
//! on a later `Settle`. `Settle` drains matured value **promptly and in bounded
//! slices**: it scans only matured keys (the buffer key is the ordered
//! `mature_at` second, so still-vesting keys are never even loaded) and processes
//! at most `SETTLE_LIMIT` of them per call, oldest first, leaving the rest for the
//! next call. That bound is load-bearing for both properties below.
//!
//! Because a swap's value is withheld from the Vault for a full
//! `min_stake_seconds`, a stake that is present only in the *swap's* block earns
//! nothing from that swap: nothing is paid out in that block. To receive a swap's
//! reward you must be staked when it *settles*, which is at least
//! `min_stake_seconds` after the swap. This is the CosmWasm analogue of the
//! source's "a position younger than the minimum stay cannot leave", but note the
//! honest limitation below: the gate moves the reward-capture window forward by
//! `min_stake_seconds`, it does not eliminate it.
//!
//! Both halves are useless apart, exactly as in the source: a `min_stake_seconds`
//! of zero would settle in the same block as the swap and silently restore the
//! JIT hole, so it is refused at instantiation (`StayTooShort`), and a ceiling
//! (`MAX_STAKE_SECONDS`) stops the gate being configured into a value trap
//! (`StayTooLong`).
//!
//! ## Honest limitation (documented, not hidden)
//!
//! **JIT capture is bounded, not eliminated.** Because payout is a discrete
//! batched `DepositReward` into the age-blind Vault at `Settle` time, the reward
//! accrues to **whoever is staked at settle**, pro-rata — not to whoever held
//! continuously since before the swap. A one-block actor can still
//! `Stake → Settle → Unstake` and take a pro-rata share of whatever matured value
//! that `Settle` releases. The gate does two things about this and neither is a
//! kill:
//!
//! 1. It **delays** any such capture by at least `min_stake_seconds` after the
//!    swap (the value simply is not in the Vault before then), so the trivial
//!    same-block snipe is gone.
//! 2. It **caps a single `Settle`'s batch**: because `Settle` drains at most
//!    `SETTLE_LIMIT` matured keys per call, any one `Settle` deposits at most one
//!    bounded slice into the Vault. Note the honest limit here: this is one slice
//!    **per `Settle` call**, and `Settle` is permissionless, so a single block can
//!    contain many `Settle` txs. A determined single-block actor can therefore
//!    fire several `Settle` calls in the same block and drain multiple slices, not
//!    just one — `SETTLE_LIMIT` bounds the batch, not the per-block total. What it
//!    does still buy is bounded gas per call and steady oldest-first progress: the
//!    empty/thin-sink case, where matured value would otherwise sit un-deposited
//!    until the sink first gains a staker and could then be sniped in one shot, is
//!    instead released in `SETTLE_LIMIT`-sized slices across `Settle` calls.
//!
//!    The real per-staker anti-JIT guarantee is **not** `SETTLE_LIMIT` at all: it
//!    is the Horn Vault's own `min_stake_seconds` cooldown, which forces a staker
//!    to remain staked for that long before any reward is claimable. That
//!    guarantee only holds when the Vault is configured with
//!    `min_stake_seconds > 0`; it **defaults to 0**, and at 0 there is no
//!    per-staker cooldown and a same-settle `Stake → claim → Unstake` is possible.
//!
//! What it does **not** do is distinguish, at settle time, a staker who held
//! since before the swap from one who staked partway through the window and merely
//! happens to be present at `Settle`. A per-staker airtight version (reward
//! strictly the stake continuously present for the whole window) would require the
//! gauge to run its own eligibility-weighted accumulator and hold/pay the funds
//! itself, bypassing the Vault. That was rejected on purpose: it duplicates the
//! Vault's staking ledger and forfeits the "any Horn can just `DepositReward`"
//! composability. The knobs that bound the residual are `min_stake_seconds` (the
//! longer the vest, the more genuine staying a would-be sniper must actually do,
//! at which point it is the behaviour the incentive is paying for) and
//! `SETTLE_LIMIT` (the smaller the slice, the smaller any single snipe).

use std::collections::BTreeMap;

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_binary, Addr, Binary, Coin, CosmosMsg, Deps, DepsMut, Env, MessageInfo, Order,
    Response, StdResult, Uint128, WasmMsg,
};
use cw_storage_plus::{Bound, Item, Map};
use thiserror::Error;

const ANSEM_SINK: &str = "uansem";
const CHANSE_SINK: &str = "uchanse";
const BPS: u128 = 10_000;

/// Refuse a gate that is longer than this. Roughly 30 days. A `min_stake_seconds`
/// that could be set to "forever" is a value trap wearing an incentive
/// programme's clothes — matured value could be locked out of the Vault
/// indefinitely. Mirrors the source's `MAX_STAY_SLOTS` ceiling.
pub const MAX_STAKE_SECONDS: u64 = 2_592_000;

/// The maximum number of matured buffer keys a single `Settle` will drain.
///
/// This bound does double duty. (1) It caps `Settle`'s gas: without it, a flood
/// of one swap per second stamps one matured key per second, and an unbounded
/// `Settle` would eventually load every one of them in a single call and brick on
/// gas — permanently stranding the buffered funds, since nobody could ever afford
/// to settle them. (2) It caps the size of any one batch that lands in the Vault
/// *per call*. Be precise about what that buys: it stops a **single** `Settle`
/// from dumping a large accumulated pile at once, but `Settle` is permissionless,
/// so a single block can contain many `Settle` txs — a determined single-block
/// actor can fire several and drain multiple slices. `SETTLE_LIMIT` bounds the
/// per-call batch, not the per-block total, and it is NOT the per-staker anti-JIT
/// guarantee; that is the Horn Vault's own `min_stake_seconds` cooldown, which
/// must be set `> 0` (it defaults to 0). See the module docs' honest-limitation
/// section. Whatever a call leaves behind is drained by the next `Settle`; the
/// buffer key is the ordered `mature_at` second, so calls always make progress
/// oldest-first.
pub const SETTLE_LIMIT: usize = 50;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("bps must be <= 10000")]
    BadBps {},
    /// A gate of zero would settle in the swap's own block and silently restore
    /// the just-in-time hole. Mirrors the source's `StayTooShort`.
    #[error("min_stake_seconds of 0 would pay just-in-time stakers")]
    StayTooShort {},
    /// Mirrors the source's `StayTooLong`.
    #[error("min_stake_seconds exceeds the ceiling this Horn will enforce")]
    StayTooLong {},
}

// ── state ───────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    /// The AMM — the only address allowed to call `after_swap`.
    pub amm: Addr,
    /// The launchpad — allowed (with admin) to register a pool's split.
    pub launchpad: Addr,
    /// The Horn Vault this Horn ultimately deposits matured rewards into.
    pub vault: Addr,
    /// The vesting gate: a swap's skim is withheld from the Vault for this many
    /// seconds. This is the anti-JIT knob; see the module docs.
    pub min_stake_seconds: u64,
    /// Fallback ANSEM-sink share (bps) for pools with no registered split.
    pub default_ansem_bps: u16,
}

const CONFIG: Item<Config> = Item::new("config");
/// Per-pool ANSEM-sink share in bps (CHANSE share = 10000 - this). Key: token_address.
const POOL_ANSEM_BPS: Map<&str, u16> = Map::new("pool_ansem_bps");
/// The vesting buffer: skimmed reward coins waiting out the gate before they may
/// be deposited into the Vault. Key: (sink, mature_at_seconds) -> merged coins.
/// Many swaps that mature in the same second coalesce onto one key.
const BUFFER: Map<(&str, u64), Vec<Coin>> = Map::new("buffer");

// ── messages ────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub amm: String,
    pub launchpad: String,
    pub vault: String,
    /// The vesting gate in seconds. MUST be > 0 and <= `MAX_STAKE_SECONDS`.
    pub min_stake_seconds: u64,
    /// Default ANSEM-sink share in bps (e.g. 5000 = 50/50). CHANSE gets the rest.
    pub default_ansem_bps: u16,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// AMM callback — MUST match the AMM's `HookExecute::AfterSwap` shape. The
    /// skimmed fee coins arrive as attached funds. Never forwards synchronously:
    /// it parks the skim in the vesting buffer. Non-reverting on an empty/absent
    /// skim.
    AfterSwap {
        token_address: String,
        sender: String,
        offer_ansem: bool,
        input_amount: Uint128,
        output_amount: Uint128,
        fee_amount: Uint128,
    },
    /// Permissionless: deposit matured buffered value (mature_at <= now) into the
    /// Vault, per sink, provided the sink has stakers. This is the only path that
    /// moves value into the Vault, and it can only move value that has already
    /// waited out the gate. Bounded: it drains at most `SETTLE_LIMIT` matured keys
    /// per call (oldest first); call it repeatedly to drain a large backlog.
    Settle {},
    /// Set a pool's ANSEM/CHANSE split. Called by the launchpad at graduation
    /// (or the admin). CHANSE share is `10000 - ansem_bps`.
    RegisterPool { token_address: String, ansem_bps: u16 },
    UpdateConfig {
        admin: Option<String>,
        min_stake_seconds: Option<u64>,
        default_ansem_bps: Option<u16>,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(Config)]
    Config {},
    #[returns(SplitResponse)]
    PoolSplit { token_address: String },
    /// Matured (settleable now) and still-vesting buffered value for a sink.
    #[returns(BufferedResponse)]
    Buffered { sink: String },
}

#[cw_serde]
pub struct SplitResponse {
    pub ansem_bps: u16,
    pub chanse_bps: u16,
}

#[cw_serde]
pub struct BufferedResponse {
    pub sink: String,
    /// Value whose gate has passed and that a `Settle` would deposit now.
    pub matured: Vec<Coin>,
    /// Value still inside the vesting gate.
    pub vesting: Vec<Coin>,
}

// ── Vault interface (matches ansem-horn-vault) ──────────────────────────────

#[cw_serde]
enum VaultExecuteMsg {
    DepositReward { sink: String },
}

#[cw_serde]
enum VaultQueryMsg {
    Sink { denom: String },
}

#[cw_serde]
struct VaultSinkResponse {
    stake_denom: String,
    total_staked: Uint128,
    reward_denoms: Vec<String>,
}

// ── entry points ────────────────────────────────────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    cw2::set_contract_version(deps.storage, "ansem-horn-gauge", env!("CARGO_PKG_VERSION"))?;
    validate_gate(msg.min_stake_seconds)?;
    if msg.default_ansem_bps as u128 > BPS {
        return Err(ContractError::BadBps {});
    }
    CONFIG.save(
        deps.storage,
        &Config {
            admin: deps.api.addr_validate(&msg.admin)?,
            amm: deps.api.addr_validate(&msg.amm)?,
            launchpad: deps.api.addr_validate(&msg.launchpad)?,
            vault: deps.api.addr_validate(&msg.vault)?,
            min_stake_seconds: msg.min_stake_seconds,
            default_ansem_bps: msg.default_ansem_bps,
        },
    )?;
    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("min_stake_seconds", msg.min_stake_seconds.to_string()))
}

/// The two halves — the gate and the payment — are useless apart, so the
/// configuration that separates them (a zero gate) has to be unreachable rather
/// than merely discouraged. Mirrors the source's `initialize` require!s.
fn validate_gate(min_stake_seconds: u64) -> Result<(), ContractError> {
    if min_stake_seconds == 0 {
        return Err(ContractError::StayTooShort {});
    }
    if min_stake_seconds > MAX_STAKE_SECONDS {
        return Err(ContractError::StayTooLong {});
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
        ExecuteMsg::AfterSwap { token_address, .. } => after_swap(deps, env, info, token_address),
        ExecuteMsg::Settle {} => settle(deps, env),
        ExecuteMsg::RegisterPool {
            token_address,
            ansem_bps,
        } => register_pool(deps, info, token_address, ansem_bps),
        ExecuteMsg::UpdateConfig {
            admin,
            min_stake_seconds,
            default_ansem_bps,
        } => update_config(deps, info, admin, min_stake_seconds, default_ansem_bps),
    }
}

/// The AMM forwarded the skim (info.funds). Split it by the pool's share and park
/// each side in the vesting buffer stamped `now + min_stake_seconds`. It does NOT
/// touch the Vault: withholding the value for the gate is the whole anti-JIT
/// point. Non-reverting on an empty skim, so a routine swap can never fail here.
fn after_swap(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    token_address: String,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.amm {
        return Err(ContractError::Unauthorized {});
    }
    if info.funds.is_empty() {
        // Nothing skimmed (e.g. a custom-curve swap) — nothing to park.
        return Ok(Response::new()
            .add_attribute("action", "after_swap")
            .add_attribute("skim", "0"));
    }
    let ansem_bps = POOL_ANSEM_BPS
        .may_load(deps.storage, &token_address)?
        .unwrap_or(cfg.default_ansem_bps) as u128;

    let (to_ansem, to_chanse) = split_funds(ansem_bps, &info.funds);
    let mature_at = env.block.time.seconds() + cfg.min_stake_seconds;

    park(deps.storage, ANSEM_SINK, mature_at, to_ansem)?;
    park(deps.storage, CHANSE_SINK, mature_at, to_chanse)?;

    Ok(Response::new()
        .add_attribute("action", "after_swap")
        .add_attribute("token_address", token_address)
        .add_attribute("mature_at", mature_at.to_string()))
}

/// Deposit matured buffer entries (mature_at <= now) into the Vault, one
/// `DepositReward` per sink, provided the sink has stakers. A sink with no
/// stakers keeps its matured value buffered (a later `Settle` handles it) rather
/// than pushing into an empty sink, which the Vault rejects and which would lose
/// value. Permissionless.
///
/// **Bounded on purpose.** The range is capped to matured keys via the ordered
/// `mature_at` sub-key — `[.., Bound::inclusive(now)]` — so still-vesting keys are
/// never scanned, and only `SETTLE_LIMIT` matured keys are drained per call
/// (oldest first, shared across both sinks). Only the keys actually drained are
/// removed; anything left over is picked up by the next call. This is what makes
/// `Settle` immune to a cheap one-swap-per-second flood (it can never load an
/// unbounded number of keys) and what bounds the size of any single batch a
/// `Stake → Settle → Unstake` snipe could capture — including from a sink that sat
/// empty and accumulated matured value, which now releases in bounded slices
/// rather than one snipeable lump.
fn settle(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let now = env.block.time.seconds();

    let mut msgs: Vec<CosmosMsg> = vec![];
    let mut settled_keys: Vec<(&str, u64)> = vec![];
    let mut total_settled: u128 = 0;
    let mut budget = SETTLE_LIMIT;

    for sink in [ANSEM_SINK, CHANSE_SINK] {
        if budget == 0 {
            break; // per-call cap reached; a follow-up Settle drains the rest.
        }
        if !sink_has_stakers(&deps.as_ref(), &cfg.vault, sink)? {
            continue; // defer: leave this sink's matured value buffered.
        }
        // Only matured keys (mature_at <= now), oldest first, at most `budget` of
        // them. Bounding the max end of the range means still-vesting keys are
        // never even loaded; the `take` caps gas and batch size per call.
        let matured: Vec<(u64, Vec<Coin>)> = BUFFER
            .prefix(sink)
            .range(
                deps.storage,
                None,
                Some(Bound::inclusive(now)),
                Order::Ascending,
            )
            .take(budget)
            .collect::<StdResult<Vec<_>>>()?;

        let mut merged: BTreeMap<String, Uint128> = BTreeMap::new();
        for (mature_at, coins) in &matured {
            for c in coins {
                if !c.amount.is_zero() {
                    *merged.entry(c.denom.clone()).or_default() += c.amount;
                }
            }
            settled_keys.push((sink, *mature_at));
            budget -= 1;
        }

        let funds: Vec<Coin> = merged
            .into_iter()
            .filter(|(_, a)| !a.is_zero())
            .map(|(denom, amount)| {
                total_settled += amount.u128();
                Coin { denom, amount }
            })
            .collect();
        if funds.is_empty() {
            continue;
        }
        msgs.push(CosmosMsg::Wasm(WasmMsg::Execute {
            contract_addr: cfg.vault.to_string(),
            msg: to_binary(&VaultExecuteMsg::DepositReward {
                sink: sink.to_string(),
            })?,
            funds,
        }));
    }

    // Only remove the keys we actually deposited.
    for (sink, mature_at) in settled_keys {
        BUFFER.remove(deps.storage, (sink, mature_at));
    }

    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "settle")
        .add_attribute("settled", total_settled.to_string()))
}

fn register_pool(
    deps: DepsMut,
    info: MessageInfo,
    token_address: String,
    ansem_bps: u16,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.launchpad && info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    if ansem_bps as u128 > BPS {
        return Err(ContractError::BadBps {});
    }
    POOL_ANSEM_BPS.save(deps.storage, &token_address, &ansem_bps)?;
    Ok(Response::new()
        .add_attribute("action", "register_pool")
        .add_attribute("token_address", token_address)
        .add_attribute("ansem_bps", ansem_bps.to_string()))
}

fn update_config(
    deps: DepsMut,
    info: MessageInfo,
    admin: Option<String>,
    min_stake_seconds: Option<u64>,
    default_ansem_bps: Option<u16>,
) -> Result<Response, ContractError> {
    let mut cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    if let Some(a) = admin {
        cfg.admin = deps.api.addr_validate(&a)?;
    }
    if let Some(s) = min_stake_seconds {
        validate_gate(s)?;
        cfg.min_stake_seconds = s;
    }
    if let Some(b) = default_ansem_bps {
        if b as u128 > BPS {
            return Err(ContractError::BadBps {});
        }
        cfg.default_ansem_bps = b;
    }
    CONFIG.save(deps.storage, &cfg)?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

// ── pure helpers ────────────────────────────────────────────────────────────

/// Split `funds` into the ANSEM side (`ansem_bps`) and CHANSE side (the rest).
/// Integer division rounds the ANSEM share down; the remainder rides on the
/// CHANSE side so nothing is ever dropped and the two sides sum to the input.
fn split_funds(ansem_bps: u128, funds: &[Coin]) -> (Vec<Coin>, Vec<Coin>) {
    let mut to_ansem = vec![];
    let mut to_chanse = vec![];
    for c in funds {
        if c.amount.is_zero() {
            continue;
        }
        // Checked ratio math: `multiply_ratio` widens to Uint256 internally, so
        // `amount * ansem_bps` cannot overflow a native u128. Floor division
        // rounds the ANSEM share down; the remainder rides on the CHANSE side so
        // the two sides always sum back to the input and nothing is dropped.
        let a = c.amount.multiply_ratio(ansem_bps, BPS);
        let ch = c.amount - a; // a <= amount, so this never underflows.
        if !a.is_zero() {
            to_ansem.push(Coin {
                denom: c.denom.clone(),
                amount: a,
            });
        }
        if !ch.is_zero() {
            to_chanse.push(Coin {
                denom: c.denom.clone(),
                amount: ch,
            });
        }
    }
    (to_ansem, to_chanse)
}

/// Merge two coin lists by denom.
fn merge_coins(mut into: Vec<Coin>, add: Vec<Coin>) -> Vec<Coin> {
    for c in add {
        if c.amount.is_zero() {
            continue;
        }
        if let Some(existing) = into.iter_mut().find(|e| e.denom == c.denom) {
            existing.amount += c.amount;
        } else {
            into.push(c);
        }
    }
    into
}

/// Park `coins` in the vesting buffer at `(sink, mature_at)`, coalescing with any
/// coins already stamped for the same second.
fn park(
    storage: &mut dyn cosmwasm_std::Storage,
    sink: &str,
    mature_at: u64,
    coins: Vec<Coin>,
) -> Result<(), ContractError> {
    if coins.iter().all(|c| c.amount.is_zero()) {
        return Ok(());
    }
    let existing = BUFFER.may_load(storage, (sink, mature_at))?.unwrap_or_default();
    let merged = merge_coins(existing, coins);
    BUFFER.save(storage, (sink, mature_at), &merged)?;
    Ok(())
}

fn sink_has_stakers(deps: &Deps, vault: &Addr, denom: &str) -> Result<bool, ContractError> {
    let resp: VaultSinkResponse = deps.querier.query_wasm_smart(
        vault,
        &VaultQueryMsg::Sink {
            denom: denom.to_string(),
        },
    )?;
    Ok(!resp.total_staked.is_zero())
}

// ── queries ─────────────────────────────────────────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::PoolSplit { token_address } => {
            let cfg = CONFIG.load(deps.storage)?;
            let ansem_bps = POOL_ANSEM_BPS
                .may_load(deps.storage, &token_address)?
                .unwrap_or(cfg.default_ansem_bps);
            to_binary(&SplitResponse {
                ansem_bps,
                chanse_bps: (BPS as u16) - ansem_bps,
            })
        }
        QueryMsg::Buffered { sink } => to_binary(&query_buffered(deps, env, sink)?),
    }
}

fn query_buffered(deps: Deps, env: Env, sink: String) -> StdResult<BufferedResponse> {
    let now = env.block.time.seconds();
    let mut matured: Vec<Coin> = vec![];
    let mut vesting: Vec<Coin> = vec![];
    for entry in BUFFER
        .prefix(&sink)
        .range(deps.storage, None, None, Order::Ascending)
    {
        let (mature_at, coins) = entry?;
        if mature_at <= now {
            matured = merge_coins(matured, coins);
        } else {
            vesting = merge_coins(vesting, coins);
        }
    }
    Ok(BufferedResponse {
        sink,
        matured,
        vesting,
    })
}

// ── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info, MockQuerier};
    use cosmwasm_std::{
        coins, from_binary, ContractResult, OwnedDeps, QuerierResult, SystemResult, WasmQuery,
    };

    const AMM: &str = "amm";
    const VAULT: &str = "vault";

    fn setup(
        min_stake_seconds: u64,
    ) -> OwnedDeps<cosmwasm_std::MemoryStorage, cosmwasm_std::testing::MockApi, MockQuerier> {
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                amm: AMM.into(),
                launchpad: "launchpad".into(),
                vault: VAULT.into(),
                min_stake_seconds,
                default_ansem_bps: 5000,
            },
        )
        .unwrap();
        deps
    }

    /// Point the Vault sink query at fixed total_staked values.
    fn wire_vault(
        querier: &mut MockQuerier,
        ansem_staked: u128,
        chanse_staked: u128,
    ) {
        querier.update_wasm(move |q| -> QuerierResult {
            match q {
                WasmQuery::Smart { msg, .. } => {
                    let vq: VaultQueryMsg = from_binary(msg).unwrap();
                    let VaultQueryMsg::Sink { denom } = vq;
                    let total = if denom == ANSEM_SINK {
                        ansem_staked
                    } else {
                        chanse_staked
                    };
                    let resp = VaultSinkResponse {
                        stake_denom: denom,
                        total_staked: Uint128::new(total),
                        reward_denoms: vec![],
                    };
                    SystemResult::Ok(ContractResult::Ok(to_binary(&resp).unwrap()))
                }
                _ => SystemResult::Ok(ContractResult::Ok(Binary::default())),
            }
        });
    }

    fn env_at(t: u64) -> Env {
        let mut e = mock_env();
        e.block.time = cosmwasm_std::Timestamp::from_seconds(t);
        e
    }

    fn do_swap(
        deps: &mut OwnedDeps<cosmwasm_std::MemoryStorage, cosmwasm_std::testing::MockApi, MockQuerier>,
        at: u64,
        skim: &[Coin],
    ) -> Response {
        execute(
            deps.as_mut(),
            env_at(at),
            mock_info(AMM, skim),
            ExecuteMsg::AfterSwap {
                token_address: "tokenX".into(),
                sender: "trader".into(),
                offer_ansem: true,
                input_amount: Uint128::new(1),
                output_amount: Uint128::new(1),
                fee_amount: Uint128::new(1),
            },
        )
        .unwrap()
    }

    fn buffered(
        deps: &OwnedDeps<cosmwasm_std::MemoryStorage, cosmwasm_std::testing::MockApi, MockQuerier>,
        at: u64,
        sink: &str,
    ) -> BufferedResponse {
        from_binary(
            &query(deps.as_ref(), env_at(at), QueryMsg::Buffered { sink: sink.into() }).unwrap(),
        )
        .unwrap()
    }

    fn register(
        deps: &mut OwnedDeps<cosmwasm_std::MemoryStorage, cosmwasm_std::testing::MockApi, MockQuerier>,
        token: &str,
        ansem_bps: u16,
    ) {
        execute(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            ExecuteMsg::RegisterPool {
                token_address: token.into(),
                ansem_bps,
            },
        )
        .unwrap();
    }

    /// The `settled` total attribute a `settle` response reports.
    fn settled_of(resp: &Response) -> u128 {
        resp.attributes
            .iter()
            .find(|a| a.key == "settled")
            .unwrap()
            .value
            .parse()
            .unwrap()
    }

    // ── gate config guardrails (mirror the source's StayTooShort/StayTooLong) ──

    #[test]
    fn a_gate_of_zero_is_not_a_valid_configuration() {
        // Zero would settle in the swap's own block and silently disable anti-JIT.
        assert_eq!(validate_gate(0), Err(ContractError::StayTooShort {}));
        assert_eq!(validate_gate(1), Ok(()));
        assert_eq!(validate_gate(MAX_STAKE_SECONDS), Ok(()));
        assert_eq!(
            validate_gate(MAX_STAKE_SECONDS + 1),
            Err(ContractError::StayTooLong {})
        );
    }

    #[test]
    fn instantiate_rejects_zero_gate() {
        let mut deps = mock_dependencies();
        let err = instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                amm: AMM.into(),
                launchpad: "launchpad".into(),
                vault: VAULT.into(),
                min_stake_seconds: 0,
                default_ansem_bps: 5000,
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::StayTooShort {});
    }

    // ── the split math never drops a unit ──

    #[test]
    fn split_puts_the_rounding_remainder_on_chanse() {
        // 7 at 5000 bps: ansem = 3 (floor), chanse = 4. Sums back to 7.
        let (a, ch) = split_funds(5000, &coins(7, "uchanse"));
        assert_eq!(a, coins(3, "uchanse"));
        assert_eq!(ch, coins(4, "uchanse"));
    }

    // ── the anti-JIT core: after_swap pays nobody in the swap's block ──

    #[test]
    fn after_swap_never_touches_the_vault() {
        let mut deps = setup(100);
        // Even with a fat skim attached, after_swap emits no messages: the value
        // is parked, not forwarded. A staker present only in this block earns
        // nothing, because nothing is paid out now. This is the JIT defence.
        let resp = do_swap(&mut deps, 1_000, &coins(1_000, "uchanse"));
        assert!(resp.messages.is_empty(), "after_swap must not deposit synchronously");
        // The whole skim is now vesting, none of it matured.
        let b = buffered(&deps, 1_000, CHANSE_SINK);
        assert!(b.matured.is_empty());
        // 5000/5000 split: 500 to each side, remainder rules put nothing extra here.
        let a = buffered(&deps, 1_000, ANSEM_SINK);
        assert_eq!(a.vesting, coins(500, "uchanse"));
        assert_eq!(b.vesting, coins(500, "uchanse"));
    }

    #[test]
    fn settle_pays_nothing_before_the_gate_elapses() {
        let mut deps = setup(100);
        wire_vault(&mut deps.querier, 1, 1); // both sinks have stakers
        do_swap(&mut deps, 1_000, &coins(1_000, "uchanse")); // mature_at = 1_100
        // One second before maturity: still nothing settleable.
        let resp = settle(deps.as_mut(), env_at(1_099)).unwrap();
        assert!(
            resp.messages.is_empty(),
            "a swap's reward must be withheld for the full gate"
        );
        // And it is all still vesting.
        assert!(buffered(&deps, 1_099, CHANSE_SINK).matured.is_empty());
    }

    #[test]
    fn settle_pays_into_the_vault_once_matured() {
        let mut deps = setup(100);
        wire_vault(&mut deps.querier, 1, 1);
        do_swap(&mut deps, 1_000, &coins(1_000, "uchanse")); // mature_at = 1_100

        // At exactly maturity the value is settleable and one DepositReward per
        // sink is emitted, carrying that sink's share.
        let resp = settle(deps.as_mut(), env_at(1_100)).unwrap();
        assert_eq!(resp.messages.len(), 2);
        let mut seen: BTreeMap<String, Vec<Coin>> = BTreeMap::new();
        for m in &resp.messages {
            if let CosmosMsg::Wasm(WasmMsg::Execute { msg, funds, contract_addr }) = &m.msg {
                assert_eq!(contract_addr, VAULT);
                let vm: VaultExecuteMsg = from_binary(msg).unwrap();
                let VaultExecuteMsg::DepositReward { sink } = vm;
                seen.insert(sink, funds.clone());
            } else {
                panic!("expected a Vault DepositReward");
            }
        }
        assert_eq!(seen.get(ANSEM_SINK).unwrap(), &coins(500, "uchanse"));
        assert_eq!(seen.get(CHANSE_SINK).unwrap(), &coins(500, "uchanse"));

        // Buffer is drained; a second settle in the same block does nothing.
        let again = settle(deps.as_mut(), env_at(1_100)).unwrap();
        assert!(again.messages.is_empty());
    }

    #[test]
    fn matured_value_for_an_empty_sink_is_deferred_not_deposited() {
        let mut deps = setup(100);
        // ANSEM sink has stakers, CHANSE sink is empty.
        wire_vault(&mut deps.querier, 1, 0);
        do_swap(&mut deps, 1_000, &coins(1_000, "uchanse")); // mature_at = 1_100

        let resp = settle(deps.as_mut(), env_at(1_200)).unwrap();
        // Only the ANSEM sink is paid; the CHANSE sink's matured share is retained.
        assert_eq!(resp.messages.len(), 1);
        if let CosmosMsg::Wasm(WasmMsg::Execute { msg, .. }) = &resp.messages[0].msg {
            let vm: VaultExecuteMsg = from_binary(msg).unwrap();
            let VaultExecuteMsg::DepositReward { sink } = vm;
            assert_eq!(sink, ANSEM_SINK);
        } else {
            panic!("expected a Vault DepositReward");
        }
        // The CHANSE side's matured value survives for a later settle.
        assert_eq!(buffered(&deps, 1_200, CHANSE_SINK).matured, coins(500, "uchanse"));

        // Once CHANSE gains a staker, the retained value settles.
        wire_vault(&mut deps.querier, 1, 1);
        let resp2 = settle(deps.as_mut(), env_at(1_300)).unwrap();
        assert_eq!(resp2.messages.len(), 1);
    }

    #[test]
    fn only_matured_batches_settle_partially() {
        let mut deps = setup(100);
        wire_vault(&mut deps.querier, 1, 1);
        // Two swaps at different times -> two maturities (1_100 and 1_150).
        do_swap(&mut deps, 1_000, &coins(1_000, "uchanse")); // mature 1_100
        do_swap(&mut deps, 1_050, &coins(400, "uchanse")); // mature 1_150

        // At 1_120 only the first batch has matured.
        let b = buffered(&deps, 1_120, CHANSE_SINK);
        assert_eq!(b.matured, coins(500, "uchanse")); // half of the 1000
        assert_eq!(b.vesting, coins(200, "uchanse")); // half of the 400

        let resp = settle(deps.as_mut(), env_at(1_120)).unwrap();
        // Deposits only the matured half; the younger batch stays vesting.
        assert_eq!(resp.messages.len(), 2);
        assert_eq!(buffered(&deps, 1_120, CHANSE_SINK).matured, vec![]);
        assert_eq!(buffered(&deps, 1_120, CHANSE_SINK).vesting, coins(200, "uchanse"));
    }

    #[test]
    fn unauthorized_caller_cannot_park_a_skim() {
        let mut deps = setup(100);
        let err = execute(
            deps.as_mut(),
            env_at(1_000),
            mock_info("not_the_amm", &coins(100, "uchanse")),
            ExecuteMsg::AfterSwap {
                token_address: "tokenX".into(),
                sender: "trader".into(),
                offer_ansem: true,
                input_amount: Uint128::new(1),
                output_amount: Uint128::new(1),
                fee_amount: Uint128::new(1),
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
    }

    #[test]
    fn empty_skim_is_a_noop_not_a_revert() {
        let mut deps = setup(100);
        let resp = do_swap(&mut deps, 1_000, &[]);
        assert!(resp.messages.is_empty());
        assert!(buffered(&deps, 9_999, ANSEM_SINK).matured.is_empty());
        assert!(buffered(&deps, 9_999, ANSEM_SINK).vesting.is_empty());
    }

    // ── regression: settle is bounded under a flood (the DoS fix) ──

    #[test]
    fn settle_stays_bounded_under_a_flood() {
        let mut deps = setup(100);
        wire_vault(&mut deps.querier, 1, 1);
        register(&mut deps, "tokenX", 10_000); // all skim -> ANSEM sink only

        // A cheap one-swap-per-second flood stamps one distinct matured key per
        // second. Pre-fix, settle would try to load ALL of them in one call and
        // brick on gas, permanently stranding the funds.
        let n: u64 = 120;
        for i in 0..n {
            do_swap(&mut deps, 1_000 + i, &coins(10, "uchanse"));
        }
        let t = 1_000_000; // everything has matured

        // Each Settle drains at most SETTLE_LIMIT keys (=500 uchanse @ 10 each),
        // never the whole pile; repeated calls drain the remainder.
        let r1 = settle(deps.as_mut(), env_at(t)).unwrap();
        assert_eq!(r1.messages.len(), 1);
        assert_eq!(settled_of(&r1), SETTLE_LIMIT as u128 * 10); // 500, not 1200
        assert_eq!(buffered(&deps, t, ANSEM_SINK).matured, coins((n as u128 - SETTLE_LIMIT as u128) * 10, "uchanse"));

        let r2 = settle(deps.as_mut(), env_at(t)).unwrap();
        assert_eq!(settled_of(&r2), SETTLE_LIMIT as u128 * 10); // 500
        let r3 = settle(deps.as_mut(), env_at(t)).unwrap();
        assert_eq!(settled_of(&r3), (n as u128 - 2 * SETTLE_LIMIT as u128) * 10); // 200

        // Buffer is now fully drained.
        let r4 = settle(deps.as_mut(), env_at(t)).unwrap();
        assert!(r4.messages.is_empty());
        assert_eq!(settled_of(&r4), 0);
        assert!(buffered(&deps, t, ANSEM_SINK).matured.is_empty());
    }

    // ── regression: an empty-sink backlog can be sniped only in bounded slices ──

    #[test]
    fn empty_sink_backlog_snipes_only_a_bounded_slice() {
        let mut deps = setup(100);
        register(&mut deps, "tokenX", 0); // all skim -> CHANSE sink only
        // CHANSE has no stakers while a long run of swaps accumulates matured value.
        wire_vault(&mut deps.querier, 1, 0);

        let n: u64 = 120;
        for i in 0..n {
            do_swap(&mut deps, 1_000 + i, &coins(10, "uchanse"));
        }
        let t = 1_000_000;

        // While CHANSE is empty every matured key is deferred, so the whole pile
        // just sits buffered.
        let deferred = settle(deps.as_mut(), env_at(t)).unwrap();
        assert!(deferred.messages.is_empty());
        assert_eq!(buffered(&deps, t, CHANSE_SINK).matured, coins(n as u128 * 10, "uchanse")); // 1200

        // A one-block actor stakes into CHANSE and settles in the same block.
        // Pre-fix this flushed the ENTIRE 1200 pile into the age-blind Vault in a
        // single shot for them to grab pro-rata. Now one Settle releases at most
        // SETTLE_LIMIT keys, so the snipe captures only a bounded slice.
        wire_vault(&mut deps.querier, 1, 1);
        let snipe = settle(deps.as_mut(), env_at(t)).unwrap();
        assert_eq!(snipe.messages.len(), 1);
        assert_eq!(settled_of(&snipe), SETTLE_LIMIT as u128 * 10); // 500, not 1200
        // The residual survives for later settles rather than being snipeable now.
        assert_eq!(
            buffered(&deps, t, CHANSE_SINK).matured,
            coins((n as u128 - SETTLE_LIMIT as u128) * 10, "uchanse") // 700 left
        );
    }

    // ── regression: negative-auth on the admin/launchpad-gated messages ──

    #[test]
    fn register_pool_rejects_unauthorized() {
        let mut deps = setup(100);
        let err = execute(
            deps.as_mut(),
            env_at(1),
            mock_info("rando", &[]),
            ExecuteMsg::RegisterPool {
                token_address: "tokenX".into(),
                ansem_bps: 5000,
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
        // The launchpad and the admin are both allowed.
        assert!(execute(
            deps.as_mut(),
            env_at(1),
            mock_info("launchpad", &[]),
            ExecuteMsg::RegisterPool { token_address: "tokenX".into(), ansem_bps: 5000 },
        )
        .is_ok());
        assert!(execute(
            deps.as_mut(),
            env_at(1),
            mock_info("admin", &[]),
            ExecuteMsg::RegisterPool { token_address: "tokenY".into(), ansem_bps: 5000 },
        )
        .is_ok());
    }

    #[test]
    fn update_config_rejects_unauthorized() {
        let mut deps = setup(100);
        let err = execute(
            deps.as_mut(),
            env_at(1),
            mock_info("rando", &[]),
            ExecuteMsg::UpdateConfig {
                admin: None,
                min_stake_seconds: Some(200),
                default_ansem_bps: None,
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
        // The admin can.
        assert!(execute(
            deps.as_mut(),
            env_at(1),
            mock_info("admin", &[]),
            ExecuteMsg::UpdateConfig {
                admin: None,
                min_stake_seconds: Some(200),
                default_ansem_bps: None,
            },
        )
        .is_ok());
    }
}
