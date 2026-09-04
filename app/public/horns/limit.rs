//! Limit-Order Book Horn — resting maker orders filled out of an incoming swap
//! before it reaches the AMM.
//!
//! ╔══════════════════════════════════════════════════════════════════════════╗
//! ║  REGISTER THIS HORN WITH ZERO HOOK FLAGS ON THE POOL.                     ║
//! ║                                                                          ║
//! ║  This contract is a STANDALONE router (`SwapThroughBook`), not a live    ║
//! ║  AMM hook. Its blended taker quote is served ONLY through the non-hook   ║
//! ║  `QueryMsg::QuoteThroughBook` query. It deliberately does NOT expose a   ║
//! ║  `HookQuery::BeforeSwap { ctx }`-shaped query, so the AMM's              ║
//! ║  `before_swap` hook call cannot reach the blended quote: if a deployer   ║
//! ║  mistakenly sets the pool's `BEFORE_SWAP` flag to this address, the      ║
//! ║  hook query fails to deserialize and the swap FAILS CLOSED (no LP is     ║
//! ║  paid) rather than draining the pool to the taker. See Fix 2 below.      ║
//! ╚══════════════════════════════════════════════════════════════════════════╝
//!
//! A maker escrows funds in this contract and names a price (`PlaceBuyOrder` /
//! `PlaceSellOrder`). A taker's swap is offered to the book first, and any order
//! priced *better than the pool's marginal price* fills first. The taker gets an
//! execution at least as good as the pool alone, the maker gets filled without
//! watching a screen, and only the residual reaches the pool. This is the ANSEM
//! port of Vector's `limit-vector`.
//!
//! # The two guarantees (identical to the Solana original)
//!
//! **A taker never does worse than the pool alone.** An order only fills if its
//! price beats the pool's *marginal* price (computed from `ctx` reserves) at the
//! moment of the swap, and the unfilled remainder still trades against the pool.
//! Marginal, not average, on purpose: a large swap must not drag the average
//! below an order's limit and fill it at a price the maker never agreed to.
//!
//! **A maker never fills below their limit.** The price stored on the order is a
//! floor on what they receive; every rounding step rounds toward the maker.
//!
//! # The settlement adaptation (READ THIS — it is the load-bearing difference)
//!
//! Vector's `before_swap` is an *instruction*: it mutates the order accounts and
//! returns a *partial* delta (`specified_delta`) that absorbs only the filled
//! slice, leaving the rest for the pool. Neither of those is available here:
//!
//!   1. **`before_swap` is a read-only QUERY.** A CosmWasm query cannot move
//!      escrow or decrement an order. It can only *return a price*.
//!   2. **The AMM's `Delta` is all-or-nothing and sources value from the POOL.**
//!      `amm::hooks::before_swap` requires `amount_in == whole offered input`
//!      (no partial absorption) and pays `amount_out` entirely out of the pool's
//!      reserves. It never touches this contract's escrow. (This is the same
//!      constraint the Floor Horn documents: "the AMM's `Delta` pays from the
//!      POOL, not from this Horn.")
//!
//! So the fill is split across the two things each mechanism *can* do, exactly
//! the way `horn-twamm` splits "decide" from "execute":
//!
//! * **`QuoteThroughBook` (query) — the taker-facing quote / guarantee.** It
//!   matches the incoming swap against the book, prices the book-matched portion
//!   at the makers' better limits and the residual on the pool's constant-product
//!   curve, and returns a single blended `Delta{amount_in: whole, amount_out:
//!   book_out + pool_out}`. That output is `>= pool-only`, so the taker is never
//!   worse off. It falls back to `Proceed` whenever no order improves on the
//!   pool (or the input is degenerate). Because a query cannot settle makers,
//!   this path has the POOL front the improvement, so it is a QUOTE ONLY: it is
//!   NOT a live AMM hook and must never be wired as one.
//!
//! * **Fix 2 — the quote is not the AMM hook interface.** The AMM asks a live
//!   `BEFORE_SWAP` hook with `HookQuery::BeforeSwap { ctx }` and then pays
//!   `amount_out` out of POOL reserves. This Horn cannot debit maker escrow from
//!   a query, so if that blended `Delta` were reachable through the AMM hook
//!   interface it would drain LP to the taker (the "reconciliation companion"
//!   does not exist). To make that impossible the blended quote is served ONLY
//!   through `QueryMsg::QuoteThroughBook` — a variant whose JSON tag
//!   (`quote_through_book`) does NOT match the AMM's `before_swap`. There is no
//!   `BeforeSwap`-shaped, value-bearing query on this contract at all, so a
//!   misconfigured `BEFORE_SWAP` registration fails closed instead of paying out.
//!
//! * **`SwapThroughBook` (execute + reply) — the real, backed settlement.** Like
//!   `horn-twamm`'s `Advance`, the taker routes their swap *through this Horn*.
//!   The Horn pays the book-matched token to the taker straight out of maker
//!   escrow, credits each filled maker their proceeds (claimable, withdrawn with
//!   `Claim`), forwards the residual to the AMM's public `Swap`, and a reply
//!   measures the pool fill and forwards it to the taker. Real funds move, both
//!   guarantees hold, and no pool value leaks. This is the mechanism; the
//!   `before_swap` query is its read-only shadow.
//!
//! Like `horn-twamm` this is therefore an **executable ("owing") Horn**: it holds
//! escrow and owes fills, so it runs standalone rather than nested behind the
//! read-only Composite.
//!
//! # Limitations (documented on purpose)
//!
//! * `SwapThroughBook` is implemented for the **quote-in (buy-token) direction**
//!   only — the same direction `horn-twamm` executes and the same one the AMM
//!   settles natively through attached funds. It fills resting **sell-token**
//!   orders. The symmetric token-in router that would settle **buy-token** orders
//!   is left unbuilt (it needs the CW20-receive swap path).
//! * **Fix 3 — `PlaceBuyOrder` is disabled.** Because no on-chain path fills a
//!   buy order (only sells settle), escrowing quote in a buy order would strand
//!   the maker's funds with no way to be filled — only cancel. Rather than let
//!   users strand funds, `PlaceBuyOrder` is REJECTED
//!   (`ContractError::BuyOrdersDisabled`) until the token-in router exists. The
//!   `Side::BuyToken` type, the buy-side matching core, and the buy-side quote
//!   are retained (direction-symmetric) for that future router; today no buy
//!   order can be created, so the buy side of the book is always empty.
//! * **Fix 1 — the working set is bounded.** Order selection is fed by a
//!   price-ordered secondary index (best price first) capped at
//!   `MAX_CANDIDATES` orders and stopping as soon as orders stop beating the
//!   pool, spent (`remaining == 0`) orders are pruned from that index eagerly,
//!   and every order must escrow at least `MIN_ORDER_ESCROW`. So a flood of dust
//!   orders can neither be created cheaply nor force `match_book` /
//!   `SwapThroughBook` to walk an unbounded book. This also makes selection
//!   strictly best-price-first within the cap, tightening the old id-order walk.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, from_slice, to_binary, Addr, BankMsg, Binary, Coin, CosmosMsg, Deps, DepsMut, Env,
    MessageInfo, Order as StoreOrder, Reply, Response, StdResult, SubMsg, SubMsgResult, Uint128,
    Uint256, WasmMsg,
};
use cw_storage_plus::{Bound, Item, Map};
use thiserror::Error;

