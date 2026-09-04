//! Floor / Buyback Bid Wall Horn.
//!
//! Banks a slice of every swap's fee (the AMM skim, delivered as funds on
//! `after_swap`) into an **unwithdrawable treasury** in this contract, then lets
//! anyone call `Support` to spend that treasury market-buying the token off the
//! AMM and **locking it here forever**. That is a standing, only-ever-ratcheting
//! bid under the token — buyback-and-support as an on-chain property, with no
//! admin withdrawal path.
//!
//! Why buyback rather than "pay the seller at the floor": a `before_swap` query
//! can't move funds in CosmWasm, and the AMM's `Delta` pays from the POOL, not
//! from this Horn. Executing a real buyback with the banked treasury achieves
//! the same economic support and is fully on-chain. `Support` is PERMISSIONLESS,
//! so anyone (a keeper, a holder) can fire the bid; the treasury and the bought
//! tokens can never leave.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_binary, Addr, Binary, Coin, CosmosMsg, Deps, DepsMut, Env, MessageInfo,
    Response, StdResult, Uint128, WasmMsg,
};
use cw_storage_plus::Item;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("empty treasury")]
    Empty {},
}

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    /// The AMM (only it may call `after_swap`; also the buyback venue).
    pub amm: Addr,
    /// The CW20 token this Horn supports.
    pub token_address: Addr,
    /// The pool's quote denom (uchanse | uansem) — the treasury/buyback currency.
    pub quote_denom: String,
}

const CONFIG: Item<Config> = Item::new("config");
/// Cumulative quote ever banked (for display; the live balance is the spendable one).
const BANKED: Item<Uint128> = Item::new("banked");

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub amm: String,
    pub token_address: String,
    pub quote_denom: String,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// AMM callback — matches `amm::hooks::HookExecute::AfterSwap`. The skim
    /// arrives as attached funds and simply accumulates in the treasury.
    AfterSwap {
        token_address: String,
        sender: String,
        offer_ansem: bool,
        input_amount: Uint128,
        output_amount: Uint128,
        fee_amount: Uint128,
    },
    /// PERMISSIONLESS: spend up to `max_spend` (default: whole balance) of the
    /// quote treasury market-buying the token off the AMM; the bought tokens are
    /// locked here forever.
    Support { max_spend: Option<Uint128> },
    UpdateConfig {
        admin: Option<String>,
        amm: Option<String>,
    },
}

/// Mirror of the AMM's `Swap` for the buyback.
#[cw_serde]
enum AmmExecuteMsg {
    Swap {
        token_address: String,
        offer_ansem: bool,
        min_output: Uint128,
    },
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
    /// Spendable quote currency held (the live buyback war-chest).
    pub quote_balance: Uint128,
    /// Tokens bought and permanently locked here.
    pub token_locked: Uint128,
    /// Cumulative quote ever banked.
    pub banked_total: Uint128,
}

#[cw_serde]
enum Cw20QueryMsg {
    Balance { address: String },
}
#[cw_serde]
struct BalanceResponse {
    balance: Uint128,
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    cw2::set_contract_version(deps.storage, "ansem-horn-floor", env!("CARGO_PKG_VERSION"))?;
    CONFIG.save(
        deps.storage,
        &Config {
            admin: deps.api.addr_validate(&msg.admin)?,
            amm: deps.api.addr_validate(&msg.amm)?,
            token_address: deps.api.addr_validate(&msg.token_address)?,
            quote_denom: msg.quote_denom,
        },
    )?;
    BANKED.save(deps.storage, &Uint128::zero())?;
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
        ExecuteMsg::AfterSwap { .. } => after_swap(deps, info),
        ExecuteMsg::Support { max_spend } => support(deps, env, max_spend),
        ExecuteMsg::UpdateConfig { admin, amm } => update_config(deps, info, admin, amm),
    }
}

fn after_swap(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.amm {
        return Err(ContractError::Unauthorized {});
    }
    // The skim already landed as attached funds; just record the banked total.
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
    Ok(Response::new()
        .add_attribute("action", "after_swap")
        .add_attribute("banked", added))
}

fn support(
    deps: DepsMut,
    env: Env,
    max_spend: Option<Uint128>,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let bal = deps
        .querier
        .query_balance(&env.contract.address, &cfg.quote_denom)?
        .amount;
    if bal.is_zero() {
        return Err(ContractError::Empty {});
    }
    let spend = match max_spend {
        Some(m) if m < bal => m,
        _ => bal,
    };
    if spend.is_zero() {
        return Err(ContractError::Empty {});
    }
    // Market-buy the token; output CW20 is transferred to this contract and
    // locked. min_output 0: it's a support buy, and the trigger is permissionless.
    let buy = CosmosMsg::Wasm(WasmMsg::Execute {
        contract_addr: cfg.amm.to_string(),
        msg: to_binary(&AmmExecuteMsg::Swap {
            token_address: cfg.token_address.to_string(),
            offer_ansem: true,
            min_output: Uint128::zero(),
        })?,
        funds: vec![Coin {
            denom: cfg.quote_denom.clone(),
            amount: spend,
        }],
    });
    Ok(Response::new()
        .add_message(buy)
        .add_attribute("action", "support")
        .add_attribute("spend", spend))
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
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::Treasury {} => {
            let cfg = CONFIG.load(deps.storage)?;
            let quote_balance = deps
                .querier
                .query_balance(&env.contract.address, &cfg.quote_denom)?
                .amount;
            let token_locked = deps
                .querier
                .query_wasm_smart::<BalanceResponse>(
                    cfg.token_address,
                    &Cw20QueryMsg::Balance {
                        address: env.contract.address.to_string(),
                    },
                )
                .map(|r| r.balance)
                .unwrap_or_default();
            to_binary(&TreasuryResponse {
                quote_balance,
                token_locked,
                banked_total: BANKED.may_load(deps.storage)?.unwrap_or_default(),
            })
        }
    }
}
