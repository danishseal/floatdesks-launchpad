//! Dynamic Fee Horn — a `before_swap` pricing Horn.
//!
//! Charges a lower swap fee to traders who stake $ANSEM in the Horn Vault, and
//! the normal fee to everyone else. This turns "hold/stake ANSEM" into a direct,
//! per-trade benefit — the token-utility side of the Horns thesis — using the
//! AMM's existing `OverrideFee` decision. Pure pricing: it takes no value and
//! composes cleanly with an `after_swap` reward Horn (via the Composite router).
//!
//! It answers the AMM's `before_swap` QUERY (synchronous, non-reentrant) with a
//! `HookDecision`. The AMM caps any hook fee at 1000 bps; we validate the same
//! at config time so a swap is never rejected for an over-cap fee mid-trade.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_binary, Addr, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult,
    Uint128,
};
use cw_storage_plus::Item;
use thiserror::Error;

const MAX_HOOK_FEE_BPS: u16 = 1000; // must match amm::hooks::MAX_HOOK_FEE_BPS
const ANSEM_DENOM: &str = "uansem";

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("fee bps must be <= {MAX_HOOK_FEE_BPS}")]
    FeeTooHigh {},
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

// ── Vault query (matches ansem-horn-vault) ──────────────────────────────────

#[cw_serde]
enum VaultQueryMsg {
    Stake { denom: String, staker: String },
}

#[cw_serde]
struct VaultStakeResponse {
    staked: Uint128,
}

// ── state ───────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    /// Horn Vault used to read a trader's ANSEM stake.
    pub vault: Addr,
    /// Fee for a trader with insufficient ANSEM staked.
    pub base_fee_bps: u16,
    /// Fee for a trader who meets `min_ansem_stake`.
    pub discount_fee_bps: u16,
    /// ANSEM (uansem, micro-units) a trader must have staked to earn the discount.
    pub min_ansem_stake: Uint128,
}

const CONFIG: Item<Config> = Item::new("config");

// ── messages ────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub vault: String,
    pub base_fee_bps: u16,
    pub discount_fee_bps: u16,
    pub min_ansem_stake: Uint128,
}

#[cw_serde]
pub enum ExecuteMsg {
    UpdateConfig {
        admin: Option<String>,
        vault: Option<String>,
        base_fee_bps: Option<u16>,
        discount_fee_bps: Option<u16>,
        min_ansem_stake: Option<Uint128>,
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
}

// ── entry points ────────────────────────────────────────────────────────────

fn check_fees(base: u16, disc: u16) -> Result<(), ContractError> {
    if base > MAX_HOOK_FEE_BPS || disc > MAX_HOOK_FEE_BPS {
        return Err(ContractError::FeeTooHigh {});
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
    cw2::set_contract_version(deps.storage, "ansem-horn-dynfee", env!("CARGO_PKG_VERSION"))?;
    check_fees(msg.base_fee_bps, msg.discount_fee_bps)?;
    CONFIG.save(
        deps.storage,
        &Config {
            admin: deps.api.addr_validate(&msg.admin)?,
            vault: deps.api.addr_validate(&msg.vault)?,
            base_fee_bps: msg.base_fee_bps,
            discount_fee_bps: msg.discount_fee_bps,
            min_ansem_stake: msg.min_ansem_stake,
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
        vault,
        base_fee_bps,
        discount_fee_bps,
        min_ansem_stake,
    } = msg;
    let mut cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    if let Some(a) = admin {
        cfg.admin = deps.api.addr_validate(&a)?;
    }
    if let Some(v) = vault {
        cfg.vault = deps.api.addr_validate(&v)?;
    }
    if let Some(b) = base_fee_bps {
        cfg.base_fee_bps = b;
    }
    if let Some(d) = discount_fee_bps {
        cfg.discount_fee_bps = d;
    }
    if let Some(m) = min_ansem_stake {
        cfg.min_ansem_stake = m;
    }
    check_fees(cfg.base_fee_bps, cfg.discount_fee_bps)?;
    CONFIG.save(deps.storage, &cfg)?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::BeforeSwap { ctx } => to_binary(&decide(deps, ctx)),
        QueryMsg::Config {} => to_binary(&CONFIG.load(deps.storage)?),
    }
}

/// The pricing decision: discounted fee if the trader has enough ANSEM staked,
/// otherwise the base fee. A failed Vault read defaults to "no discount" (base
/// fee) rather than erroring — a swap must never revert because the discount
/// lookup hiccuped.
fn decide(deps: Deps, ctx: SwapContext) -> HookDecision {
    let cfg = match CONFIG.load(deps.storage) {
        Ok(c) => c,
        Err(_) => return HookDecision::Proceed,
    };
    let staked = deps
        .querier
        .query_wasm_smart::<VaultStakeResponse>(
            cfg.vault.clone(),
            &VaultQueryMsg::Stake {
                denom: ANSEM_DENOM.to_string(),
                staker: ctx.sender.clone(),
            },
        )
        .map(|r| r.staked)
        .unwrap_or_default();
    let fee_bps = if staked >= cfg.min_ansem_stake {
        cfg.discount_fee_bps
    } else {
        cfg.base_fee_bps
    };
    HookDecision::OverrideFee { fee_bps }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};

    #[test]
    fn config_rejects_over_cap_fee() {
        let mut deps = mock_dependencies();
        let err = instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                vault: "vault".into(),
                base_fee_bps: 100,
                discount_fee_bps: 2000, // > 1000 cap
                min_ansem_stake: Uint128::new(1),
            },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::FeeTooHigh {}));
    }

    #[test]
    fn unstaked_trader_gets_base_fee() {
        // With no Vault available the query fails -> defaults to base fee, never panics.
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                vault: "vault".into(),
                base_fee_bps: 100,
                discount_fee_bps: 30,
                min_ansem_stake: Uint128::new(1_000_000),
            },
        )
        .unwrap();
        let ctx = SwapContext {
            token_address: "t".into(),
            sender: "trader".into(),
            offer_ansem: true,
            input_amount: Uint128::new(1000),
            ansem_reserve: Uint128::new(1_000_000),
            token_reserve: Uint128::new(1_000_000),
            default_fee_bps: 100,
        };
        assert_eq!(decide(deps.as_ref(), ctx), HookDecision::OverrideFee { fee_bps: 100 });
    }
}
