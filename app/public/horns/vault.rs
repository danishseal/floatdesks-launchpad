//! Horn Vault — the rewards distributor for the Horns system.
//!
//! Holders stake a native asset (ANSEM `uansem` or CHANSE `uchanse`) into a
//! per-asset "sink" and earn a pro-rata share of whatever fee value Horns route
//! in. Every graduated pool's Fee-Share Horn skims a slice of each swap's fee
//! and forwards it here via `DepositReward { sink }`, split by the pool's chosen
//! ANSEM/CHANSE percentage.
//!
//! Design notes:
//! * **Multi-reward accounting.** A sink can receive rewards in more than one
//!   denom (a CHANSE-quoted pool forwards `uchanse`; an ANSEM-quoted pool
//!   forwards `uansem`), so accounting is keyed by `(sink, reward_denom)` — the
//!   classic MasterChef `acc_reward_per_share` + per-staker `reward_debt`, one
//!   accumulator per reward denom.
//! * **Extensible by design.** `DepositReward` is PERMISSIONLESS: any Horn —
//!   including ones written and deployed long after this contract — can send
//!   funds to a sink and have them distributed. Adding rewards only ever
//!   benefits stakers, so there is no reason to gate it, and new Horns need zero
//!   changes here. Reward denoms are discovered dynamically as they arrive.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    coins, entry_point, to_binary, Addr, BankMsg, Binary, Coin, Deps, DepsMut, Env, MessageInfo,
    Order, Response, StdResult, Uint128, Uint256,
};
use cw_storage_plus::{Item, Map};
use thiserror::Error;

// ── errors ──────────────────────────────────────────────────────────────────

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("send exactly one native coin")]
    OneCoin {},
    #[error("denom {denom} is not a staking sink")]
    NotASink { denom: String },
    #[error("nothing staked in {denom}")]
    NothingStaked { denom: String },
    #[error("amount exceeds staked balance")]
    Overdraw {},
    #[error("zero amount")]
    Zero {},
    #[error("no stakers in sink {denom}; reward would be lost")]
    EmptySink { denom: String },
    #[error("sink {sink} already has the maximum {max} reward denoms")]
    TooManyRewardDenoms { sink: String, max: u32 },
    #[error("stake is still in cooldown; eligible at {ready_at}")]
    Cooldown { ready_at: u64 },
}

// ── precision for the per-share accumulator ─────────────────────────────────
// 1e18, wide enough that a small reward against a large stake does not truncate
// to zero. All acc/debt math is in Uint256 to avoid overflow; realized payouts
// fit Uint128.
const PRECISION: Uint256 = Uint256::from_u128(1_000_000_000_000_000_000u128);

// ── denom cap ───────────────────────────────────────────────────────────────
// A sink's reward-denom set is iterated per-staker in `harvest_and_reset`, which
// runs inside `Stake`/`Unstake`/`Claim`. If that set were unbounded, an attacker
// could dust a sink with many junk denoms until the harvest loop exceeds the gas
// limit, gas-bricking `Unstake` and freezing staked principal. Capping the set of
// distinct reward denoms keeps the loop bounded, so `Unstake` can never brick.
const MAX_REWARD_DENOMS: u32 = 8;

// ── state ───────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct Config {
    /// May add new sinks. Rewards themselves are permissionless.
    pub admin: Addr,
    /// Native denoms that can be staked (e.g. ["uansem", "uchanse"]).
    pub stake_denoms: Vec<String>,
    /// Minimum seconds a stake must age before it becomes eligible to Unstake or
    /// Claim. 0 disables the cooldown (default). A positive value defeats
    /// just-in-time reward capture: an attacker can no longer stake immediately
    /// before a per-swap `DepositReward` and unstake right after.
    pub min_stake_seconds: u64,
}

