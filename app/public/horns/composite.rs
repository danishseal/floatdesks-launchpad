//! Composite Horn — run several Horns on one pool.
//!
//! Registers as the pool's single hook and fans each AMM callback out to its
//! children: `before_swap` (a query) is asked of every child that declares it
//! and the results are combined into one `HookDecision`; `after_swap` (an
//! execute) is forwarded to every child that declares it, with the skimmed funds
//! handed to the first such child (the reward Horn). This is what lets, say, the
//! Dynamic Fee Horn (before_swap) and the Fee-Share Horn (after_swap) both run
//! on one graduated pool.
//!
//! Trust chain: the real AMM trusts this Composite (it's the pool's hook), and
//! each CHILD is configured with THIS contract as its `amm`, so a child accepts
//! the Composite as its caller. AMM → Composite → children.
//!
//! Combination rules (ported from Vector's composite): a child `Reject` rejects
//! the swap; at most one child may return a `Delta` (a second is a conflict);
//! conflicting `OverrideFee` values are a conflict; a `Delta` (custom curve)
//! prices the swap and any fee overrides are ignored. Only value-earning
//! children compose cleanly — an "owing" Horn (e.g. TWAMM) must run solo.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_binary, Addr, Binary, CosmosMsg, Deps, DepsMut, Env, MessageInfo, Response,
    StdResult, Uint128, WasmMsg,
};
use cw_storage_plus::Item;
use thiserror::Error;

const BEFORE_SWAP: u16 = 1 << 0;
const AFTER_SWAP: u16 = 1 << 1;
const MAX_CHILDREN: usize = 4;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("at most {MAX_CHILDREN} children")]
    TooManyChildren {},
    #[error("a child declares no swap callbacks")]
    EmptyChildFlags {},
}

// ── mirrors of amm::hooks (serialize identically) ───────────────────────────

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

#[cw_serde]
enum HookQuery {
    BeforeSwap { ctx: SwapContext },
}

/// The AfterSwap payload — matches `amm::hooks::HookExecute::AfterSwap`, used
/// both to receive from the AMM and to forward to children.
#[cw_serde]
enum HornExecuteMsg {
    AfterSwap {
        token_address: String,
        sender: String,
        offer_ansem: bool,
        input_amount: Uint128,
        output_amount: Uint128,
        fee_amount: Uint128,
    },
}

// ── state ───────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct Child {
    pub address: Addr,
    /// Which swap callbacks this child implements (BEFORE_SWAP | AFTER_SWAP).
    pub flags: u16,
}

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    /// The real AMM — the only caller allowed to invoke `after_swap`.
    pub amm: Addr,
    pub children: Vec<Child>,
}

const CONFIG: Item<Config> = Item::new("config");

#[cw_serde]
pub struct ChildInput {
    pub address: String,
    pub flags: u16,
}

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub amm: String,
    pub children: Vec<ChildInput>,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// AMM callback (matches HookExecute::AfterSwap). Forwarded to after_swap
    /// children; the skim funds go to the first such child.
    AfterSwap {
        token_address: String,
        sender: String,
        offer_ansem: bool,
        input_amount: Uint128,
        output_amount: Uint128,
        fee_amount: Uint128,
    },
    SetChildren { children: Vec<ChildInput> },
    UpdateConfig { admin: Option<String>, amm: Option<String> },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(HookDecision)]
    BeforeSwap { ctx: SwapContext },
    #[returns(Config)]
    Config {},
    /// The union of children's swap flags — what the pool's HookConfig.flags
    /// should be set to when installing this Composite.
    #[returns(FlagsResponse)]
    Flags {},
}