/// Price scale: an order price is quote micro-units per token micro-unit, times
/// 1e6. So `quote_value = token * price / PRICE_SCALE`. e.g. price 2_000_000 =>
/// 2 quote per 1 token.
const PRICE_SCALE: u128 = 1_000_000;
const REPLY_SWAP: u64 = 1;

/// Fix 1 — DoS bound. The router / quote never loads more than this many resting
/// orders into the working set. The book is walked through a price-ordered index
/// (best price first) and stops as soon as orders stop beating the pool, so this
/// cap only ever bites a genuine flood, never a normally-sized book.
const MAX_CANDIDATES: usize = 64;

/// Fix 1 — anti-spam floor. Every order must escrow at least this much of the
/// maker's asset (SellToken → token micro-units; BuyToken → quote micro-units).
/// Dust orders are how a flood is made cheap; a floor makes each resting order
/// cost real, escrowed value (still fully refundable via `CancelOrder`).
const MIN_ORDER_ESCROW: Uint128 = Uint128::new(1_000_000);

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("{0}")]
    Overflow(#[from] cosmwasm_std::OverflowError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("must attach exactly the quote denom {denom}")]
    BadFunds { denom: String },
    #[error("price must be > 0")]
    ZeroPrice {},
    #[error("order amount must be > 0")]
    ZeroAmount {},
    #[error("order escrow {got} is below the minimum {min}")]
    EscrowTooSmall { got: Uint128, min: Uint128 },
    #[error("buy orders are disabled: no on-chain path fills them yet, so quote would be stranded (cancel-only)")]
    BuyOrdersDisabled {},
    #[error("order not found")]
    NoOrder {},
    #[error("wrong token for this book")]
    WrongToken {},
    #[error("no book fill improved on the pool and no funds routed")]
    NothingFilled {},
    #[error("slippage: got {got}, wanted at least {min}")]
    Slippage { got: Uint128, min: Uint128 },
    #[error("no swap in flight")]
    NoPending {},
}

/// Which side of the book an order sits on, described from the maker's view.
#[cw_serde]
pub enum Side {
    /// Maker escrows the CW20 token and wants quote for it. Fills a taker who is
    /// BUYING the token (an `offer_ansem` swap). `price` is the maker's ask:
    /// the minimum quote they accept per token. Beats the pool when `price` is
    /// *below* the pool's marginal quote-per-token.
    SellToken,
    /// Maker escrows quote and wants the token. Fills a taker who is SELLING the
    /// token. `price` is the maker's bid: the maximum quote they pay per token.
    /// Beats the pool when `price` is *above* the pool's marginal price.
    BuyToken,
}

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    /// The graduation AMM (the residual venue and, for the router, the swap
    /// target).
    pub amm: Addr,
    /// The CW20 token this book trades.
    pub token_address: Addr,
    /// The quote denom (uchanse | uansem).
    pub quote_denom: String,
}

/// A resting limit order.
#[cw_serde]
pub struct Order {
    pub id: u64,
    pub owner: Addr,
    pub side: Side,
    /// Quote micro-units per token micro-unit, times `PRICE_SCALE`.
    pub price: Uint128,
    /// Escrowed and not yet spent, in the asset the maker put up
    /// (SellToken: token; BuyToken: quote).
    pub remaining: Uint128,
    /// Bought and not yet withdrawn, in the asset the maker wants
    /// (SellToken: quote; BuyToken: token).
    pub claimable: Uint128,
}

/// Snapshot carried across the router's AMM SubMsg so the reply can credit the
/// exact pool fill to the taker.
#[cw_serde]
struct Pending {
    taker: Addr,
    /// Token already paid to the taker out of the book, this call.
    book_out: Uint128,
    /// Horn token balance before the pool swap (excludes the book payment, which
    /// is a top-level message that runs after the reply).
    balance_before: Uint128,
    min_output: Uint128,
}

const CONFIG: Item<Config> = Item::new("config");
const ORDERS: Map<u64, Order> = Map::new("orders");
const NEXT_ID: Item<u64> = Item::new("next_id");
const PENDING: Item<Pending> = Item::new("pending");

/// Fix 1 — price-ordered secondary indexes over the *active* (remaining > 0)
/// orders, keyed `(price, id)`. `u128` keys sort big-endian, i.e. numerically,
/// so ascending iteration is best-ask-first for sells and descending iteration
/// is best-bid-first for buys. Spent orders are removed here (but kept in
/// `ORDERS` until claimed), so candidate selection never walks dead weight.
const SELL_INDEX: Map<(u128, u64), ()> = Map::new("sell_idx");
const BUY_INDEX: Map<(u128, u64), ()> = Map::new("buy_idx");

// ── messages ────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub amm: String,
    pub token_address: String,
    pub quote_denom: String,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Rest a bid: attach the quote denom; `price` is the max quote paid per
    /// token. Escrows the attached quote.
    PlaceBuyOrder { price: Uint128 },
    /// CW20 hook target — the token contract calls this on `Send`. Rests an ask
    /// escrowing the sent tokens (see `ReceiveHook::PlaceSellOrder`).
    Receive(Cw20ReceiveMsg),
    /// Owner-only: cancel an order and refund the unspent escrow.
    CancelOrder { order_id: u64 },
    /// Owner-only: withdraw an order's filled proceeds (and drop it if fully
    /// spent).
    Claim { order_id: u64 },
    /// PERMISSIONLESS taker entry: buy the token with attached quote, filling
    /// resting sell orders that beat the pool first and routing the residual to
    /// the AMM. This is the backed settlement path.
    SwapThroughBook { min_output: Uint128 },
    UpdateConfig { admin: Option<String>, amm: Option<String> },
}

#[cw_serde]
pub struct Cw20ReceiveMsg {
    pub sender: String,
    pub amount: Uint128,
    pub msg: Binary,
}

#[cw_serde]
pub enum ReceiveHook {
    /// Rest an ask: the tokens just sent are escrowed; `price` is the min quote
    /// accepted per token.
    PlaceSellOrder { price: Uint128 },
}

/// Mirror of the AMM's public swap (quote-in direction).
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

// ── AMM hook interface (serializes identically to `amm::hooks`) ──────────────

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

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    /// Fix 2 — the taker-facing blended quote. Returns a blended `Delta`
    /// (book + pool) when the book improves on pool-only, else `Proceed`.
    ///
    /// This is deliberately NOT named `BeforeSwap`: its JSON tag
    /// (`quote_through_book`) does not match the AMM's `HookQuery::BeforeSwap`,
    /// so this value-bearing quote can never be reached through the live AMM
    /// hook interface. It is a quote for callers/UIs and for a Horn that owns
    /// settlement — not a pool hook. See the module banner.
    #[returns(HookDecision)]
    QuoteThroughBook { ctx: SwapContext },
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