const CONFIG: Item<Config> = Item::new("config");
/// Total amount staked in a sink. Key: stake_denom.
const TOTAL_STAKED: Map<&str, Uint128> = Map::new("total_staked");
/// Accumulated reward-per-share, scaled by PRECISION. Key: (stake_denom, reward_denom).
const ACC: Map<(&str, &str), Uint256> = Map::new("acc");
/// The set of reward denoms ever seen in a sink, so settle can iterate them.
/// Key: (stake_denom, reward_denom) -> () ; presence == membership.
const SINK_REWARDS: Map<(&str, &str), ()> = Map::new("sink_rewards");
/// Truncation remainder carried forward per (stake_denom, reward_denom). Each
/// deposit computes `acc += amount*PRECISION / total`; the `% total` remainder
/// would otherwise be permanently stranded, so it is banked here and added to the
/// numerator of the next deposit in the same denom. Scaled by PRECISION.
const REMAINDER: Map<(&str, &str), Uint256> = Map::new("remainder");
/// A staker's stake in a sink. Key: (stake_denom, staker).
const STAKE: Map<(&str, &Addr), Uint128> = Map::new("stake");
/// Unix time (seconds) a staker last increased their stake in a sink, for the
/// optional `min_stake_seconds` cooldown. Key: (stake_denom, staker).
const STAKE_TIME: Map<(&str, &Addr), u64> = Map::new("stake_time");
/// A staker's reward debt for a reward denom. Key: (stake_denom, staker, reward_denom).
const DEBT: Map<(&str, &Addr, &str), Uint256> = Map::new("debt");
/// Settled-but-unclaimed rewards. Key: (stake_denom, staker, reward_denom).
const CLAIMABLE: Map<(&str, &Addr, &str), Uint128> = Map::new("claimable");

// ── messages ────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    /// Native denoms holders may stake. Defaults to ["uansem","uchanse"] if empty.
    pub stake_denoms: Vec<String>,
    /// Optional anti-JIT cooldown in seconds; 0 (the default) preserves the
    /// original no-cooldown behavior. `#[serde(default)]` keeps old instantiate
    /// payloads that omit the field valid.
    #[serde(default)]
    pub min_stake_seconds: u64,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Stake the native coins attached to this message (exactly one denom, which
    /// must be a configured sink). Auto-harvests existing rewards first.
    Stake {},
    /// Unstake `amount` from the `denom` sink and receive it back. Harvests first.
    Unstake { denom: String, amount: Uint128 },
    /// Pay out all settled rewards for the caller's stake in `denom` (across every
    /// reward denom). Harvests first.
    Claim { denom: String },
    /// Route reward coins into a sink, distributed pro-rata to its stakers.
    /// PERMISSIONLESS — any Horn may call it with any reward denom(s) attached.
    DepositReward { sink: String },
    /// Admin: register a new stakeable sink denom.
    AddSink { denom: String },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(Config)]
    Config {},
    #[returns(SinkResponse)]
    Sink { denom: String },
    #[returns(StakeResponse)]
    Stake { denom: String, staker: String },
    /// Currently claimable rewards for a staker in a sink, per reward denom
    /// (includes not-yet-settled pending).
    #[returns(PendingResponse)]
    Pending { denom: String, staker: String },
}

#[cw_serde]
pub struct SinkResponse {
    pub stake_denom: String,
    pub total_staked: Uint128,
    pub reward_denoms: Vec<String>,
}

#[cw_serde]
pub struct StakeResponse {
    pub staked: Uint128,
}

#[cw_serde]
pub struct PendingResponse {
    pub rewards: Vec<Coin>,
}

// ── entry points ────────────────────────────────────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    cw2::set_contract_version(deps.storage, "ansem-horn-vault", env!("CARGO_PKG_VERSION"))?;
    let admin = deps.api.addr_validate(&msg.admin)?;
    let stake_denoms = if msg.stake_denoms.is_empty() {
        vec!["uansem".to_string(), "uchanse".to_string()]
    } else {
        msg.stake_denoms
    };
    for d in &stake_denoms {
        TOTAL_STAKED.save(deps.storage, d, &Uint128::zero())?;
    }
    CONFIG.save(
        deps.storage,
        &Config { admin, stake_denoms, min_stake_seconds: msg.min_stake_seconds },
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
        ExecuteMsg::Stake {} => execute_stake(deps, env, info),
        ExecuteMsg::Unstake { denom, amount } => execute_unstake(deps, env, info, denom, amount),
        ExecuteMsg::Claim { denom } => execute_claim(deps, env, info, denom),
        ExecuteMsg::DepositReward { sink } => execute_deposit_reward(deps, info, sink),
        ExecuteMsg::AddSink { denom } => execute_add_sink(deps, info, denom),
    }
}

