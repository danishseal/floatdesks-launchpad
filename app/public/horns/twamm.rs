//! TWAMM Horn — time-weighted long orders executed in slices against the AMM.
//!
//! A trader parks a large buy as a resting order ("spend this CHANSE/ANSEM on
//! the token, evenly, over the next N seconds"). Anyone may then call `Advance`
//! on that order: the Horn works out how much of the order should have executed
//! since the last tick (`time_elapsed / total_duration` of the whole order),
//! market-buys exactly that slice off the AMM, and forwards the bought token to
//! the order's owner in the same transaction. Slicing across time is what keeps
//! a whale-sized order from moving the price in one shot — the point of a TWAMM.
//!
//! This is the **executable** TWAMM (a keeper Horn), not an in-curve one: it sits
//! beside the pool and drives the AMM's own public `Swap`, so it needs no changes
//! to the swap hot path and can't wedge it. Because it *holds funds and owes
//! execution*, it is an "owing" Horn: it must run standalone and cannot be nested
//! behind the Composite (which only combines value-earning read/observe Horns).
//!
//! `Advance` is permissionless and idempotent per-tick (advancing twice in one
//! block is a no-op the second time). Each order may set `min_out_per_quote` as a
//! limit-price floor; if the AMM can't meet it for the slice, that `Advance`
//! reverts cleanly and stays retryable, so the keeper never sells below the floor.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_binary, Addr, BankMsg, Binary, Coin, CosmosMsg, Deps, DepsMut, Env,
    MessageInfo, Order as StoreOrder, Reply, Response, StdResult, SubMsg, SubMsgResult, Uint128,
    WasmMsg,
};
use cw_storage_plus::{Item, Map};
use thiserror::Error;

/// Scale for the `min_out_per_quote` limit price (token micro-units per quote
/// micro-unit, times 1e6). e.g. 500_000 => at least 0.5 token per 1 quote.
const PRICE_SCALE: u128 = 1_000_000;
const REPLY_ADVANCE: u64 = 1;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("must attach exactly the quote denom {denom}")]
    BadFunds { denom: String },
    #[error("duration must be > 0")]
    ZeroDuration {},
    #[error("order not found")]
    NoOrder {},
    #[error("nothing to advance yet")]
    NothingToAdvance {},
    #[error("no advance in flight")]
    NoPending {},
}

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    /// The graduation AMM (the swap venue).
    pub amm: Addr,
    /// The CW20 token this Horn buys.
    pub token_address: Addr,
    /// The quote denom spent (uchanse | uansem).
    pub quote_denom: String,
}

/// A resting time-weighted buy order.
#[cw_serde]
pub struct Order {
    pub id: u64,
    pub owner: Addr,
    /// Total quote committed for the whole order.
    pub quote_total: Uint128,
    /// Quote already spent across executed slices.
    pub quote_sold: Uint128,
    /// Unix seconds the order started and ends.
    pub start: u64,
    pub end: u64,
    /// Last tick the order was advanced to (unix seconds).
    pub last_advance: u64,
    /// Optional limit-price floor: min token out per 1 quote in, times 1e6.
    pub min_out_per_quote: Option<Uint128>,
}

/// Snapshot taken across the swap SubMsg so the reply can credit the exact fill.
#[cw_serde]
struct Pending {
    order_id: u64,
    owner: Addr,
    balance_before: Uint128,
}

const CONFIG: Item<Config> = Item::new("config");
const ORDERS: Map<u64, Order> = Map::new("orders");
const NEXT_ID: Item<u64> = Item::new("next_id");
const PENDING: Item<Pending> = Item::new("pending");

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub amm: String,
    pub token_address: String,
    pub quote_denom: String,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Park a buy order: attach the quote denom; it is spent evenly over
    /// `duration_seconds`, buying the token. Optional `min_out_per_quote` floor.
    SubmitOrder {
        duration_seconds: u64,
        min_out_per_quote: Option<Uint128>,
    },
    /// PERMISSIONLESS: execute the slice of `order_id` accrued since its last tick.
    Advance { order_id: u64 },
    /// Owner-only: cancel and refund the unspent quote.
    CancelOrder { order_id: u64 },
    UpdateConfig { admin: Option<String>, amm: Option<String> },
}

/// Mirror of the AMM's public swap.
#[cw_serde]
enum AmmExecuteMsg {
    Swap {
        token_address: String,
        offer_ansem: bool,
        min_output: Uint128,
    },
}