#[cw_serde]
pub struct FlagsResponse {
    pub flags: u16,
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn validate_children(
    deps: &DepsMut,
    input: Vec<ChildInput>,
) -> Result<Vec<Child>, ContractError> {
    if input.len() > MAX_CHILDREN {
        return Err(ContractError::TooManyChildren {});
    }
    input
        .into_iter()
        .map(|c| {
            if c.flags & (BEFORE_SWAP | AFTER_SWAP) == 0 {
                return Err(ContractError::EmptyChildFlags {});
            }
            Ok(Child {
                address: deps.api.addr_validate(&c.address)?,
                flags: c.flags,
            })
        })
        .collect()
}

fn union_flags(children: &[Child]) -> u16 {
    children
        .iter()
        .fold(0u16, |acc, c| acc | (c.flags & (BEFORE_SWAP | AFTER_SWAP)))
}

// ── entry points ────────────────────────────────────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    cw2::set_contract_version(deps.storage, "ansem-horn-composite", env!("CARGO_PKG_VERSION"))?;
    let children = validate_children(&deps, msg.children)?;
    CONFIG.save(
        deps.storage,
        &Config {
            admin: deps.api.addr_validate(&msg.admin)?,
            amm: deps.api.addr_validate(&msg.amm)?,
            children,
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
    match msg {
        ExecuteMsg::AfterSwap {
            token_address,
            sender,
            offer_ansem,
            input_amount,
            output_amount,
            fee_amount,
        } => after_swap(
            deps,
            info,
            token_address,
            sender,
            offer_ansem,
            input_amount,
            output_amount,
            fee_amount,
        ),
        ExecuteMsg::SetChildren { children } => set_children(deps, info, children),
        ExecuteMsg::UpdateConfig { admin, amm } => update_config(deps, info, admin, amm),
    }
}

#[allow(clippy::too_many_arguments)]
fn after_swap(
    deps: DepsMut,
    info: MessageInfo,
    token_address: String,
    sender: String,
    offer_ansem: bool,
    input_amount: Uint128,
    output_amount: Uint128,
    fee_amount: Uint128,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.amm {
        return Err(ContractError::Unauthorized {});
    }
    let mut msgs = vec![];
    let mut first = true;
    for child in cfg.children.iter().filter(|c| c.flags & AFTER_SWAP != 0) {
        // The reward child (first with AFTER_SWAP) receives the skimmed funds;
        // any additional after_swap children are called as observers.
        let funds = if first { info.funds.clone() } else { vec![] };
        first = false;
        msgs.push(CosmosMsg::Wasm(WasmMsg::Execute {
            contract_addr: child.address.to_string(),
            msg: to_binary(&HornExecuteMsg::AfterSwap {
                token_address: token_address.clone(),
                sender: sender.clone(),
                offer_ansem,
                input_amount,
                output_amount,
                fee_amount,
            })?,
            funds,
        }));
    }
    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "after_swap"))
}

fn set_children(
    deps: DepsMut,
    info: MessageInfo,
    children: Vec<ChildInput>,
) -> Result<Response, ContractError> {
    let mut cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    cfg.children = validate_children(&deps, children)?;
    CONFIG.save(deps.storage, &cfg)?;
    Ok(Response::new().add_attribute("action", "set_children"))
}

fn update_config(
    deps: DepsMut,
    info: MessageInfo,
    admin: Option<String>,
    amm: Option<String>,
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
    CONFIG.save(deps.storage, &cfg)?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::BeforeSwap { ctx } => to_binary(&combine_before_swap(deps, ctx)?),
        QueryMsg::Config {} => to_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::Flags {} => {
            let cfg = CONFIG.load(deps.storage)?;
            to_binary(&FlagsResponse {
                flags: union_flags(&cfg.children),
            })
        }
    }
}

