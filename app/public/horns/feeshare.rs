//! Fee-Share Horn — the default Horn a graduated pool "grows".
//!
//! The AMM skims a slice of each swap's fee (see the pool's `skim_bps`) and
//! forwards it to this Horn via the `after_swap` callback with the skimmed
//! coins attached. This Horn splits that value, by the pool's configured
//! ANSEM/CHANSE percentage, and routes it into the Horn Vault's two staking
//! sinks (`uansem` stakers and `uchanse` stakers) via `DepositReward`.
//!
//! Robustness: an `after_swap` failure reverts the whole swap, so this Horn must
//! never fail on a routine swap. It queries each Vault sink's stake first and
//! only deposits into sinks that HAVE stakers — an empty sink's share is
//! redirected to the other sink, or (if both are empty) retained in this Horn's
//! balance to be swept later by the permissionless `Flush`. So trading never
//! breaks on an empty sink.

use std::collections::BTreeMap;

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_binary, Addr, Binary, Coin, Deps, DepsMut, Env, MessageInfo, Reply, ReplyOn,
    Response, StdResult, SubMsg, Uint128, WasmMsg,
};
use cw_storage_plus::{Item, Map};
use thiserror::Error;

const ANSEM_SINK: &str = "uansem";
const CHANSE_SINK: &str = "uchanse";
const BPS: u128 = 10_000;

/// Reply id for the vault `DepositReward` submessages. They are dispatched with
/// `ReplyOn::Error` so that a broken or paused Vault cannot revert the swap that
/// triggered `after_swap`: on error the submessage's fund transfer is rolled
/// back, the skim STAYS retained in this Horn (exactly like the empty-sink path),
/// and a later `Flush` retries it. See the `reply` entry point.
const DEPOSIT_REPLY_ID: u64 = 1;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("bps must be <= 10000")]
    BadBps {},
}

// ── state ───────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    /// The AMM — the only address allowed to call `after_swap`.
    pub amm: Addr,
    /// The launchpad — allowed (with admin) to register a pool's split.
    pub launchpad: Addr,
    /// The Horn Vault this Horn deposits rewards into.
    pub vault: Addr,
    /// Fallback ANSEM-sink share (bps) for pools with no registered split.
    pub default_ansem_bps: u16,
}

const CONFIG: Item<Config> = Item::new("config");
/// Per-pool ANSEM-sink share in bps (CHANSE share = 10000 - this). Key: token_address.
const POOL_ANSEM_BPS: Map<&str, u16> = Map::new("pool_ansem_bps");

// ── messages ────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub amm: String,
    pub launchpad: String,
    pub vault: String,
    /// Default ANSEM-sink share in bps (e.g. 5000 = 50/50). CHANSE gets the rest.
    pub default_ansem_bps: u16,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// AMM callback — MUST match the AMM's `HookExecute::AfterSwap` shape. The
    /// skimmed fee coins arrive as attached funds.
    AfterSwap {
        token_address: String,
        sender: String,
        offer_ansem: bool,
        input_amount: Uint128,
        output_amount: Uint128,
        fee_amount: Uint128,
    },
    /// Set a pool's ANSEM/CHANSE split. Called by the launchpad at graduation
    /// (or the admin). CHANSE share is `10000 - ansem_bps`.
    RegisterPool { token_address: String, ansem_bps: u16 },
    /// Permissionless: sweep this Horn's retained balance (skims that had no
    /// eligible sink at the time) into the sinks by the default split.
    Flush {},
    UpdateConfig {
        admin: Option<String>,
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
}

#[cw_serde]
pub struct SplitResponse {
    pub ansem_bps: u16,
    pub chanse_bps: u16,
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
    cw2::set_contract_version(deps.storage, "ansem-horn-feeshare", env!("CARGO_PKG_VERSION"))?;
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
            default_ansem_bps: msg.default_ansem_bps,
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
        ExecuteMsg::AfterSwap { token_address, .. } => after_swap(deps, info, token_address),
        ExecuteMsg::RegisterPool {
            token_address,
            ansem_bps,
        } => register_pool(deps, info, token_address, ansem_bps),
        ExecuteMsg::Flush {} => flush(deps, env),
        ExecuteMsg::UpdateConfig {
            admin,
            default_ansem_bps,
        } => update_config(deps, info, admin, default_ansem_bps),
    }
}