// ── pure matching core (shared by the query and the router) ──────────────────

/// One order's participation in a fill.
#[derive(Debug, Clone, PartialEq)]
struct Fill {
    order_id: u64,
    /// Taker's input asset consumed by this order.
    take_in: Uint128,
    /// Taker's output asset paid by this order (out of maker escrow).
    give_out: Uint128,
}

fn u256(x: Uint128) -> Uint256 {
    Uint256::from(x)
}
fn scale() -> Uint256 {
    Uint256::from(PRICE_SCALE)
}
fn to_u128(x: Uint256) -> Uint128 {
    Uint128::try_from(x).unwrap_or(Uint128::MAX)
}

/// quote = ceil(token * price / SCALE). Ceil so the maker is never underpaid.
fn quote_for_token_ceil(token: Uint128, price: Uint128) -> Uint128 {
    if token.is_zero() {
        return Uint128::zero();
    }
    let n = u256(token) * u256(price);
    to_u128((n + scale() - Uint256::one()) / scale())
}

/// token = floor(quote * SCALE / price). Floor so the maker never overpays.
fn token_for_quote_floor(quote: Uint128, price: Uint128) -> Uint128 {
    if price.is_zero() {
        return Uint128::zero();
    }
    to_u128(u256(quote) * scale() / u256(price))
}

/// quote = floor(token * price / SCALE). Floor so a BuyToken maker never pays
/// above their limit.
fn quote_for_token_floor(token: Uint128, price: Uint128) -> Uint128 {
    to_u128(u256(token) * u256(price) / scale())
}

/// The pool's marginal quote-per-token, scaled by `PRICE_SCALE`.
/// `ansem_reserve / token_reserve` is the spot price of the token in quote.
fn pool_marginal_price(ansem_reserve: Uint128, token_reserve: Uint128) -> Option<Uint128> {
    if token_reserve.is_zero() {
        return None;
    }
    Some(to_u128(u256(ansem_reserve) * scale() / u256(token_reserve)))
}

/// Constant-product output, mirroring `amm::calculate_swap_output` (fee taken
/// off the input first). Returns 0 for any degenerate case.
fn cp_out(in_reserve: Uint128, out_reserve: Uint128, input: Uint128, fee_bps: u16) -> Uint128 {
    if input.is_zero() || in_reserve.is_zero() || out_reserve.is_zero() {
        return Uint128::zero();
    }
    let fee = u256(input) * Uint256::from(fee_bps as u128) / Uint256::from(10_000u128);
    let iaf = u256(input) - fee;
    let denom = u256(in_reserve) + iaf;
    if denom.is_zero() {
        return Uint128::zero();
    }
    let out = u256(out_reserve) * iaf / denom;
    if out >= u256(out_reserve) {
        return Uint128::zero();
    }
    to_u128(out)
}

/// Walk the book and match `input` against every order that beats the pool.
///
/// `orders` is the candidate set already filtered to the taker's opposite side.
/// Returns the per-order fills plus running totals. Read-only: it mutates
/// nothing, so both the query and the router share it.
fn match_book(
    orders: &[Order],
    mut input: Uint128,
    offer_ansem: bool,
    pool_price: Option<Uint128>,
) -> (Vec<Fill>, Uint128, Uint128, Uint128) {
    let mut fills = Vec::new();
    let mut book_in = Uint128::zero();
    let mut book_out = Uint128::zero();

    for order in orders {
        if input.is_zero() {
            break;
        }
        if order.remaining.is_zero() {
            continue;
        }
        // Must beat the pool, or the taker is better off without it. A pool with
        // no price (empty reserves) is beaten by any resting order.
        if let Some(pp) = pool_price {
            let better = if offer_ansem {
                order.price < pp // ask below spot: taker pays less quote per token
            } else {
                order.price > pp // bid above spot: taker gets more quote per token
            };
            if !better {
                continue;
            }
        }
        if order.price.is_zero() {
            continue;
        }

        let (take_in, give_out) = if offer_ansem {
            // Taker gives quote, order pays token from its escrow.
            // Cap the token paid by the order's escrow and by what the remaining
            // quote can buy at this price.
            let by_input = token_for_quote_floor(input, order.price);
            let give_out = order.remaining.min(by_input);
            if give_out.is_zero() {
                continue;
            }
            let mut take_in = quote_for_token_ceil(give_out, order.price);
            if take_in > input {
                take_in = input;
            }
            (take_in, give_out)
        } else {
            // Taker gives token, order pays quote from its escrow.
            // Cap the token taken by what the order's quote escrow can buy.
            let by_escrow = token_for_quote_floor(order.remaining, order.price);
            let take_in = input.min(by_escrow);
            if take_in.is_zero() {
                continue;
            }
            let give_out = quote_for_token_floor(take_in, order.price);
            if give_out.is_zero() || give_out > order.remaining {
                continue;
            }
            (take_in, give_out)
        };

        input -= take_in;
        book_in += take_in;
        book_out += give_out;
        fills.push(Fill { order_id: order.id, take_in, give_out });
    }

    (fills, book_in, book_out, input)
}

/// The `(price, id)` index key for an order.
fn index_key(order: &Order) -> (u128, u64) {
    (order.price.u128(), order.id)
}

/// Add an active order to its side's price index.
fn index_add(storage: &mut dyn cosmwasm_std::Storage, order: &Order) -> StdResult<()> {
    match order.side {
        Side::SellToken => SELL_INDEX.save(storage, index_key(order), &()),
        Side::BuyToken => BUY_INDEX.save(storage, index_key(order), &()),
    }
}

/// Remove an order from its side's price index (idempotent — a no-op if absent).
fn index_remove(storage: &mut dyn cosmwasm_std::Storage, order: &Order) {
    match order.side {
        Side::SellToken => SELL_INDEX.remove(storage, index_key(order)),
        Side::BuyToken => BUY_INDEX.remove(storage, index_key(order)),
    }
}

/// Fix 1 — the bounded candidate set on the side that opposes `offer_ansem`.
///
/// Walks the price index best-price-first, takes at most `MAX_CANDIDATES`
/// orders, and STOPS as soon as an order no longer beats the pool (the index is
/// price-ordered, so every later order is worse and cannot beat it either). The
/// index only ever holds active orders, so spent orders are never loaded. This
/// is what makes a dust flood unable to blow the gas budget of the router or the
/// quote: the working set is O(`MAX_CANDIDATES`), not O(book).
fn candidate_orders(
    deps: Deps,
    offer_ansem: bool,
    pool_price: Option<Uint128>,
) -> StdResult<Vec<Order>> {
    let mut out: Vec<Order> = Vec::new();
    // taker buying token (offer_ansem) fills SELL orders, ascending ask;
    // taker selling token fills BUY orders, descending bid.
    let (index, order_dir) = if offer_ansem {
        (&SELL_INDEX, StoreOrder::Ascending)
    } else {
        (&BUY_INDEX, StoreOrder::Descending)
    };
    for item in index.range(deps.storage, None, None, order_dir) {
        let ((price, id), _) = item?;
        if let Some(pp) = pool_price {
            let price = Uint128::new(price);
            // Best-price-first: the first order that fails to beat the pool ends
            // the walk, because every subsequent order is priced no better.
            let beats = if offer_ansem { price < pp } else { price > pp };
            if !beats {
                break;
            }
        }
        out.push(ORDERS.load(deps.storage, id)?);
        if out.len() >= MAX_CANDIDATES {
            break;
        }
    }
    Ok(out)
}

