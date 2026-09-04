//! Custom Curve Horn — a `before_swap` pricing Horn that replaces the AMM's
//! constant-product math with a **StableSwap** curve (Curve.fi 2-coin invariant).
//!
//! This is the `Delta` path of the Horns framework: the Horn prices the swap
//! itself and hands the AMM exact `(amount_in, amount_out)`; the constant-product
//! math is skipped. StableSwap keeps price near 1:1 while reserves are balanced
//! (great for pegged pairs) and degrades toward constant-product as they skew,
//! so it can't be drained at par. A trading fee is baked into a smaller
//! `amount_out`, so LPs still earn.
//!
//! Safety: for any degenerate input (zero reserves/amount, or a non-improving
//! solve) it returns `Proceed`, so the AMM falls back to its own curve and a
//! swap is never broken by this Horn. The AMM also re-validates the returned
//! delta (`amount_in == offered`, `amount_out <= reserve`, `> 0`).

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_binary, Addr, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult,
    Uint128, Uint256,
};
use cw_storage_plus::Item;
use thiserror::Error;

const BPS: u128 = 10_000;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("fee bps must be <= 1000")]
    FeeTooHigh {},
    #[error("amp must be >= 1")]
    BadAmp {},
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

// ── state ───────────────────────────────────────────────────────────────────

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    /// StableSwap amplification coefficient A (higher = flatter/closer to 1:1).
    pub amp: u64,
    /// Trading fee (bps) baked into the output; kept by the pool for LPs.
    pub fee_bps: u16,
}

const CONFIG: Item<Config> = Item::new("config");

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub amp: u64,
    pub fee_bps: u16,
}

#[cw_serde]
pub enum ExecuteMsg {
    UpdateConfig {
        admin: Option<String>,
        amp: Option<u64>,
        fee_bps: Option<u16>,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(HookDecision)]
    BeforeSwap { ctx: SwapContext },
    #[returns(Config)]
    Config {},
}

// ── StableSwap 2-coin invariant (Curve.fi), all math in Uint256 ─────────────

fn u(n: u128) -> Uint256 {
    Uint256::from(n)
}

/// Bake a bps fee into a gross output, entirely in `Uint256` so the
/// `gross * BPS` intermediate cannot overflow `u128` (which, with
/// `overflow-checks = true`, would abort the query and brick the swap).
/// `gross <= reserve <= u128::MAX` and `BPS - fee <= BPS`, so the product is
/// `< 2^142` and the `Uint256` math never traps.
fn bake_fee(gross: u128, fee_bps: u16) -> u128 {
    (u(gross) * u(BPS - fee_bps as u128) / u(BPS))
        .try_into()
        .map(|v: Uint128| v.u128())
        .unwrap_or(0)
}

/// Invariant D for balances (x, y) at amplification `amp`. Newton's method.
///
/// Every arithmetic step is checked: on overflow, underflow, a zero divisor, or
/// non-convergence within the iteration budget this returns `None` so the caller
/// falls back to `Proceed`. A `before_swap` is a read-only QUERY, and a panic
/// there is NOT caught by the `None -> Proceed` fallback — it aborts the whole
/// swap. Degrading to `None` instead of panicking is what keeps a hostile
/// (reserve, amp) pair from bricking every swap on the pool.
fn get_d(x: Uint256, y: Uint256, amp: Uint256) -> Option<Uint256> {
    let s = x.checked_add(y).ok()?;
    if s.is_zero() {
        return Some(Uint256::zero());
    }
    let ann = amp.checked_mul(u(4)).ok()?; // A * n^n, n = 2
    let two = u(2);
    let three = u(3);
    let one = Uint256::one();
    let mut d = s;
    for _ in 0..255 {
        // d_p = D^3 / (n^n * x * y) = D^3 / (4 * x * y), stepwise.
        let x2 = x.checked_mul(two).ok()?;
        let y2 = y.checked_mul(two).ok()?;
        if x2.is_zero() || y2.is_zero() {
            return None;
        }
        let mut d_p = d;
        d_p = d_p.checked_mul(d).ok()?.checked_div(x2).ok()?;
        d_p = d_p.checked_mul(d).ok()?.checked_div(y2).ok()?;
        let d_prev = d;
        let num = ann
            .checked_mul(s)
            .ok()?
            .checked_add(d_p.checked_mul(two).ok()?)
            .ok()?
            .checked_mul(d)
            .ok()?;
        let den = ann
            .checked_sub(one)
            .ok()?
            .checked_mul(d)
            .ok()?
            .checked_add(three.checked_mul(d_p).ok()?)
            .ok()?;
        if den.is_zero() {
            return None;
        }
        d = num.checked_div(den).ok()?;
        let diff = if d >= d_prev { d - d_prev } else { d_prev - d };
        if diff <= one {
            return Some(d);
        }
    }
    None // did not converge; treat as no quote and Proceed
}