/// Reply handler for the `DepositReward` submessages. They fire `ReplyOn::Error`
/// only, so this is reached solely when the Vault call failed. We deliberately
/// return Ok (swallowing the error) instead of propagating it: the failed
/// submessage — including its fund transfer — has already been rolled back, so
/// the skim remains in this Horn's balance and a later permissionless `Flush`
/// retries it. Propagating would revert the whole swap, which is the bug we are
/// fixing. Any other reply id is unexpected and errors loudly.
#[cfg_attr(not(feature = "library"), entry_point)]
pub fn reply(_deps: DepsMut, _env: Env, msg: Reply) -> Result<Response, ContractError> {
    if msg.id != DEPOSIT_REPLY_ID {
        return Err(ContractError::Std(cosmwasm_std::StdError::generic_err(
            format!("unexpected reply id {}", msg.id),
        )));
    }
    Ok(Response::new()
        .add_attribute("action", "deposit_reward_failed")
        .add_attribute("retained", "true"))
}

/// The AMM forwarded the skim (info.funds). Split by the pool's share and route
/// to whichever sinks currently have stakers.
fn after_swap(
    deps: DepsMut,
    info: MessageInfo,
    token_address: String,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.amm {
        return Err(ContractError::Unauthorized {});
    }
    if info.funds.is_empty() {
        // Nothing skimmed (e.g. a custom-curve swap) — nothing to do.
        return Ok(Response::new().add_attribute("action", "after_swap").add_attribute("skim", "0"));
    }
    let ansem_bps = POOL_ANSEM_BPS
        .may_load(deps.storage, &token_address)?
        .unwrap_or(cfg.default_ansem_bps) as u128;

    let msgs = route(&deps.as_ref(), &cfg, ansem_bps, &info.funds)?;
    Ok(Response::new()
        .add_submessages(msgs)
        .add_attribute("action", "after_swap")
        .add_attribute("token_address", token_address))
}

/// Sweep retained balance (skims parked when no sink was eligible) into the
/// sinks by the default split. Permissionless.
fn flush(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let bal = deps.querier.query_all_balances(&env.contract.address)?;
    if bal.is_empty() {
        return Ok(Response::new().add_attribute("action", "flush").add_attribute("swept", "0"));
    }
    let msgs = route(&deps.as_ref(), &cfg, cfg.default_ansem_bps as u128, &bal)?;
    Ok(Response::new().add_submessages(msgs).add_attribute("action", "flush"))
}

/// Split `funds` into the ANSEM sink (`ansem_bps`) and CHANSE sink (the rest),
/// redirecting an empty sink's share to the other, and building one
/// `DepositReward` per non-empty sink. Anything with no eligible sink is left in
/// this Horn's balance (a later Flush handles it). Never errors on a routine
/// swap, so `after_swap` cannot revert a trade because a sink is empty.
fn route(
    deps: &Deps,
    cfg: &Config,
    ansem_bps: u128,
    funds: &[Coin],
) -> Result<Vec<SubMsg>, ContractError> {
    // These queries never propagate an error (see `sink_has_stakers`): a Vault
    // that can't answer is treated as an empty sink, so a broken Vault can never
    // revert the swap — the skim is redirected or retained for a later Flush.
    let ansem_has = sink_has_stakers(deps, &cfg.vault, ANSEM_SINK);
    let chanse_has = sink_has_stakers(deps, &cfg.vault, CHANSE_SINK);

    // Merge target coins per sink by denom.
    let mut to_ansem: BTreeMap<String, Uint128> = BTreeMap::new();
    let mut to_chanse: BTreeMap<String, Uint128> = BTreeMap::new();

    for c in funds {
        if c.amount.is_zero() {
            continue;
        }
        let a = c.amount.u128() * ansem_bps / BPS;
        let ch = c.amount.u128() - a;
        // ANSEM share: ANSEM sink, else redirect to CHANSE, else retain.
        if a > 0 {
            if ansem_has {
                *to_ansem.entry(c.denom.clone()).or_default() += Uint128::new(a);
            } else if chanse_has {
                *to_chanse.entry(c.denom.clone()).or_default() += Uint128::new(a);
            }
        }
        // CHANSE share: CHANSE sink, else redirect to ANSEM, else retain.
        if ch > 0 {
            if chanse_has {
                *to_chanse.entry(c.denom.clone()).or_default() += Uint128::new(ch);
            } else if ansem_has {
                *to_ansem.entry(c.denom.clone()).or_default() += Uint128::new(ch);
            }
        }
    }

    let mut msgs = vec![];
    if let Some(m) = deposit_msg(&cfg.vault, ANSEM_SINK, to_ansem)? {
        msgs.push(m);
    }
    if let Some(m) = deposit_msg(&cfg.vault, CHANSE_SINK, to_chanse)? {
        msgs.push(m);
    }
    Ok(msgs)
}