/// Enforce the optional stake-age cooldown. No-op when `min_stake_seconds` is 0
/// or the staker has no recorded stake time (nothing to gate).
fn check_cooldown(
    deps: &DepsMut,
    env: &Env,
    cfg: &Config,
    denom: &str,
    staker: &Addr,
) -> Result<(), ContractError> {
    if cfg.min_stake_seconds == 0 {
        return Ok(());
    }
    if let Some(staked_at) = STAKE_TIME.may_load(deps.storage, (denom, staker))? {
        let ready_at = staked_at.saturating_add(cfg.min_stake_seconds);
        if env.block.time.seconds() < ready_at {
            return Err(ContractError::Cooldown { ready_at });
        }
    }
    Ok(())
}

fn is_sink(deps: &DepsMut, denom: &str) -> Result<(), ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if cfg.stake_denoms.iter().any(|d| d == denom) {
        Ok(())
    } else {
        Err(ContractError::NotASink {
            denom: denom.to_string(),
        })
    }
}

fn one_coin(info: &MessageInfo) -> Result<Coin, ContractError> {
    if info.funds.len() != 1 || info.funds[0].amount.is_zero() {
        return Err(ContractError::OneCoin {});
    }
    Ok(info.funds[0].clone())
}

/// Reward denoms a sink has accumulated (for settling / display).
fn sink_reward_denoms(deps: &DepsMut, sink: &str) -> StdResult<Vec<String>> {
    SINK_REWARDS
        .prefix(sink)
        .keys(deps.storage, None, None, Order::Ascending)
        .collect()
}

/// Harvest pending rewards for `staker` in `sink` given their CURRENT stake, then
/// reset their debt to `new_stake`. Standard MasterChef settle: credit
/// `stake*acc/PREC - debt` to claimable, then set `debt = new_stake*acc/PREC`.
fn harvest_and_reset(
    deps: &mut DepsMut,
    sink: &str,
    staker: &Addr,
    old_stake: Uint128,
    new_stake: Uint128,
) -> Result<(), ContractError> {
    let reward_denoms = sink_reward_denoms(deps, sink)?;
    for rd in reward_denoms {
        let acc = ACC
            .may_load(deps.storage, (sink, &rd))?
            .unwrap_or_default();
        let accumulated_old = Uint256::from(old_stake) * acc / PRECISION;
        let debt = DEBT
            .may_load(deps.storage, (sink, staker, &rd))?
            .unwrap_or_default();
        let pending = accumulated_old.checked_sub(debt).unwrap_or_default();
        if !pending.is_zero() {
            let add: Uint128 = pending.try_into().map_err(|_| ContractError::Overdraw {})?;
            let cur = CLAIMABLE
                .may_load(deps.storage, (sink, staker, &rd))?
                .unwrap_or_default();
            CLAIMABLE.save(deps.storage, (sink, staker, &rd), &(cur + add))?;
        }
        let new_debt = Uint256::from(new_stake) * acc / PRECISION;
        DEBT.save(deps.storage, (sink, staker, &rd), &new_debt)?;
    }
    Ok(())
}

fn execute_stake(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let mut deps = deps;
    let coin = one_coin(&info)?;
    is_sink(&deps, &coin.denom)?;
    let sink = coin.denom.clone();
    let staker = info.sender.clone();

    let old_stake = STAKE
        .may_load(deps.storage, (&sink, &staker))?
        .unwrap_or_default();
    let new_stake = old_stake + coin.amount;
    harvest_and_reset(&mut deps, &sink, &staker, old_stake, new_stake)?;
    STAKE.save(deps.storage, (&sink, &staker), &new_stake)?;
    // Stamp (reset) the stake age so a top-up restarts the anti-JIT cooldown.
    STAKE_TIME.save(deps.storage, (&sink, &staker), &env.block.time.seconds())?;
    let total = TOTAL_STAKED.may_load(deps.storage, &sink)?.unwrap_or_default();
    TOTAL_STAKED.save(deps.storage, &sink, &(total + coin.amount))?;

    Ok(Response::new()
        .add_attribute("action", "stake")
        .add_attribute("sink", sink)
        .add_attribute("amount", coin.amount)
        .add_attribute("staked", new_stake))
}