/// Given the new balance `x_new` of one coin, the invariant `d`, and `amp`,
/// return the other coin's new balance `y`. Newton's method. Same no-panic
/// discipline as `get_d`: any overflow/underflow/zero-divisor/non-convergence
/// degrades to `None`.
fn get_y(x_new: Uint256, d: Uint256, amp: Uint256) -> Option<Uint256> {
    let ann = amp.checked_mul(u(4)).ok()?;
    let two = u(2);
    let one = Uint256::one();
    if x_new.is_zero() || ann.is_zero() {
        return None;
    }
    // c = D^(n+1) / (n^n * x_new * Ann), stepwise.
    let x2 = x_new.checked_mul(two).ok()?;
    let ann2 = ann.checked_mul(two).ok()?;
    if x2.is_zero() || ann2.is_zero() {
        return None;
    }
    let mut c = d;
    c = c.checked_mul(d).ok()?.checked_div(x2).ok()?;
    c = c.checked_mul(d).ok()?.checked_div(ann2).ok()?;
    let b = x_new.checked_add(d.checked_div(ann).ok()?).ok()?;
    let mut y = d;
    for _ in 0..255 {
        let y_prev = y;
        let num = y.checked_mul(y).ok()?.checked_add(c).ok()?;
        // den = 2*y + b - d, with the subtraction guarded against underflow.
        let two_y_b = two.checked_mul(y).ok()?.checked_add(b).ok()?;
        if two_y_b <= d {
            return None;
        }
        let den = two_y_b - d;
        y = num.checked_div(den).ok()?;
        let diff = if y >= y_prev { y - y_prev } else { y_prev - y };
        if diff <= one {
            return Some(y);
        }
    }
    None // did not converge; treat as no quote and Proceed
}

/// Price the swap on the StableSwap curve. Returns the gross output (before fee)
/// or None if the curve cannot produce a valid, positive, reserve-bounded fill.
fn stableswap_out(
    input: Uint128,
    in_reserve: Uint128,
    out_reserve: Uint128,
    amp: u64,
) -> Option<u128> {
    if input.is_zero() || in_reserve.is_zero() || out_reserve.is_zero() || amp == 0 {
        return None;
    }
    let x = u(in_reserve.u128());
    let y = u(out_reserve.u128());
    let a = u(amp as u128);
    let d = get_d(x, y, a)?;
    if d.is_zero() {
        return None;
    }
    let x_new = x.checked_add(u(input.u128())).ok()?;
    let y_new = get_y(x_new, d, a)?;
    if y_new >= y {
        return None; // no output
    }
    let out: Uint256 = y - y_new;
    let out_u128: u128 = Uint128::try_from(out).ok()?.u128();
    if out_u128 == 0 || out_u128 > out_reserve.u128() {
        return None;
    }
    Some(out_u128)
}