fn deposit_msg(
    vault: &Addr,
    sink: &str,
    coins: BTreeMap<String, Uint128>,
) -> Result<Option<SubMsg>, ContractError> {
    let funds: Vec<Coin> = coins
        .into_iter()
        .filter(|(_, a)| !a.is_zero())
        .map(|(denom, amount)| Coin { denom, amount })
        .collect();
    if funds.is_empty() {
        return Ok(None);
    }
    let exec = WasmMsg::Execute {
        contract_addr: vault.to_string(),
        msg: to_binary(&VaultExecuteMsg::DepositReward {
            sink: sink.to_string(),
        })?,
        funds,
    };
    // ReplyOn::Error: if the Vault rejects/panics, the submessage (and its fund
    // transfer) rolls back and `reply` swallows the error, so the swap that fired
    // `after_swap` still commits and the skim stays retained here for a Flush.
    Ok(Some(SubMsg {
        id: DEPOSIT_REPLY_ID,
        msg: exec.into(),
        gas_limit: None,
        reply_on: ReplyOn::Error,
    }))
}

/// Does `denom`'s sink currently have stakers? Queries the Vault, but NEVER
/// propagates a query failure: a broken or mid-migration Vault that can't answer
/// must not revert the live swap that fired `after_swap`. On any query error we
/// treat the sink as empty, so its share is either redirected to the other sink
/// or retained in this Horn for a later `Flush` — exactly the empty-sink path.
/// That upholds the "a broken Vault cannot revert the swap" guarantee.
fn sink_has_stakers(deps: &Deps, vault: &Addr, denom: &str) -> bool {
    match deps.querier.query_wasm_smart::<VaultSinkResponse>(
        vault,
        &VaultQueryMsg::Sink {
            denom: denom.to_string(),
        },
    ) {
        Ok(resp) => !resp.total_staked.is_zero(),
        Err(_) => false,
    }
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
    default_ansem_bps: Option<u16>,
) -> Result<Response, ContractError> {
    let mut cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    if let Some(a) = admin {
        cfg.admin = deps.api.addr_validate(&a)?;
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

// ── queries ─────────────────────────────────────────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info, MockQuerier};
    use cosmwasm_std::{
        coins, from_binary, ContractResult, CosmosMsg, OwnedDeps, SubMsgResult, SystemResult,
        WasmQuery,
    };

    type Deps_ = OwnedDeps<cosmwasm_std::MemoryStorage, cosmwasm_std::testing::MockApi, MockQuerier>;

    /// A vault-sink querier: reports `ansem_staked`/`chanse_staked` for the two
    /// sinks so `sink_has_stakers` sees whichever sinks we want populated.
    fn deps_with_stakes(ansem_staked: u128, chanse_staked: u128) -> Deps_ {
        let mut deps = mock_dependencies();
        deps.querier.update_wasm(move |q| match q {
            WasmQuery::Smart { msg, .. } => {
                let parsed: VaultQueryMsg = from_binary(msg).unwrap();
                let VaultQueryMsg::Sink { denom } = parsed;
                let staked = if denom == ANSEM_SINK {
                    ansem_staked
                } else {
                    chanse_staked
                };
                SystemResult::Ok(ContractResult::Ok(
                    to_binary(&VaultSinkResponse {
                        stake_denom: denom,
                        total_staked: Uint128::new(staked),
                        reward_denoms: vec![],
                    })
                    .unwrap(),
                ))
            }
            _ => SystemResult::Ok(ContractResult::Err("unexpected".into())),
        });
        deps
    }

    fn init(deps: &mut Deps_, default_ansem_bps: u16) {
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                amm: "amm".into(),
                launchpad: "launchpad".into(),
                vault: "vault".into(),
                default_ansem_bps,
            },
        )
        .unwrap();
    }

    /// Decode a DepositReward SubMsg into (reply_on, sink, funds).
    fn decode(sub: &SubMsg) -> (ReplyOn, String, Vec<Coin>) {
        match &sub.msg {
            CosmosMsg::Wasm(WasmMsg::Execute { msg, funds, .. }) => {
                let VaultExecuteMsg::DepositReward { sink } = from_binary(msg).unwrap();
                (sub.reply_on.clone(), sink, funds.clone())
            }
            _ => panic!("not a wasm execute"),
        }
    }

    fn after_swap_call(deps: &mut Deps_, sender: &str, funds: &[Coin]) -> Result<Response, ContractError> {
        execute(
            deps.as_mut(),
            mock_env(),
            mock_info(sender, funds),
            ExecuteMsg::AfterSwap {
                token_address: "token".into(),
                sender: "trader".into(),
                offer_ansem: true,
                input_amount: Uint128::new(1),
                output_amount: Uint128::new(1),
                fee_amount: Uint128::new(1),
            },
        )
    }

    // ── auth gate ───────────────────────────────────────────────────────────
    #[test]
    fn after_swap_rejects_non_amm() {
        let mut deps = deps_with_stakes(1, 1);
        init(&mut deps, 5000);
        let err = after_swap_call(&mut deps, "not_amm", &coins(100, "uchanse")).unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));
    }

    // ── route: both sinks populated -> split by bps, each a ReplyOn::Error SubMsg
    #[test]
    fn route_splits_and_is_reply_on_error() {
        let mut deps = deps_with_stakes(1, 1);
        init(&mut deps, 6000); // 60% ANSEM / 40% CHANSE
        let resp = after_swap_call(&mut deps, "amm", &coins(100, "uchanse")).unwrap();
        assert_eq!(resp.messages.len(), 2);
        for sub in &resp.messages {
            let (reply_on, sink, funds) = decode(sub);
            // Fix 3: every vault deposit is dispatched ReplyOn::Error.
            assert_eq!(reply_on, ReplyOn::Error);
            assert_eq!(sub.id, DEPOSIT_REPLY_ID);
            let amt = funds[0].amount.u128();
            if sink == ANSEM_SINK {
                assert_eq!(amt, 60);
            } else {
                assert_eq!(amt, 40);
            }
        }
    }

    // ── route: empty sink redirected to the other ────────────────────────────
    #[test]
    fn route_redirects_empty_sink() {
        let mut deps = deps_with_stakes(0, 1); // ANSEM empty, CHANSE has stakers
        init(&mut deps, 6000);
        let resp = after_swap_call(&mut deps, "amm", &coins(100, "uchanse")).unwrap();
        // Both shares collapse into the one live (CHANSE) sink -> a single deposit of 100.
        assert_eq!(resp.messages.len(), 1);
        let (reply_on, sink, funds) = decode(&resp.messages[0]);
        assert_eq!(reply_on, ReplyOn::Error);
        assert_eq!(sink, CHANSE_SINK);
        assert_eq!(funds[0].amount.u128(), 100);
    }

    // ── route: both empty -> retain (no messages, swap still commits) ────────
    #[test]
    fn route_retains_when_both_sinks_empty() {
        let mut deps = deps_with_stakes(0, 0);
        init(&mut deps, 5000);
        let resp = after_swap_call(&mut deps, "amm", &coins(100, "uchanse")).unwrap();
        assert!(resp.messages.is_empty(), "nothing routed; skim retained for Flush");
    }

    // ── Re-audit: a failing Vault query must NOT revert the swap ─────────────
    // Previously `sink_has_stakers` propagated its `query_wasm_smart` error with
    // `?`, so a broken or mid-migration Vault (query fails) reverted the live swap
    // via `after_swap` — contradicting the "a broken Vault cannot revert the swap"
    // guarantee. Now a failing query is treated as an empty sink, so the swap
    // commits and the skim is retained here for a later Flush.
    #[test]
    fn after_swap_survives_failing_vault_query() {
        let mut deps = mock_dependencies();
        // A Vault whose Sink query fails outright (e.g. mid-migration / paused).
        deps.querier.update_wasm(|q| match q {
            WasmQuery::Smart { .. } => {
                SystemResult::Ok(ContractResult::Err("vault migrating".into()))
            }
            _ => SystemResult::Ok(ContractResult::Err("unexpected".into())),
        });
        init(&mut deps, 5000);
        // after_swap must SUCCEED (no revert) despite both vault queries failing.
        let resp = after_swap_call(&mut deps, "amm", &coins(100, "uchanse")).unwrap();
        // Both sinks read as empty -> nothing routed, skim retained for a Flush.
        assert!(
            resp.messages.is_empty(),
            "failing vault query retains the skim; it must not revert the swap"
        );
    }

    // ── Flush sweeps the retained balance ────────────────────────────────────
    #[test]
    fn flush_sweeps_retained_balance() {
        let mut deps = deps_with_stakes(1, 1);
        init(&mut deps, 5000);
        // Give the Horn a retained balance to sweep.
        deps.querier
            .update_balance(mock_env().contract.address, coins(200, "uchanse"));
        let resp = execute(deps.as_mut(), mock_env(), mock_info("anyone", &[]), ExecuteMsg::Flush {}).unwrap();
        // 50/50 split -> 100 to each sink, both ReplyOn::Error.
        assert_eq!(resp.messages.len(), 2);
        for sub in &resp.messages {
            let (reply_on, _sink, funds) = decode(sub);
            assert_eq!(reply_on, ReplyOn::Error);
            assert_eq!(funds[0].amount.u128(), 100);
        }
    }

    #[test]
    fn flush_on_empty_balance_is_noop() {
        let mut deps = deps_with_stakes(1, 1);
        init(&mut deps, 5000);
        let resp = execute(deps.as_mut(), mock_env(), mock_info("anyone", &[]), ExecuteMsg::Flush {}).unwrap();
        assert!(resp.messages.is_empty());
    }

    // ── reply: a failed vault deposit is swallowed, not propagated ───────────
    #[test]
    fn reply_swallows_deposit_error() {
        let mut deps = deps_with_stakes(1, 1);
        init(&mut deps, 5000);
        // ReplyOn::Error means reply only fires on failure; swallowing it lets the
        // swap commit while the skim stays retained.
        let msg = Reply {
            id: DEPOSIT_REPLY_ID,
            result: SubMsgResult::Err("vault paused".into()),
        };
        let resp = reply(deps.as_mut(), mock_env(), msg).unwrap();
        assert!(resp.messages.is_empty());
        assert!(resp
            .attributes
            .iter()
            .any(|a| a.key == "retained" && a.value == "true"));
    }

    #[test]
    fn reply_rejects_unknown_id() {
        let mut deps = deps_with_stakes(1, 1);
        init(&mut deps, 5000);
        let msg = Reply { id: 999, result: SubMsgResult::Err("x".into()) };
        assert!(reply(deps.as_mut(), mock_env(), msg).is_err());
    }

    // ── register_pool auth gate ─────────────────────────────────────────────
    #[test]
    fn register_pool_requires_launchpad_or_admin() {
        let mut deps = deps_with_stakes(1, 1);
        init(&mut deps, 5000);
        let bad = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("stranger", &[]),
            ExecuteMsg::RegisterPool { token_address: "token".into(), ansem_bps: 5000 },
        )
        .unwrap_err();
        assert!(matches!(bad, ContractError::Unauthorized {}));
        // launchpad may register.
        execute(
            deps.as_mut(),
            mock_env(),
            mock_info("launchpad", &[]),
            ExecuteMsg::RegisterPool { token_address: "token".into(), ansem_bps: 7000 },
        )
        .unwrap();
        let s: SplitResponse = from_binary(
            &query(deps.as_ref(), mock_env(), QueryMsg::PoolSplit { token_address: "token".into() }).unwrap(),
        )
        .unwrap();
        assert_eq!(s.ansem_bps, 7000);
        assert_eq!(s.chanse_bps, 3000);
    }
}