fn execute_unstake(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    denom: String,
    amount: Uint128,
) -> Result<Response, ContractError> {
    let mut deps = deps;
    is_sink(&deps, &denom)?;
    if amount.is_zero() {
        return Err(ContractError::Zero {});
    }
    let staker = info.sender.clone();
    let cfg = CONFIG.load(deps.storage)?;
    check_cooldown(&deps, &env, &cfg, &denom, &staker)?;
    let old_stake = STAKE
        .may_load(deps.storage, (&denom, &staker))?
        .unwrap_or_default();
    if amount > old_stake {
        return Err(ContractError::Overdraw {});
    }
    let new_stake = old_stake - amount;
    harvest_and_reset(&mut deps, &denom, &staker, old_stake, new_stake)?;
    if new_stake.is_zero() {
        STAKE.remove(deps.storage, (&denom, &staker));
        STAKE_TIME.remove(deps.storage, (&denom, &staker));
    } else {
        STAKE.save(deps.storage, (&denom, &staker), &new_stake)?;
    }
    let total = TOTAL_STAKED.may_load(deps.storage, &denom)?.unwrap_or_default();
    TOTAL_STAKED.save(deps.storage, &denom, &(total - amount))?;

    Ok(Response::new()
        .add_message(BankMsg::Send {
            to_address: staker.to_string(),
            amount: coins(amount.u128(), &denom),
        })
        .add_attribute("action", "unstake")
        .add_attribute("sink", denom)
        .add_attribute("amount", amount))
}

fn execute_claim(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    denom: String,
) -> Result<Response, ContractError> {
    let mut deps = deps;
    is_sink(&deps, &denom)?;
    let staker = info.sender.clone();
    let cfg = CONFIG.load(deps.storage)?;
    check_cooldown(&deps, &env, &cfg, &denom, &staker)?;
    let stake = STAKE
        .may_load(deps.storage, (&denom, &staker))?
        .unwrap_or_default();
    // Settle up to now (harvest with unchanged stake), then sweep claimable.
    harvest_and_reset(&mut deps, &denom, &staker, stake, stake)?;

    let reward_denoms = sink_reward_denoms(&deps, &denom)?;
    let mut payout: Vec<Coin> = vec![];
    for rd in reward_denoms {
        let amt = CLAIMABLE
            .may_load(deps.storage, (&denom, &staker, &rd))?
            .unwrap_or_default();
        if !amt.is_zero() {
            CLAIMABLE.save(deps.storage, (&denom, &staker, &rd), &Uint128::zero())?;
            payout.push(Coin {
                denom: rd,
                amount: amt,
            });
        }
    }
    let mut resp = Response::new()
        .add_attribute("action", "claim")
        .add_attribute("sink", denom);
    if !payout.is_empty() {
        resp = resp.add_message(BankMsg::Send {
            to_address: staker.to_string(),
            amount: payout,
        });
    }
    Ok(resp)
}