#[cw_serde]
enum Cw20ExecuteMsg {
    Transfer { recipient: String, amount: Uint128 },
}
#[cw_serde]
enum Cw20QueryMsg {
    Balance { address: String },
}
#[cw_serde]
struct BalanceResponse {
    balance: Uint128,
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(Config)]
    Config {},
    #[returns(Order)]
    Order { order_id: u64 },
    #[returns(OrdersResponse)]
    Orders { start_after: Option<u64>, limit: Option<u32> },
}

#[cw_serde]
pub struct OrdersResponse {
    pub orders: Vec<Order>,
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    cw2::set_contract_version(deps.storage, "ansem-horn-twamm", env!("CARGO_PKG_VERSION"))?;
    CONFIG.save(
        deps.storage,
        &Config {
            admin: deps.api.addr_validate(&msg.admin)?,
            amm: deps.api.addr_validate(&msg.amm)?,
            token_address: deps.api.addr_validate(&msg.token_address)?,
            quote_denom: msg.quote_denom,
        },
    )?;
    NEXT_ID.save(deps.storage, &0)?;
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
        ExecuteMsg::SubmitOrder { duration_seconds, min_out_per_quote } => {
            submit_order(deps, env, info, duration_seconds, min_out_per_quote)
        }
        ExecuteMsg::Advance { order_id } => advance(deps, env, order_id),
        ExecuteMsg::CancelOrder { order_id } => cancel_order(deps, info, order_id),
        ExecuteMsg::UpdateConfig { admin, amm } => update_config(deps, info, admin, amm),
    }
}

fn submit_order(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    duration_seconds: u64,
    min_out_per_quote: Option<Uint128>,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if duration_seconds == 0 {
        return Err(ContractError::ZeroDuration {});
    }
    let quote_total: Uint128 = info
        .funds
        .iter()
        .filter(|c| c.denom == cfg.quote_denom)
        .map(|c| c.amount)
        .sum();
    // Reject stray denoms or an empty order outright.
    if quote_total.is_zero() || info.funds.iter().any(|c| c.denom != cfg.quote_denom) {
        return Err(ContractError::BadFunds { denom: cfg.quote_denom });
    }
    let id = NEXT_ID.load(deps.storage)?;
    NEXT_ID.save(deps.storage, &(id + 1))?;
    let now = env.block.time.seconds();
    let order = Order {
        id,
        owner: info.sender,
        quote_total,
        quote_sold: Uint128::zero(),
        start: now,
        end: now + duration_seconds,
        last_advance: now,
        min_out_per_quote,
    };
    ORDERS.save(deps.storage, id, &order)?;
    Ok(Response::new()
        .add_attribute("action", "submit_order")
        .add_attribute("order_id", id.to_string())
        .add_attribute("quote_total", quote_total))
}

fn advance(deps: DepsMut, env: Env, order_id: u64) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let mut order = ORDERS.may_load(deps.storage, order_id)?.ok_or(ContractError::NoOrder {})?;

    let now = env.block.time.seconds();
    let tick = now.min(order.end);
    if tick <= order.last_advance {
        return Err(ContractError::NothingToAdvance {});
    }
    let window = order.end - order.start; // > 0 (duration checked at submit)
    let elapsed = tick - order.last_advance;
    // Slice = time_elapsed / total_duration of the WHOLE order, capped at what's left.
    let mut chunk = order.quote_total.multiply_ratio(elapsed as u128, window as u128);
    let remaining = order.quote_total - order.quote_sold;
    if chunk > remaining {
        chunk = remaining;
    }

    order.last_advance = tick;

    // Slice rounds to zero (very short elapsed vs long window): just move the
    // clock. Close the order once fully spent or past its end.
    if chunk.is_zero() {
        finalize(deps, order)?;
        return Ok(Response::new()
            .add_attribute("action", "advance")
            .add_attribute("order_id", order_id.to_string())
            .add_attribute("chunk", "0"));
    }

    order.quote_sold += chunk;
    let owner = order.owner.clone();
    // Keep the record until the fill lands; the reply removes it once spent.
    ORDERS.save(deps.storage, order_id, &order)?;

    // Snapshot token balance so the reply can measure the exact fill.
    let before = token_balance(deps.as_ref(), &cfg, &env)?;
    PENDING.save(
        deps.storage,
        &Pending { order_id, owner, balance_before: before },
    )?;

    let min_output = match order.min_out_per_quote {
        Some(p) => chunk.multiply_ratio(p, Uint128::new(PRICE_SCALE)),
        None => Uint128::zero(),
    };

    let swap = SubMsg::reply_on_success(
        CosmosMsg::Wasm(WasmMsg::Execute {
            contract_addr: cfg.amm.to_string(),
            msg: to_binary(&AmmExecuteMsg::Swap {
                token_address: cfg.token_address.to_string(),
                offer_ansem: true,
                min_output,
            })?,
            funds: vec![Coin { denom: cfg.quote_denom.clone(), amount: chunk }],
        }),
        REPLY_ADVANCE,
    );

    Ok(Response::new()
        .add_submessage(swap)
        .add_attribute("action", "advance")
        .add_attribute("order_id", order_id.to_string())
        .add_attribute("chunk", chunk))
}