// ── entry points ────────────────────────────────────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    cw2::set_contract_version(deps.storage, "ansem-horn-limit", env!("CARGO_PKG_VERSION"))?;
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
        ExecuteMsg::PlaceBuyOrder { price } => place_buy_order(deps, info, price),
        ExecuteMsg::Receive(cw20) => receive(deps, info, cw20),
        ExecuteMsg::CancelOrder { order_id } => cancel_order(deps, info, order_id),
        ExecuteMsg::Claim { order_id } => claim(deps, info, order_id),
        ExecuteMsg::SwapThroughBook { min_output } => {
            swap_through_book(deps, env, info, min_output)
        }
        ExecuteMsg::UpdateConfig { admin, amm } => update_config(deps, info, admin, amm),
    }
}

/// Fix 3 — DISABLED. No on-chain path fills a buy order (only sells settle
/// through `SwapThroughBook`), so escrowing quote here would strand the maker's
/// funds with no fill — only cancel. Rather than let users strand funds, this is
/// rejected outright until the token-in router exists. The `Side::BuyToken` type
/// and the buy-side matching/quote are kept for that future router.
fn place_buy_order(
    _deps: DepsMut,
    _info: MessageInfo,
    _price: Uint128,
) -> Result<Response, ContractError> {
    Err(ContractError::BuyOrdersDisabled {})
}

fn receive(
    deps: DepsMut,
    info: MessageInfo,
    cw20: Cw20ReceiveMsg,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    // Only the book's own token contract may fund a sell order.
    if info.sender != cfg.token_address {
        return Err(ContractError::WrongToken {});
    }
    let ReceiveHook::PlaceSellOrder { price } = from_slice(&cw20.msg)?;
    if price.is_zero() {
        return Err(ContractError::ZeroPrice {});
    }
    if cw20.amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }
    // Fix 1 — anti-spam escrow floor.
    if cw20.amount < MIN_ORDER_ESCROW {
        return Err(ContractError::EscrowTooSmall { got: cw20.amount, min: MIN_ORDER_ESCROW });
    }
    let maker = deps.api.addr_validate(&cw20.sender)?;
    let id = new_order(deps, maker, Side::SellToken, price, cw20.amount)?;
    Ok(Response::new()
        .add_attribute("action", "place_sell_order")
        .add_attribute("order_id", id.to_string())
        .add_attribute("token", cw20.amount))
}

fn new_order(
    deps: DepsMut,
    owner: Addr,
    side: Side,
    price: Uint128,
    remaining: Uint128,
) -> Result<u64, ContractError> {
    let id = NEXT_ID.load(deps.storage)?;
    NEXT_ID.save(deps.storage, &(id + 1))?;
    let order = Order { id, owner, side, price, remaining, claimable: Uint128::zero() };
    ORDERS.save(deps.storage, id, &order)?;
    // Fix 1 — index the active order so it can be found best-price-first.
    index_add(deps.storage, &order)?;
    Ok(id)
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
    // Refund the unspent escrow, then pay out any accrued proceeds and drop it.
    let mut msgs: Vec<CosmosMsg> = Vec::new();
    if !order.remaining.is_zero() {
        msgs.push(refund_escrow(&cfg, &order, order.remaining)?);
    }
    if !order.claimable.is_zero() {
        msgs.push(pay_claim(&cfg, &order, order.claimable)?);
    }
    // Fix 1 — drop the (possibly still-active) order from the price index too.
    index_remove(deps.storage, &order);
    ORDERS.remove(deps.storage, order_id);
    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "cancel_order")
        .add_attribute("order_id", order_id.to_string())
        .add_attribute("refund", order.remaining)
        .add_attribute("claimed", order.claimable))
}

fn claim(deps: DepsMut, info: MessageInfo, order_id: u64) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let mut order = ORDERS.may_load(deps.storage, order_id)?.ok_or(ContractError::NoOrder {})?;
    if info.sender != order.owner {
        return Err(ContractError::Unauthorized {});
    }
    let amount = order.claimable;
    let mut res = Response::new()
        .add_attribute("action", "claim")
        .add_attribute("order_id", order_id.to_string())
        .add_attribute("claimed", amount);
    if !amount.is_zero() {
        res = res.add_message(pay_claim(&cfg, &order, amount)?);
        order.claimable = Uint128::zero();
    }
    // Fully-spent order with nothing left to claim: remove it. Otherwise persist.
    if order.remaining.is_zero() && order.claimable.is_zero() {
        ORDERS.remove(deps.storage, order_id);
    } else {
        ORDERS.save(deps.storage, order_id, &order)?;
    }
    Ok(res)
}

/// Refund `amount` of the maker's *escrowed* asset (SellToken → token, BuyToken
/// → quote).
fn refund_escrow(cfg: &Config, order: &Order, amount: Uint128) -> Result<CosmosMsg, ContractError> {
    Ok(match order.side {
        Side::SellToken => cw20_transfer(cfg, &order.owner, amount)?,
        Side::BuyToken => bank_quote(cfg, &order.owner, amount),
    })
}

/// Pay `amount` of the maker's *proceeds* asset (SellToken → quote, BuyToken →
/// token).
fn pay_claim(cfg: &Config, order: &Order, amount: Uint128) -> Result<CosmosMsg, ContractError> {
    Ok(match order.side {
        Side::SellToken => bank_quote(cfg, &order.owner, amount),
        Side::BuyToken => cw20_transfer(cfg, &order.owner, amount)?,
    })
}

fn bank_quote(cfg: &Config, to: &Addr, amount: Uint128) -> CosmosMsg {
    CosmosMsg::Bank(BankMsg::Send {
        to_address: to.to_string(),
        amount: vec![Coin { denom: cfg.quote_denom.clone(), amount }],
    })
}

fn cw20_transfer(cfg: &Config, to: &Addr, amount: Uint128) -> Result<CosmosMsg, ContractError> {
    Ok(CosmosMsg::Wasm(WasmMsg::Execute {
        contract_addr: cfg.token_address.to_string(),
        msg: to_binary(&Cw20ExecuteMsg::Transfer { recipient: to.to_string(), amount })?,
        funds: vec![],
    }))
}