/// Ask every before_swap child and combine. A child error propagates (a broken
/// composed Horn must not be silently skipped, matching the AMM's own policy).
fn combine_before_swap(deps: Deps, ctx: SwapContext) -> StdResult<HookDecision> {
    let cfg = CONFIG.load(deps.storage)?;
    let mut fee_override: Option<u16> = None;
    let mut delta: Option<(Uint128, Uint128)> = None;

    for child in cfg.children.iter().filter(|c| c.flags & BEFORE_SWAP != 0) {
        let d: HookDecision = deps
            .querier
            .query_wasm_smart(child.address.clone(), &HookQuery::BeforeSwap { ctx: ctx.clone() })?;
        match d {
            HookDecision::Proceed => {}
            HookDecision::Reject { reason } => return Ok(HookDecision::Reject { reason }),
            HookDecision::Delta { amount_in, amount_out } => {
                if delta.is_some() {
                    return Ok(HookDecision::Reject {
                        reason: "multiple curve Horns on one pool".into(),
                    });
                }
                delta = Some((amount_in, amount_out));
            }
            HookDecision::OverrideFee { fee_bps } => match fee_override {
                Some(f) if f != fee_bps => {
                    return Ok(HookDecision::Reject {
                        reason: "conflicting fee overrides".into(),
                    })
                }
                _ => fee_override = Some(fee_bps),
            },
        }
    }

    Ok(if let Some((amount_in, amount_out)) = delta {
        // A custom-curve child prices the swap; fee overrides are subsumed.
        HookDecision::Delta { amount_in, amount_out }
    } else if let Some(fee_bps) = fee_override {
        HookDecision::OverrideFee { fee_bps }
    } else {
        HookDecision::Proceed
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
    use cosmwasm_std::Coin;

    fn setup(children: Vec<ChildInput>) -> cosmwasm_std::OwnedDeps<
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
                amm: "amm".into(),
                children,
            },
        )
        .unwrap();
        deps
    }

    #[test]
    fn flags_are_union_masked_to_swap() {
        let deps = setup(vec![
            ChildInput { address: "dynfee".into(), flags: BEFORE_SWAP },
            ChildInput { address: "feeshare".into(), flags: AFTER_SWAP },
        ]);
        let cfg = CONFIG.load(deps.as_ref().storage).unwrap();
        assert_eq!(union_flags(&cfg.children), BEFORE_SWAP | AFTER_SWAP);
    }

    #[test]
    fn rejects_empty_child_flags() {
        let mut deps = mock_dependencies();
        let err = instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                amm: "amm".into(),
                children: vec![ChildInput { address: "x".into(), flags: 0 }],
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::EmptyChildFlags {});
    }

    #[test]
    fn rejects_too_many_children() {
        let mut deps = mock_dependencies();
        let err = instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                amm: "amm".into(),
                children: (0..5)
                    .map(|i| ChildInput { address: format!("child{i}"), flags: BEFORE_SWAP })
                    .collect(),
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::TooManyChildren {});
    }

    #[test]
    fn after_swap_routes_funds_to_first_child_only() {
        let mut deps = setup(vec![
            ChildInput { address: "reward".into(), flags: AFTER_SWAP },
            ChildInput { address: "observer".into(), flags: AFTER_SWAP },
        ]);
        let skim = vec![Coin { denom: "uchanse".into(), amount: Uint128::new(500) }];
        let res = after_swap(
            deps.as_mut(),
            mock_info("amm", &skim),
            "token".into(),
            "trader".into(),
            true,
            Uint128::new(1000),
            Uint128::new(900),
            Uint128::new(30),
        )
        .unwrap();
        assert_eq!(res.messages.len(), 2);
        // First child gets the funds; the observer gets none.
        if let CosmosMsg::Wasm(WasmMsg::Execute { contract_addr, funds, .. }) = &res.messages[0].msg {
            assert_eq!(contract_addr, "reward");
            assert_eq!(funds, &skim);
        } else {
            panic!("expected wasm execute");
        }
        if let CosmosMsg::Wasm(WasmMsg::Execute { contract_addr, funds, .. }) = &res.messages[1].msg {
            assert_eq!(contract_addr, "observer");
            assert!(funds.is_empty());
        } else {
            panic!("expected wasm execute");
        }
    }

    #[test]
    fn after_swap_rejects_non_amm_caller() {
        let mut deps = setup(vec![ChildInput { address: "reward".into(), flags: AFTER_SWAP }]);
        let err = after_swap(
            deps.as_mut(),
            mock_info("attacker", &[]),
            "token".into(),
            "trader".into(),
            true,
            Uint128::new(1000),
            Uint128::new(900),
            Uint128::new(30),
        )
        .unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
    }
}