fn execute_deposit_reward(
    deps: DepsMut,
    info: MessageInfo,
    sink: String,
) -> Result<Response, ContractError> {
    is_sink(&deps, &sink)?;
    if info.funds.is_empty() {
        return Err(ContractError::Zero {});
    }
    let total = TOTAL_STAKED.may_load(deps.storage, &sink)?.unwrap_or_default();
    if total.is_zero() {
        // Nobody to distribute to. Reject rather than silently swallow the funds,
        // so the calling Horn can hold/retry rather than lose value.
        return Err(ContractError::EmptySink { denom: sink });
    }
    let total256 = Uint256::from(total);
    for coin in info.funds.iter() {
        if coin.amount.is_zero() {
            continue;
        }
        // Register the reward denom for this sink (idempotent), enforcing the cap
        // on distinct denoms so the per-staker harvest loop stays bounded. A NEW
        // denom is rejected once the sink already holds MAX_REWARD_DENOMS; an
        // already-registered denom always goes through.
        let already = SINK_REWARDS
            .may_load(deps.storage, (&sink, &coin.denom))?
            .is_some();
        if !already {
            let count = SINK_REWARDS
                .prefix(&sink)
                .keys(deps.storage, None, None, Order::Ascending)
                .take(MAX_REWARD_DENOMS as usize)
                .count();
            if count >= MAX_REWARD_DENOMS as usize {
                return Err(ContractError::TooManyRewardDenoms {
                    sink: sink.clone(),
                    max: MAX_REWARD_DENOMS,
                });
            }
            SINK_REWARDS.save(deps.storage, (&sink, &coin.denom), &())?;
        }
        let acc = ACC
            .may_load(deps.storage, (&sink, &coin.denom))?
            .unwrap_or_default();
        // Carry the previous truncation remainder into this deposit's numerator so
        // dust is never permanently stranded.
        let carried = REMAINDER
            .may_load(deps.storage, (&sink, &coin.denom))?
            .unwrap_or_default();
        let numerator = Uint256::from(coin.amount) * PRECISION + carried;
        let delta = numerator / total256;
        let new_remainder = numerator % total256;
        ACC.save(deps.storage, (&sink, &coin.denom), &(acc + delta))?;
        REMAINDER.save(deps.storage, (&sink, &coin.denom), &new_remainder)?;
    }
    Ok(Response::new()
        .add_attribute("action", "deposit_reward")
        .add_attribute("sink", sink)
        .add_attribute("from", info.sender))
}

fn execute_add_sink(
    deps: DepsMut,
    info: MessageInfo,
    denom: String,
) -> Result<Response, ContractError> {
    let mut cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    if !cfg.stake_denoms.iter().any(|d| d == &denom) {
        cfg.stake_denoms.push(denom.clone());
        CONFIG.save(deps.storage, &cfg)?;
        TOTAL_STAKED.save(deps.storage, &denom, &Uint128::zero())?;
    }
    Ok(Response::new()
        .add_attribute("action", "add_sink")
        .add_attribute("denom", denom))
}

// ── queries ─────────────────────────────────────────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::Sink { denom } => to_binary(&query_sink(deps, denom)?),
        QueryMsg::Stake { denom, staker } => to_binary(&query_stake(deps, denom, staker)?),
        QueryMsg::Pending { denom, staker } => to_binary(&query_pending(deps, denom, staker)?),
    }
}

fn query_sink(deps: Deps, denom: String) -> StdResult<SinkResponse> {
    let total = TOTAL_STAKED
        .may_load(deps.storage, &denom)?
        .unwrap_or_default();
    let reward_denoms: Vec<String> = SINK_REWARDS
        .prefix(&denom)
        .keys(deps.storage, None, None, Order::Ascending)
        .collect::<StdResult<_>>()?;
    Ok(SinkResponse {
        stake_denom: denom,
        total_staked: total,
        reward_denoms,
    })
}

fn query_stake(deps: Deps, denom: String, staker: String) -> StdResult<StakeResponse> {
    let addr = deps.api.addr_validate(&staker)?;
    let staked = STAKE
        .may_load(deps.storage, (&denom, &addr))?
        .unwrap_or_default();
    Ok(StakeResponse { staked })
}