/// The backed taker path: buy the token with attached quote, filling resting
/// sell orders that beat the pool, then routing the residual to the AMM.
fn swap_through_book(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    min_output: Uint128,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let input: Uint128 = info
        .funds
        .iter()
        .filter(|c| c.denom == cfg.quote_denom)
        .map(|c| c.amount)
        .sum();
    if input.is_zero() || info.funds.iter().any(|c| c.denom != cfg.quote_denom) {
        return Err(ContractError::BadFunds { denom: cfg.quote_denom });
    }

    // Reserves as the AMM sees them, so the book beats the *same* marginal price
    // the residual will trade at.
    let (ansem_reserve, token_reserve) = amm_reserves(deps.as_ref(), &cfg)?;
    let pool_price = pool_marginal_price(ansem_reserve, token_reserve);

    // Match (read-only) over the bounded, price-ordered candidate set, then
    // apply the fills to storage.
    let orders = candidate_orders(deps.as_ref(), true, pool_price)?;
    let (fills, _book_in, book_out, residual) =
        match_book(&orders, input, true, pool_price);

    let mut msgs: Vec<CosmosMsg> = Vec::new();
    for fill in &fills {
        let mut order = ORDERS.load(deps.storage, fill.order_id)?;
        order.remaining = order.remaining.checked_sub(fill.give_out)?;
        // Maker (SellToken) is paid quote for the token they sold.
        order.claimable = order.claimable.checked_add(fill.take_in)?;
        // Fix 1 — eagerly prune a spent order from the price index (the ORDERS
        // record stays until the maker claims its proceeds).
        if order.remaining.is_zero() {
            index_remove(deps.storage, &order);
        }
        ORDERS.save(deps.storage, fill.order_id, &order)?;
    }
    // Pay the taker the book-matched token straight out of escrow. This is a
    // top-level message, so it runs AFTER the reply — which is why the snapshot
    // below still measures only the pool fill.
    if !book_out.is_zero() {
        msgs.push(cw20_transfer(&cfg, &info.sender, book_out)?);
    }

    // Route the residual quote to the AMM, if any survives the book.
    let mut response = Response::new()
        .add_attribute("action", "swap_through_book")
        .add_attribute("book_out", book_out)
        .add_attribute("residual", residual);

    if residual.is_zero() {
        // Book-only fill: enforce slippage here since no pool reply will.
        if book_out < min_output {
            return Err(ContractError::Slippage { got: book_out, min: min_output });
        }
        if book_out.is_zero() {
            return Err(ContractError::NothingFilled {});
        }
        return Ok(response.add_messages(msgs));
    }

    let before = token_balance(deps.as_ref(), &cfg, &env)?;
    PENDING.save(
        deps.storage,
        &Pending {
            taker: info.sender.clone(),
            book_out,
            balance_before: before,
            min_output,
        },
    )?;

    // The pool must cover whatever the book did not.
    let pool_min = min_output.saturating_sub(book_out);
    let swap = SubMsg::reply_on_success(
        CosmosMsg::Wasm(WasmMsg::Execute {
            contract_addr: cfg.amm.to_string(),
            msg: to_binary(&AmmExecuteMsg::Swap {
                token_address: cfg.token_address.to_string(),
                offer_ansem: true,
                min_output: pool_min,
            })?,
            funds: vec![Coin { denom: cfg.quote_denom.clone(), amount: residual }],
        }),
        REPLY_SWAP,
    );

    response = response.add_submessage(swap).add_messages(msgs);
    Ok(response)
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
    if msg.id != REPLY_SWAP {
        return Ok(Response::new());
    }
    if let SubMsgResult::Err(e) = msg.result {
        return Err(ContractError::Std(cosmwasm_std::StdError::generic_err(e)));
    }
    let cfg = CONFIG.load(deps.storage)?;
    let pending = PENDING.may_load(deps.storage)?.ok_or(ContractError::NoPending {})?;
    PENDING.remove(deps.storage);

    let after = token_balance(deps.as_ref(), &cfg, &env)?;
    let pool_out = after.checked_sub(pending.balance_before).unwrap_or_default();

    // Full slippage guard across both legs (the book leg already ran).
    let total = pool_out + pending.book_out;
    if total < pending.min_output {
        return Err(ContractError::Slippage { got: total, min: pending.min_output });
    }

    let mut res = Response::new()
        .add_attribute("action", "swap_fill")
        .add_attribute("pool_out", pool_out)
        .add_attribute("total_out", total);
    if !pool_out.is_zero() {
        res = res.add_message(cw20_transfer(&cfg, &pending.taker, pool_out)?);
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

/// Live pool reserves. Mirrors the AMM's `Pool` query shape enough to read
/// reserves; anything unparseable is a hard error (the router can't price
/// without them).
fn amm_reserves(deps: Deps, cfg: &Config) -> Result<(Uint128, Uint128), ContractError> {
    #[cw_serde]
    enum AmmQueryMsg {
        Pool { token_address: String },
    }
    #[cw_serde]
    struct PoolResponse {
        ansem_reserve: Uint128,
        token_reserve: Uint128,
    }
    let r: PoolResponse = deps.querier.query_wasm_smart(
        cfg.amm.clone(),
        &AmmQueryMsg::Pool { token_address: cfg.token_address.to_string() },
    )?;
    Ok((r.ansem_reserve, r.token_reserve))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::QuoteThroughBook { ctx } => to_binary(&quote_through_book(deps, ctx)),
        QueryMsg::Config {} => to_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::Order { order_id } => to_binary(&ORDERS.load(deps.storage, order_id)?),
        QueryMsg::Orders { start_after, limit } => {
            let limit = limit.unwrap_or(30).min(100) as usize;
            let start = start_after.map(Bound::exclusive);
            let orders: Vec<Order> = ORDERS
                .range(deps.storage, start, None, StoreOrder::Ascending)
                .take(limit)
                .map(|r| r.map(|(_, o)| o))
                .collect::<StdResult<_>>()?;
            to_binary(&OrdersResponse { orders })
        }
    }
}

/// The read-only blended quote: blend the book with the pool and return a single
/// `Delta` if (and only if) the book strictly improves on pool-only execution.
///
/// Fix 2: this is reachable ONLY through `QueryMsg::QuoteThroughBook`, never
/// through the AMM's `HookQuery::BeforeSwap`. See the module banner for why the
/// blended `Delta` must not be usable as a live pool hook decision.
fn quote_through_book(deps: Deps, ctx: SwapContext) -> HookDecision {
    // Anything degenerate → let the AMM run its own curve.
    if ctx.input_amount.is_zero() {
        return HookDecision::Proceed;
    }
    let pool_price = pool_marginal_price(ctx.ansem_reserve, ctx.token_reserve);
    let orders = match candidate_orders(deps, ctx.offer_ansem, pool_price) {
        Ok(o) => o,
        Err(_) => return HookDecision::Proceed,
    };

    let (_fills, book_in, book_out, residual) =
        match_book(&orders, ctx.input_amount, ctx.offer_ansem, pool_price);

    // Nothing beat the pool → let the swap proceed untouched.
    if book_in.is_zero() {
        return HookDecision::Proceed;
    }

    let (in_reserve, out_reserve) = if ctx.offer_ansem {
        (ctx.ansem_reserve, ctx.token_reserve)
    } else {
        (ctx.token_reserve, ctx.ansem_reserve)
    };
    let residual_out = cp_out(in_reserve, out_reserve, residual, ctx.default_fee_bps);
    let total_out = book_out + residual_out;

    // Compare against pool-only for the WHOLE input: only improve, never worsen.
    let pool_only = cp_out(in_reserve, out_reserve, ctx.input_amount, ctx.default_fee_bps);
    if total_out <= pool_only {
        return HookDecision::Proceed;
    }
    // The AMM pays `amount_out` from the pool; it must fit and be positive.
    if total_out.is_zero() || total_out > out_reserve {
        return HookDecision::Proceed;
    }

    HookDecision::Delta { amount_in: ctx.input_amount, amount_out: total_out }
}

// ── tests ────────────────────────────────────────────────────────────────────

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
        deps.querier.update_wasm(|q| match q {
            WasmQuery::Smart { msg, .. } => {
                // Answer either a CW20 balance or an AMM pool query with harmless
                // defaults; individual tests that care set their own.
                if let Ok(Cw20QueryMsg::Balance { .. }) = from_binary(msg) {
                    return SystemResult::Ok(ContractResult::Ok(
                        to_binary(&BalanceResponse { balance: Uint128::zero() }).unwrap(),
                    ));
                }
                SystemResult::Ok(ContractResult::Ok(Binary::default()))
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

    /// Mirrors the AMM pool query response the router reads.
    #[cw_serde]
    struct MockPool {
        ansem_reserve: Uint128,
        token_reserve: Uint128,
    }

    fn sell(id: u64, price: u128, remaining: u128) -> Order {
        Order {
            id,
            owner: Addr::unchecked("maker"),
            side: Side::SellToken,
            price: Uint128::new(price),
            remaining: Uint128::new(remaining),
            claimable: Uint128::zero(),
        }
    }
    fn buy(id: u64, price: u128, remaining: u128) -> Order {
        Order {
            id,
            owner: Addr::unchecked("maker"),
            side: Side::BuyToken,
            price: Uint128::new(price),
            remaining: Uint128::new(remaining),
            claimable: Uint128::zero(),
        }
    }

    /// Persist an order the way `new_order` does: into `ORDERS` and its price
    /// index, so the bounded candidate walk (Fix 1) can find it.
    fn seed(deps: DepsMut, order: &Order) {
        ORDERS.save(deps.storage, order.id, order).unwrap();
        index_add(deps.storage, order).unwrap();
        NEXT_ID.save(deps.storage, &(order.id + 1)).unwrap();
    }

    // ── pure price math ─────────────────────────────────────────────────────

    #[test]
    fn marginal_price_is_quote_per_token() {
        // 2000 quote / 1000 token = 2.0 quote per token, scaled.
        assert_eq!(
            pool_marginal_price(Uint128::new(2000), Uint128::new(1000)),
            Some(Uint128::new(2 * PRICE_SCALE))
        );
        assert_eq!(
            pool_marginal_price(Uint128::new(1000), Uint128::zero()),
            None,
            "no price without token reserve"
        );
    }

    #[test]
    fn conversions_round_toward_the_maker() {
        let price = Uint128::new(3 * PRICE_SCALE / 2); // 1.5 quote per token
        // Paying for token: ceil (maker never underpaid).
        assert_eq!(quote_for_token_ceil(Uint128::new(3), price), Uint128::new(5)); // 4.5 → 5
        // Buying token with quote: floor (maker never overpays).
        assert_eq!(token_for_quote_floor(Uint128::new(3), price), Uint128::new(2)); // 2.0 → 2
    }

    // ── matching / price improvement ─────────────────────────────────────────

    #[test]
    fn only_orders_that_beat_the_pool_fill() {
        // Pool spot = 2.0 quote/token. Taker buys token (offer_ansem).
        // A sell ask BELOW 2.0 improves; one AT/above does not.
        let pool = pool_marginal_price(Uint128::new(2000), Uint128::new(1000));
        let good = sell(0, 3 * PRICE_SCALE / 2, 1000); // asks 1.5
        let bad = sell(1, 5 * PRICE_SCALE / 2, 1000); // asks 2.5 (worse than pool)
        let (fills, book_in, book_out, _res) =
            match_book(&[good, bad], Uint128::new(1_000_000), true, pool);
        assert_eq!(fills.len(), 1, "only the sub-pool ask should fill");
        assert_eq!(fills[0].order_id, 0);
        assert!(!book_in.is_zero() && !book_out.is_zero());
    }

    #[test]
    fn buy_side_beats_pool_when_bid_is_above_spot() {
        // Taker SELLS token (offer_ansem = false). A bid ABOVE spot improves.
        let pool = pool_marginal_price(Uint128::new(1000), Uint128::new(1000)); // 1.0
        let generous = buy(0, 11 * PRICE_SCALE / 10, 10_000); // bids 1.1
        let stingy = buy(1, 9 * PRICE_SCALE / 10, 10_000); // bids 0.9
        let (fills, book_in, book_out, _res) =
            match_book(&[generous, stingy], Uint128::new(5_000), false, pool);
        assert_eq!(fills.len(), 1);
        assert_eq!(fills[0].order_id, 0);
        // Taker sold token, receives quote at ~1.1 > pool's 1.0.
        assert!(book_out >= book_in, "1.1 quote per token beats 1:1");
    }

    #[test]
    fn a_fill_never_pays_the_sell_maker_below_limit() {
        // Every take_in must be >= give_out priced at the maker's ask.
        let price = Uint128::new(3 * PRICE_SCALE / 2);
        let (fills, _bi, _bo, _r) =
            match_book(&[sell(0, price.u128(), 1000)], Uint128::new(777), true, None);
        for f in fills {
            let owed = quote_for_token_floor(f.give_out, price);
            assert!(f.take_in >= owed, "maker underpaid: {} < {}", f.take_in, owed);
        }
    }

    #[test]
    fn residual_is_what_the_book_could_not_absorb() {
        // One tiny ask (10 token @ 1.0) leaves most of a big input for the pool.
        let pool = pool_marginal_price(Uint128::new(2000), Uint128::new(1000)); // 2.0
        let (_f, book_in, _bo, residual) =
            match_book(&[sell(0, PRICE_SCALE, 10)], Uint128::new(1000), true, pool);
        assert_eq!(book_in + residual, Uint128::new(1000), "input conserved");
        assert!(!residual.is_zero(), "the book cannot swallow it all");
    }

    // ── before_swap decision ─────────────────────────────────────────────────

    fn ctx(input: u128, ar: u128, tr: u128, offer_ansem: bool) -> SwapContext {
        SwapContext {
            token_address: "token".into(),
            sender: "taker".into(),
            offer_ansem,
            input_amount: Uint128::new(input),
            ansem_reserve: Uint128::new(ar),
            token_reserve: Uint128::new(tr),
            default_fee_bps: 30,
        }
    }

    #[test]
    fn quote_proceeds_with_an_empty_book() {
        let deps = init();
        let d = quote_through_book(deps.as_ref(), ctx(1_000, 1_000_000, 1_000_000, true));
        assert_eq!(d, HookDecision::Proceed);
    }

    #[test]
    fn quote_returns_a_better_delta_than_the_pool() {
        let mut deps = init();
        // Pool ~1:1 (1e9/1e9), spot ≈ 1.0. Rest a sell ask at 0.90 — clearly
        // better for a token buyer than the pool.
        seed(deps.as_mut(), &sell(0, 9 * PRICE_SCALE / 10, 1_000_000));

        let c = ctx(1_000_000, 1_000_000_000, 1_000_000_000, true);
        let pool_only = cp_out(
            Uint128::new(1_000_000_000),
            Uint128::new(1_000_000_000),
            Uint128::new(1_000_000),
            30,
        );
        match quote_through_book(deps.as_ref(), c) {
            HookDecision::Delta { amount_in, amount_out } => {
                assert_eq!(amount_in, Uint128::new(1_000_000));
                assert!(
                    amount_out > pool_only,
                    "blended {amount_out} must beat pool-only {pool_only}"
                );
            }
            other => panic!("expected Delta, got {other:?}"),
        }
    }

    #[test]
    fn quote_proceeds_when_the_only_order_is_worse_than_the_pool() {
        let mut deps = init();
        // Spot ≈ 1.0; a sell ask at 1.5 is worse for a buyer, so no delta.
        seed(deps.as_mut(), &sell(0, 3 * PRICE_SCALE / 2, 1_000_000));
        let d = quote_through_book(deps.as_ref(), ctx(1_000_000, 1_000_000_000, 1_000_000_000, true));
        assert_eq!(d, HookDecision::Proceed);
    }

    /// Fix 2 — the blended quote is NOT reachable through the AMM's live
    /// `before_swap` hook interface. If a deployer wrongly set `BEFORE_SWAP` to
    /// this address, the AMM would send `{"before_swap":{...}}`; this contract's
    /// query enum has no such variant, so the call fails to deserialize and the
    /// swap fails closed — it can never coax a value-bearing `Delta` out.
    #[test]
    fn quote_is_not_the_amm_before_swap_hook_interface() {
        // Exactly the shape the AMM sends a live BEFORE_SWAP hook.
        #[cw_serde]
        enum AmmHookQuery {
            BeforeSwap { ctx: SwapContext },
        }
        let amm_call = to_binary(&AmmHookQuery::BeforeSwap {
            ctx: ctx(1_000, 1_000_000, 1_000_000, true),
        })
        .unwrap();
        // The AMM's hook query must NOT parse as one of this contract's queries.
        let parsed: StdResult<QueryMsg> = from_slice(&amm_call);
        assert!(
            parsed.is_err(),
            "the blended quote must be unreachable via the AMM before_swap hook interface"
        );

        // The blended quote is reachable only through the non-hook variant, whose
        // JSON tag is distinct from `before_swap`.
        let quote = QueryMsg::QuoteThroughBook { ctx: ctx(1_000, 1_000_000, 1_000_000, true) };
        let j = String::from_utf8(to_binary(&quote).unwrap().to_vec()).unwrap();
        assert!(j.contains("quote_through_book"), "unexpected: {j}");
        assert!(!j.contains("before_swap"), "must not expose a before_swap query: {j}");
    }

    // ── escrow lifecycle ─────────────────────────────────────────────────────

    /// Fix 3 — `PlaceBuyOrder` is disabled so quote can never be stranded in an
    /// unfillable order. It is rejected regardless of the funds attached, and no
    /// order is created.
    #[test]
    fn place_buy_order_is_disabled() {
        let mut deps = init();
        let err = place_buy_order(
            deps.as_mut(),
            mock_info("maker", &[Coin { denom: "uchanse".into(), amount: Uint128::new(500) }]),
            Uint128::new(PRICE_SCALE),
        )
        .unwrap_err();
        assert_eq!(err, ContractError::BuyOrdersDisabled {});
        // Nothing was escrowed / recorded.
        assert!(ORDERS.may_load(deps.as_ref().storage, 0).unwrap().is_none());

        // Via the public execute entry point too.
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info("maker", &[Coin { denom: "uchanse".into(), amount: Uint128::new(500) }]),
            ExecuteMsg::PlaceBuyOrder { price: Uint128::new(PRICE_SCALE) },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::BuyOrdersDisabled {});
    }

    /// Fix 1 — a sell order below the escrow floor is refused (anti-spam).
    #[test]
    fn sell_order_below_escrow_floor_is_refused() {
        let mut deps = init();
        let hook = to_binary(&ReceiveHook::PlaceSellOrder { price: Uint128::new(PRICE_SCALE) })
            .unwrap();
        let err = receive(
            deps.as_mut(),
            mock_info("token", &[]),
            Cw20ReceiveMsg {
                sender: "maker".into(),
                amount: MIN_ORDER_ESCROW - Uint128::one(),
                msg: hook,
            },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::EscrowTooSmall { .. }));
    }

    #[test]
    fn sell_order_only_from_the_book_token() {
        let mut deps = init();
        let hook = to_binary(&ReceiveHook::PlaceSellOrder { price: Uint128::new(PRICE_SCALE) })
            .unwrap();
        // The token contract funds it: ok (above the escrow floor).
        receive(
            deps.as_mut(),
            mock_info("token", &[]),
            Cw20ReceiveMsg { sender: "maker".into(), amount: Uint128::new(1_000_000), msg: hook.clone() },
        )
        .unwrap();
        let o = ORDERS.load(deps.as_ref().storage, 0).unwrap();
        assert!(matches!(o.side, Side::SellToken));
        assert_eq!(o.remaining, Uint128::new(1_000_000));
        // It landed in the sell price index too.
        assert!(SELL_INDEX.has(deps.as_ref().storage, index_key(&o)));

        // Some other CW20 masquerading is refused.
        let err = receive(
            deps.as_mut(),
            mock_info("not_the_token", &[]),
            Cw20ReceiveMsg { sender: "maker".into(), amount: Uint128::new(1_000_000), msg: hook },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::WrongToken {}));
    }

    #[test]
    fn cancel_refunds_escrow_and_only_owner_may() {
        let mut deps = init();
        // A resting sell order (500_000 token escrowed) — the live order type.
        seed(deps.as_mut(), &sell(0, PRICE_SCALE, 500_000));
        let o = ORDERS.load(deps.as_ref().storage, 0).unwrap();
        assert!(SELL_INDEX.has(deps.as_ref().storage, index_key(&o)));
        // A stranger cannot cancel.
        let err = cancel_order(deps.as_mut(), mock_info("thief", &[]), 0).unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
        // Owner cancels: one CW20 refund of the escrowed token, order + index gone.
        let res = cancel_order(deps.as_mut(), mock_info("maker", &[]), 0).unwrap();
        assert_eq!(res.messages.len(), 1);
        assert!(ORDERS.may_load(deps.as_ref().storage, 0).unwrap().is_none());
        assert!(!SELL_INDEX.has(deps.as_ref().storage, index_key(&o)));
    }

    #[test]
    fn swap_through_book_fills_from_escrow_and_routes_residual() {
        let mut deps = init();
        // Pool spot 1.0 (1e6/1e6). Answer the AMM pool query with those reserves
        // and CW20 balance queries with zero.
        deps.querier.update_wasm(|q| match q {
            WasmQuery::Smart { msg, .. } => {
                if let Ok(Cw20QueryMsg::Balance { .. }) = from_binary::<Cw20QueryMsg>(msg) {
                    return SystemResult::Ok(ContractResult::Ok(
                        to_binary(&BalanceResponse { balance: Uint128::zero() }).unwrap(),
                    ));
                }
                // Anything else is treated as the AMM pool query.
                SystemResult::Ok(ContractResult::Ok(
                    to_binary(&MockPool {
                        ansem_reserve: Uint128::new(1_000_000),
                        token_reserve: Uint128::new(1_000_000),
                    })
                    .unwrap(),
                ))
            }
            _ => SystemResult::Ok(ContractResult::Ok(Binary::default())),
        });

        // Rest a generous ask: 100 token at 0.5 quote/token (spot is 1.0).
        seed(deps.as_mut(), &sell(0, PRICE_SCALE / 2, 100));

        // Taker buys with 1000 quote. The ask can take 50 quote for its 100
        // token; the remaining 950 routes to the AMM.
        let res = swap_through_book(
            deps.as_mut(),
            mock_env(),
            mock_info("taker", &[Coin { denom: "uchanse".into(), amount: Uint128::new(1000) }]),
            Uint128::zero(),
        )
        .unwrap();

        // One CW20 transfer (book token to taker) as a message + one AMM SubMsg.
        assert_eq!(res.messages.len(), 2, "book payout message + pool swap submsg");
        let book_out = res.attributes.iter().find(|a| a.key == "book_out").unwrap();
        assert_eq!(book_out.value, "100");
        let residual = res.attributes.iter().find(|a| a.key == "residual").unwrap();
        assert_eq!(residual.value, "950");

        // The maker's order was drawn down and credited its quote proceeds.
        let o = ORDERS.load(deps.as_ref().storage, 0).unwrap();
        assert_eq!(o.remaining, Uint128::zero());
        assert_eq!(o.claimable, Uint128::new(50), "50 quote for 100 token @ 0.5");
        // Fix 1 — spent order pruned from the price index (still claimable in ORDERS).
        assert!(!SELL_INDEX.has(deps.as_ref().storage, index_key(&o)));
    }

    // ── Fix 1: the working set is bounded under a flood ──────────────────────

    /// Seed `n` sub-pool sell asks and confirm candidate selection never loads
    /// more than `MAX_CANDIDATES` of them, however large the book grows.
    #[test]
    fn candidate_set_is_capped_under_a_flood() {
        let mut deps = init();
        // 300 asks, all at 0.5 (spot below is 1.0), each above the escrow floor.
        for id in 0..300u64 {
            seed(deps.as_mut(), &sell(id, PRICE_SCALE / 2, 1_000_000));
        }
        let pool = pool_marginal_price(Uint128::new(1_000_000), Uint128::new(1_000_000)); // 1.0
        let cands = candidate_orders(deps.as_ref(), true, pool).unwrap();
        assert_eq!(
            cands.len(),
            MAX_CANDIDATES,
            "the flood must be truncated to the cap, not walked in full"
        );
    }

    /// The worse-than-pool tail is never loaded at all: the price-ordered walk
    /// stops at the first order that fails to beat the pool.
    #[test]
    fn worse_than_pool_orders_are_not_loaded() {
        let mut deps = init();
        // One improving ask (0.5) and a big tail of worse asks (2.0) at spot 1.0.
        seed(deps.as_mut(), &sell(0, PRICE_SCALE / 2, 1_000_000));
        for id in 1..200u64 {
            seed(deps.as_mut(), &sell(id, 2 * PRICE_SCALE, 1_000_000));
        }
        let pool = pool_marginal_price(Uint128::new(1_000_000), Uint128::new(1_000_000)); // 1.0
        let cands = candidate_orders(deps.as_ref(), true, pool).unwrap();
        assert_eq!(cands.len(), 1, "only the sub-pool ask is a candidate");
        assert_eq!(cands[0].id, 0);
    }

    /// End-to-end: a flooded book still settles through `SwapThroughBook`, and it
    /// touches at most `MAX_CANDIDATES` orders — the orders beyond the cap keep
    /// their full escrow (proof the walk was bounded, not exhaustive).
    #[test]
    fn swap_through_book_is_bounded_under_a_flood() {
        let mut deps = init();
        deps.querier.update_wasm(|q| match q {
            WasmQuery::Smart { msg, .. } => {
                if let Ok(Cw20QueryMsg::Balance { .. }) = from_binary::<Cw20QueryMsg>(msg) {
                    return SystemResult::Ok(ContractResult::Ok(
                        to_binary(&BalanceResponse { balance: Uint128::zero() }).unwrap(),
                    ));
                }
                SystemResult::Ok(ContractResult::Ok(
                    to_binary(&MockPool {
                        ansem_reserve: Uint128::new(1_000_000),
                        token_reserve: Uint128::new(1_000_000),
                    })
                    .unwrap(),
                ))
            }
            _ => SystemResult::Ok(ContractResult::Ok(Binary::default())),
        });

        // 200 asks at 0.5, each escrowing 1_000_000 token.
        for id in 0..200u64 {
            seed(deps.as_mut(), &sell(id, PRICE_SCALE / 2, 1_000_000));
        }

        // A huge input that could, without the cap, sweep the whole book.
        let res = swap_through_book(
            deps.as_mut(),
            mock_env(),
            mock_info(
                "taker",
                &[Coin { denom: "uchanse".into(), amount: Uint128::new(1_000_000_000) }],
            ),
            Uint128::zero(),
        )
        .unwrap();
        assert!(res.attributes.iter().any(|a| a.key == "book_out"));

        // Exactly MAX_CANDIDATES orders were drawn down; the rest are untouched.
        let mut drawn = 0usize;
        for id in 0..200u64 {
            let o = ORDERS.load(deps.as_ref().storage, id).unwrap();
            if o.remaining.is_zero() {
                drawn += 1;
                assert!(!SELL_INDEX.has(deps.as_ref().storage, index_key(&o)));
            } else {
                assert_eq!(o.remaining, Uint128::new(1_000_000), "order {id} must be untouched");
            }
        }
        assert_eq!(drawn, MAX_CANDIDATES, "settlement stayed within the cap");
    }
}