// ── entry points ────────────────────────────────────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    cw2::set_contract_version(deps.storage, "ansem-horn-curve", env!("CARGO_PKG_VERSION"))?;
    if msg.fee_bps as u128 > 1000 {
        return Err(ContractError::FeeTooHigh {});
    }
    if msg.amp < 1 {
        return Err(ContractError::BadAmp {});
    }
    CONFIG.save(
        deps.storage,
        &Config {
            admin: deps.api.addr_validate(&msg.admin)?,
            amp: msg.amp,
            fee_bps: msg.fee_bps,
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
    let ExecuteMsg::UpdateConfig { admin, amp, fee_bps } = msg;
    let mut cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    if let Some(a) = admin {
        cfg.admin = deps.api.addr_validate(&a)?;
    }
    if let Some(a) = amp {
        if a < 1 {
            return Err(ContractError::BadAmp {});
        }
        cfg.amp = a;
    }
    if let Some(f) = fee_bps {
        if f as u128 > 1000 {
            return Err(ContractError::FeeTooHigh {});
        }
        cfg.fee_bps = f;
    }
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

fn decide(deps: Deps, ctx: SwapContext) -> HookDecision {
    let cfg = match CONFIG.load(deps.storage) {
        Ok(c) => c,
        Err(_) => return HookDecision::Proceed,
    };
    // input side vs output side per direction.
    let (in_reserve, out_reserve) = if ctx.offer_ansem {
        (ctx.ansem_reserve, ctx.token_reserve)
    } else {
        (ctx.token_reserve, ctx.ansem_reserve)
    };
    let gross = match stableswap_out(ctx.input_amount, in_reserve, out_reserve, cfg.amp) {
        Some(g) => g,
        None => return HookDecision::Proceed, // safe fall-back to constant product
    };
    // Bake the fee into a smaller output; the difference stays in the pool.
    let net = bake_fee(gross, cfg.fee_bps);
    if net == 0 || net > out_reserve.u128() {
        return HookDecision::Proceed;
    }
    HookDecision::Delta {
        amount_in: ctx.input_amount,
        amount_out: Uint128::new(net),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(input: u128, ar: u128, tr: u128, offer_ansem: bool) -> SwapContext {
        SwapContext {
            token_address: "token".into(),
            sender: "trader".into(),
            offer_ansem,
            input_amount: Uint128::new(input),
            ansem_reserve: Uint128::new(ar),
            token_reserve: Uint128::new(tr),
            default_fee_bps: 100,
        }
    }

    #[test]
    fn near_one_to_one_when_balanced() {
        // Balanced 1e9 / 1e9 reserves, A=100, no fee: a small trade should get
        // ~1:1 out (StableSwap flatness), strictly better than constant product.
        let out = stableswap_out(Uint128::new(1_000_000), Uint128::new(1_000_000_000), Uint128::new(1_000_000_000), 100).unwrap();
        // Constant-product out for the same trade ≈ 999_000. StableSwap should be higher and near the 1_000_000 input.
        assert!(out > 999_500, "stableswap out {out} not flatter than CP");
        assert!(out <= 1_000_000, "out {out} exceeds input at balance");
    }

    #[test]
    fn degenerate_inputs_fall_back() {
        assert!(stableswap_out(Uint128::zero(), Uint128::new(10), Uint128::new(10), 100).is_none());
        assert!(stableswap_out(Uint128::new(10), Uint128::zero(), Uint128::new(10), 100).is_none());
        assert!(stableswap_out(Uint128::new(10), Uint128::new(10), Uint128::new(10), 0).is_none());
    }

    /// Regression: the Newton solver at extreme reserves + high amp overflows
    /// its `Uint256` intermediates. It must degrade to `None` (→ Proceed), never
    /// panic — a panic in the `before_swap` QUERY is not caught by the
    /// `None -> Proceed` fallback and would brick every swap on the pool.
    #[test]
    fn solver_at_extreme_reserves_proceeds_without_panic() {
        // Directly: the pure solver returns None rather than trapping.
        assert!(stableswap_out(
            Uint128::new(u128::MAX),
            Uint128::new(u128::MAX),
            Uint128::new(u128::MAX),
            1_000_000
        )
        .is_none());
        // And through the query path: decide() surfaces it as Proceed.
        let mut deps = cosmwasm_std::testing::mock_dependencies();
        instantiate(
            deps.as_mut(),
            cosmwasm_std::testing::mock_env(),
            cosmwasm_std::testing::mock_info("admin", &[]),
            InstantiateMsg { admin: "admin".into(), amp: 1_000_000, fee_bps: 30 },
        )
        .unwrap();
        let d = decide(deps.as_ref(), ctx(u128::MAX, u128::MAX, u128::MAX, true));
        assert_eq!(d, HookDecision::Proceed);
    }

    #[test]
    fn decide_returns_delta_and_charges_fee() {
        let mut deps = cosmwasm_std::testing::mock_dependencies();
        instantiate(
            deps.as_mut(),
            cosmwasm_std::testing::mock_env(),
            cosmwasm_std::testing::mock_info("admin", &[]),
            InstantiateMsg { admin: "admin".into(), amp: 100, fee_bps: 30 },
        )
        .unwrap();
        let d = decide(deps.as_ref(), ctx(1_000_000, 1_000_000_000, 1_000_000_000, true));
        match d {
            HookDecision::Delta { amount_in, amount_out } => {
                assert_eq!(amount_in, Uint128::new(1_000_000));
                // 30bps fee applied to a ~1:1 gross.
                assert!(amount_out < Uint128::new(1_000_000));
                assert!(amount_out > Uint128::new(996_000));
            }
            other => panic!("expected Delta, got {other:?}"),
        }
    }
}