/// Remove an order that is spent or expired; called when a tick produced no slice.
fn finalize(deps: DepsMut, order: Order) -> Result<(), ContractError> {
    if order.quote_sold >= order.quote_total {
        ORDERS.remove(deps.storage, order.id);
    } else {
        ORDERS.save(deps.storage, order.id, &order)?;
    }
    Ok(())
}

fn cancel_order(
    deps: DepsMut,
    info: MessageInfo,
    order_id: u64,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let order = ORDERS.may_load(deps.storage, order_id)?.ok_or(ContractError::NoOrder {})?;
    if info.sender != order.owner {
        return Err(ContractError::Unauthorized {});
    }
    ORDERS.remove(deps.storage, order_id);
    let refund = order.quote_total - order.quote_sold;
    let mut res = Response::new()
        .add_attribute("action", "cancel_order")
        .add_attribute("order_id", order_id.to_string())
        .add_attribute("refund", refund);
    if !refund.is_zero() {
        res = res.add_message(CosmosMsg::Bank(BankMsg::Send {
            to_address: order.owner.to_string(),
            amount: vec![Coin { denom: cfg.quote_denom, amount: refund }],
        }));
    }
    Ok(res)
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
pub fn reply(deps: DepsMut, env: Env, msg: Reply) -> Result<Response, ContractError> {
    if msg.id != REPLY_ADVANCE {
        return Ok(Response::new());
    }
    // reply_on_success: only reached when the swap succeeded.
    if let SubMsgResult::Err(e) = msg.result {
        return Err(ContractError::Std(cosmwasm_std::StdError::generic_err(e)));
    }
    let cfg = CONFIG.load(deps.storage)?;
    let pending = PENDING.may_load(deps.storage)?.ok_or(ContractError::NoPending {})?;
    PENDING.remove(deps.storage);

    let after = token_balance(deps.as_ref(), &cfg, &env)?;
    let filled = after.checked_sub(pending.balance_before).unwrap_or_default();

    // If this tick spent the order out, drop it now that the fill has landed.
    if let Some(order) = ORDERS.may_load(deps.storage, pending.order_id)? {
        if order.quote_sold >= order.quote_total {
            ORDERS.remove(deps.storage, pending.order_id);
        }
    }

    let mut res = Response::new()
        .add_attribute("action", "advance_fill")
        .add_attribute("order_id", pending.order_id.to_string())
        .add_attribute("filled", filled);
    if !filled.is_zero() {
        res = res.add_message(CosmosMsg::Wasm(WasmMsg::Execute {
            contract_addr: cfg.token_address.to_string(),
            msg: to_binary(&Cw20ExecuteMsg::Transfer {
                recipient: pending.owner.to_string(),
                amount: filled,
            })?,
            funds: vec![],
        }));
    }
    Ok(res)
}

fn token_balance(deps: Deps, cfg: &Config, env: &Env) -> StdResult<Uint128> {
    let r: BalanceResponse = deps.querier.query_wasm_smart(
        cfg.token_address.clone(),
        &Cw20QueryMsg::Balance { address: env.contract.address.to_string() },
    )?;
    Ok(r.balance)
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::Order { order_id } => to_binary(&ORDERS.load(deps.storage, order_id)?),
        QueryMsg::Orders { start_after, limit } => {
            let limit = limit.unwrap_or(30).min(100) as usize;
            let start = start_after.map(cw_storage_plus::Bound::exclusive);
            let orders: Vec<Order> = ORDERS
                .range(deps.storage, start, None, StoreOrder::Ascending)
                .take(limit)
                .map(|r| r.map(|(_, o)| o))
                .collect::<StdResult<_>>()?;
            to_binary(&OrdersResponse { orders })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
    use cosmwasm_std::{from_binary, ContractResult, SystemResult, WasmQuery};

    fn init() -> cosmwasm_std::OwnedDeps<
        cosmwasm_std::MemoryStorage,
        cosmwasm_std::testing::MockApi,
        cosmwasm_std::testing::MockQuerier,
    > {
        let mut deps = mock_dependencies();
        // Mock the CW20 token: report a zero balance for the snapshot query.
        deps.querier.update_wasm(|q| match q {
            WasmQuery::Smart { msg, .. } => {
                let _: Cw20QueryMsg = from_binary(msg).unwrap();
                SystemResult::Ok(ContractResult::Ok(
                    to_binary(&BalanceResponse { balance: Uint128::zero() }).unwrap(),
                ))
            }
            _ => SystemResult::Ok(ContractResult::Ok(Binary::default())),
        });
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                amm: "amm".into(),
                token_address: "token".into(),
                quote_denom: "uchanse".into(),
            },
        )
        .unwrap();
        deps
    }

    #[test]
    fn submit_rejects_wrong_denom() {
        let mut deps = init();
        let err = submit_order(
            deps.as_mut(),
            mock_env(),
            mock_info("whale", &[Coin { denom: "uatom".into(), amount: Uint128::new(100) }]),
            3600,
            None,
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::BadFunds { .. }));
    }

    #[test]
    fn advance_slices_proportional_to_time() {
        let mut deps = init();
        let mut env = mock_env();
        let t0 = env.block.time.seconds();
        // 1000 quote over 1000s => 1 quote/sec.
        submit_order(
            deps.as_mut(),
            env.clone(),
            mock_info("whale", &[Coin { denom: "uchanse".into(), amount: Uint128::new(1000) }]),
            1000,
            None,
        )
        .unwrap();

        // 100s later: should slice 100 quote.
        env.block.time = env.block.time.plus_seconds(100);
        let res = advance(deps.as_mut(), env.clone(), 0).unwrap();
        let chunk = res.attributes.iter().find(|a| a.key == "chunk").unwrap();
        assert_eq!(chunk.value, "100");
        // One swap SubMsg went out.
        assert_eq!(res.messages.len(), 1);

        let order = ORDERS.load(deps.as_ref().storage, 0).unwrap();
        assert_eq!(order.quote_sold, Uint128::new(100));
        assert_eq!(order.last_advance, t0 + 100);

        // Advancing again in the same block is a no-op.
        let err = advance(deps.as_mut(), env, 0).unwrap_err();
        assert!(matches!(err, ContractError::NothingToAdvance {}));
    }

    #[test]
    fn advance_caps_at_end_and_min_output_floor() {
        let mut deps = init();
        let mut env = mock_env();
        submit_order(
            deps.as_mut(),
            env.clone(),
            mock_info("whale", &[Coin { denom: "uchanse".into(), amount: Uint128::new(1000) }]),
            1000,
            // floor: at least 2 token per 1 quote => min_output = chunk * 2.
            Some(Uint128::new(2 * PRICE_SCALE)),
        )
        .unwrap();
        // Way past the end: the whole 1000 must slice at once, never more.
        env.block.time = env.block.time.plus_seconds(5000);
        let res = advance(deps.as_mut(), env, 0).unwrap();
        let chunk = res.attributes.iter().find(|a| a.key == "chunk").unwrap();
        assert_eq!(chunk.value, "1000");
        // The order is spent; it stays recorded until the reply fill lands.
        let order = ORDERS.load(deps.as_ref().storage, 0).unwrap();
        assert_eq!(order.quote_sold, Uint128::new(1000));
    }

    #[test]
    fn cancel_refunds_unspent() {
        let mut deps = init();
        let env = mock_env();
        submit_order(
            deps.as_mut(),
            env,
            mock_info("whale", &[Coin { denom: "uchanse".into(), amount: Uint128::new(1000) }]),
            1000,
            None,
        )
        .unwrap();
        let res = cancel_order(deps.as_mut(), mock_info("whale", &[]), 0).unwrap();
        // Full refund (nothing spent yet) as a bank send.
        assert_eq!(res.messages.len(), 1);
        assert!(ORDERS.may_load(deps.as_ref().storage, 0).unwrap().is_none());
    }

    #[test]
    fn cancel_rejects_non_owner() {
        let mut deps = init();
        let env = mock_env();
        submit_order(
            deps.as_mut(),
            env,
            mock_info("whale", &[Coin { denom: "uchanse".into(), amount: Uint128::new(1000) }]),
            1000,
            None,
        )
        .unwrap();
        let err = cancel_order(deps.as_mut(), mock_info("thief", &[]), 0).unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
    }
}