fn query_pending(deps: Deps, denom: String, staker: String) -> StdResult<PendingResponse> {
    let addr = deps.api.addr_validate(&staker)?;
    let stake = STAKE
        .may_load(deps.storage, (&denom, &addr))?
        .unwrap_or_default();
    let reward_denoms: Vec<String> = SINK_REWARDS
        .prefix(&denom)
        .keys(deps.storage, None, None, Order::Ascending)
        .collect::<StdResult<_>>()?;
    let mut rewards = vec![];
    for rd in reward_denoms {
        let acc = ACC.may_load(deps.storage, (&denom, &rd))?.unwrap_or_default();
        let accumulated = Uint256::from(stake) * acc / PRECISION;
        let debt = DEBT
            .may_load(deps.storage, (&denom, &addr, &rd))?
            .unwrap_or_default();
        let pending_new = accumulated.checked_sub(debt).unwrap_or_default();
        let already = CLAIMABLE
            .may_load(deps.storage, (&denom, &addr, &rd))?
            .unwrap_or_default();
        let total: Uint128 = (Uint256::from(already) + pending_new)
            .try_into()
            .unwrap_or(already);
        if !total.is_zero() {
            rewards.push(Coin {
                denom: rd,
                amount: total,
            });
        }
    }
    Ok(PendingResponse { rewards })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
    use cosmwasm_std::{coins, from_binary, CosmosMsg, SubMsg};

    fn setup() -> cosmwasm_std::OwnedDeps<
        cosmwasm_std::MemoryStorage,
        cosmwasm_std::testing::MockApi,
        cosmwasm_std::testing::MockQuerier,
    > {
        setup_with_cooldown(0)
    }

    fn setup_with_cooldown(
        min_stake_seconds: u64,
    ) -> cosmwasm_std::OwnedDeps<
        cosmwasm_std::MemoryStorage,
        cosmwasm_std::testing::MockApi,
        cosmwasm_std::testing::MockQuerier,
    > {
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                stake_denoms: vec!["uansem".into(), "uchanse".into()],
                min_stake_seconds,
            },
        )
        .unwrap();
        deps
    }

    fn stake(deps: &mut cosmwasm_std::OwnedDeps<cosmwasm_std::MemoryStorage, cosmwasm_std::testing::MockApi, cosmwasm_std::testing::MockQuerier>, who: &str, amt: u128, denom: &str) {
        execute(deps.as_mut(), mock_env(), mock_info(who, &coins(amt, denom)), ExecuteMsg::Stake {}).unwrap();
    }

    fn deposit(deps: &mut cosmwasm_std::OwnedDeps<cosmwasm_std::MemoryStorage, cosmwasm_std::testing::MockApi, cosmwasm_std::testing::MockQuerier>, sink: &str, amt: u128, rdenom: &str) {
        execute(deps.as_mut(), mock_env(), mock_info("horn", &coins(amt, rdenom)), ExecuteMsg::DepositReward { sink: sink.into() }).unwrap();
    }

    fn pending(deps: &cosmwasm_std::OwnedDeps<cosmwasm_std::MemoryStorage, cosmwasm_std::testing::MockApi, cosmwasm_std::testing::MockQuerier>, sink: &str, who: &str) -> Vec<Coin> {
        let r: PendingResponse = from_binary(&query(deps.as_ref(), mock_env(), QueryMsg::Pending { denom: sink.into(), staker: who.into() }).unwrap()).unwrap();
        r.rewards
    }

    #[test]
    fn pro_rata_split_and_claim() {
        let mut deps = setup();
        // Alice 100, Bob 300 into the ANSEM sink -> total 400.
        stake(&mut deps, "alice", 100, "uansem");
        stake(&mut deps, "bob", 300, "uansem");
        // A Horn routes 400 uchanse of rewards into the ANSEM sink.
        deposit(&mut deps, "uansem", 400, "uchanse");
        // Split is exactly pro-rata: 100 / 300.
        assert_eq!(pending(&deps, "uansem", "alice"), coins(100, "uchanse"));
        assert_eq!(pending(&deps, "uansem", "bob"), coins(300, "uchanse"));
        // Bob's stake in the ANSEM sink is unaffected by a CHANSE-sink deposit.
        stake(&mut deps, "carol", 100, "uchanse");
        deposit(&mut deps, "uchanse", 50, "uchanse");
        assert_eq!(pending(&deps, "uansem", "bob"), coins(300, "uchanse")); // unchanged
        assert_eq!(pending(&deps, "uchanse", "carol"), coins(50, "uchanse"));

        // Alice claims: gets a BankMsg of 100 uchanse, pending resets.
        let resp = execute(deps.as_mut(), mock_env(), mock_info("alice", &[]), ExecuteMsg::Claim { denom: "uansem".into() }).unwrap();
        assert!(resp.messages.iter().any(|m: &SubMsg| matches!(&m.msg,
            CosmosMsg::Bank(BankMsg::Send { to_address, amount })
                if to_address == "alice" && amount == &coins(100, "uchanse"))));
        assert!(pending(&deps, "uansem", "alice").is_empty());
        // Bob still owed 300 after Alice's claim.
        assert_eq!(pending(&deps, "uansem", "bob"), coins(300, "uchanse"));
    }

    #[test]
    fn harvest_on_stake_change_is_correct() {
        let mut deps = setup();
        stake(&mut deps, "alice", 100, "uansem"); // total 100
        deposit(&mut deps, "uansem", 100, "uchanse"); // alice owed 100
        // Alice stakes 100 MORE — her existing 100 reward must be harvested first,
        // and her debt reset so the NEXT deposit splits against the new total.
        stake(&mut deps, "alice", 100, "uansem"); // alice now 200, total 200
        stake(&mut deps, "bob", 200, "uansem"); // total 400
        deposit(&mut deps, "uansem", 400, "uchanse"); // acc adds 400/400=1 per share
        // Alice: harvested 100 + 200 (200 stake * 1) = 300. Bob: 200.
        assert_eq!(pending(&deps, "uansem", "alice"), coins(300, "uchanse"));
        assert_eq!(pending(&deps, "uansem", "bob"), coins(200, "uchanse"));
    }

    #[test]
    fn deposit_into_empty_sink_is_rejected() {
        let mut deps = setup();
        // No stakers yet -> the Fee-Share Horn must not push here (it would lose value).
        let err = execute(deps.as_mut(), mock_env(), mock_info("horn", &coins(10, "uchanse")), ExecuteMsg::DepositReward { sink: "uansem".into() }).unwrap_err();
        assert!(matches!(err, ContractError::EmptySink { .. }));
    }

    // ── Fix 1: reward-denom cap (unbounded-set DoS) ─────────────────────────
    #[test]
    fn reward_denoms_are_capped() {
        let mut deps = setup();
        stake(&mut deps, "alice", 100, "uansem");
        // Fill the sink up to the cap with distinct reward denoms.
        for i in 0..MAX_REWARD_DENOMS {
            deposit(&mut deps, "uansem", 100, &format!("r{i}"));
        }
        // A brand-new denom past the cap is rejected...
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("horn", &coins(100, "rOVER")),
            ExecuteMsg::DepositReward { sink: "uansem".into() },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::TooManyRewardDenoms { .. }));
        // ...but an already-registered denom still deposits fine.
        deposit(&mut deps, "uansem", 100, "r0");
        // And Unstake still works (the harvest loop is bounded), so principal is
        // never frozen.
        execute(
            deps.as_mut(),
            mock_env(),
            mock_info("alice", &[]),
            ExecuteMsg::Unstake { denom: "uansem".into(), amount: Uint128::new(100) },
        )
        .unwrap();
    }

    // ── Re-audit: the unsound admin prune is GONE ───────────────────────────
    // The removed `RemoveRewardDenom` zeroed a sink's ACC/REMAINDER while leaving
    // every staker's per-denom DEBT in place. Because re-registration via
    // `DepositReward` is permissionless, a re-added denom rebuilt ACC from 0 while
    // stale DEBT persisted, so `harvest_and_reset`'s `checked_sub` underflowed to
    // 0 and silently under-credited stakers, permanently locking their share.
    //
    // With the prune removed, a reward denom can never be un-registered, so ACC is
    // monotonic and always dominates a staker's DEBT. This test drives the exact
    // pattern the old bug needed — build DEBT, then deposit the SAME denom again —
    // and shows accrual stays correct (no underflow, no lost value) across the
    // re-deposit.
    #[test]
    fn accrual_stays_correct_across_denom_redeposit() {
        let mut deps = setup();
        stake(&mut deps, "alice", 100, "uansem"); // total 100
        // First deposit of "dust": alice earns 100.
        deposit(&mut deps, "uansem", 100, "dust");
        // Claim settles and writes alice's DEBT for "dust" to storage — exactly the
        // per-staker debt the old prune left in place while zeroing ACC.
        execute(deps.as_mut(), mock_env(), mock_info("alice", &[]), ExecuteMsg::Claim { denom: "uansem".into() }).unwrap();
        assert!(pending(&deps, "uansem", "alice").is_empty()); // debt now == accumulated
        // A SECOND deposit of the very SAME denom. ACC keeps climbing from where it
        // was (never reset to 0), so `accumulated - debt` cannot underflow.
        deposit(&mut deps, "uansem", 100, "dust");
        // Alice is correctly owed the new 100. Under the removed prune-then-readd,
        // ACC would rebuild from 0 while her stale DEBT persisted, underflowing
        // `checked_sub` to 0 and silently locking her share.
        assert_eq!(pending(&deps, "uansem", "alice"), coins(100, "dust"));
        // And she can actually claim it — nothing is locked.
        let resp = execute(deps.as_mut(), mock_env(), mock_info("alice", &[]), ExecuteMsg::Claim { denom: "uansem".into() }).unwrap();
        assert!(resp.messages.iter().any(|m: &SubMsg| matches!(&m.msg,
            CosmosMsg::Bank(BankMsg::Send { to_address, amount })
                if to_address == "alice" && amount == &coins(100, "dust"))));
        assert!(pending(&deps, "uansem", "alice").is_empty());
    }

    // ── Fix 2: stake cooldown ───────────────────────────────────────────────
    #[test]
    fn cooldown_blocks_unstake_and_claim_until_aged() {
        let mut deps = setup_with_cooldown(100);
        // Stake at T0.
        let t0 = mock_env();
        execute(deps.as_mut(), t0.clone(), mock_info("alice", &coins(100, "uansem")), ExecuteMsg::Stake {}).unwrap();
        deposit(&mut deps, "uansem", 100, "uchanse");
        // Same block: both Unstake and Claim are gated.
        let err = execute(deps.as_mut(), t0.clone(), mock_info("alice", &[]), ExecuteMsg::Unstake { denom: "uansem".into(), amount: Uint128::new(50) }).unwrap_err();
        assert!(matches!(err, ContractError::Cooldown { .. }));
        let err = execute(deps.as_mut(), t0.clone(), mock_info("alice", &[]), ExecuteMsg::Claim { denom: "uansem".into() }).unwrap_err();
        assert!(matches!(err, ContractError::Cooldown { .. }));
        // After the cooldown elapses, both succeed.
        let mut later = mock_env();
        later.block.time = t0.block.time.plus_seconds(100);
        execute(deps.as_mut(), later.clone(), mock_info("alice", &[]), ExecuteMsg::Claim { denom: "uansem".into() }).unwrap();
        execute(deps.as_mut(), later, mock_info("alice", &[]), ExecuteMsg::Unstake { denom: "uansem".into(), amount: Uint128::new(100) }).unwrap();
    }

    #[test]
    fn cooldown_disabled_by_default() {
        // The default config (min_stake_seconds = 0) preserves the original
        // same-block stake/deposit/claim behavior.
        let mut deps = setup();
        stake(&mut deps, "alice", 100, "uansem");
        deposit(&mut deps, "uansem", 100, "uchanse");
        execute(deps.as_mut(), mock_env(), mock_info("alice", &[]), ExecuteMsg::Claim { denom: "uansem".into() }).unwrap();
    }

    // ── Fix 4: truncation remainder carried forward ─────────────────────────
    #[test]
    fn deposit_remainder_is_carried_forward() {
        let mut deps = setup();
        // Single staker of 3; three deposits of 1 that each truncate against 3.
        stake(&mut deps, "alice", 3, "uansem");
        deposit(&mut deps, "uansem", 1, "uchanse");
        deposit(&mut deps, "uansem", 1, "uchanse");
        deposit(&mut deps, "uansem", 1, "uchanse");
        // With the carried remainder, the lone staker is owed the full 3, not 2
        // (which is what plain per-deposit truncation would strand).
        assert_eq!(pending(&deps, "uansem", "alice"), coins(3, "uchanse"));
    }
}
