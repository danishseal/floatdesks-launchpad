//! LDF Horn — a `before_swap` pricing Horn that emulates Bunni v2's
//! **liquidity distribution function** (shapeshifting liquidity, the successor
//! to Uniswap v3's concentrated liquidity) on top of ANSEM's constant-product
//! AMM.
//!
//! # What Vector's `ldf-vector` does, and why it can't be ported literally
//!
//! On Vector the pool's liquidity is a *function over price*: the shape is
//! declared once as data (a weight per bin on a geometric price ladder), each
//! bin holds real inventory of one or both tokens, and a swap walks the ladder
//! bin by bin. `before_swap` returns a delta consuming the whole swap and the
//! vector is the counterparty out of its own vaults, so the pool's own curve
//! never runs. Liquidity providers deposit into the ladder and hold shares of
//! it; there are real, positioned reserves.
//!
//! **ANSEM's AMM has none of that.** It is a single constant-product pair
//! `(ansem_reserve, token_reserve)` with no ranged or positioned liquidity, so
//! a true LDF — real inventory resting in discrete price bins — is not
//! representable: there is nowhere to *put* the per-bin reserves, and the Horn
//! interface is a stateless pricing query, not a vault. A faithful port would
//! need the AMM to grow positions, which is out of scope and off-limits here.
//!
//! # The closest feasible version: delta-pricing against a shaped curve
//!
//! Instead of laying inventory into bins, this Horn takes the same `Delta` path
//! `horn-curve` takes and prices the swap against a **liquidity-distribution
//! shape expressed as a curve**. The shape is two parameters:
//!
//! - a **target price** `p = target_price_num / target_price_den` — the ANSEM
//!   value of one token, i.e. the price around which depth is concentrated
//!   (Bunni's "peak" / live price), and
//! - a **concentration** factor (a StableSwap amplification `A`) that makes the
//!   effective curve **flatter near the target price and steeper away from it** —
//!   deep where trading happens, thin in the tails, exactly the effect a
//!   concentrated LDF has.
//!
//! Mechanically it is `horn-curve`'s StableSwap invariant applied in a
//! **price-scaled frame**: the token reserve is rescaled by the target price so
//! that "value-balanced" reserves (`ansem_reserve == token_reserve * p`) land on
//! StableSwap's flat region. That moves the concentration peak from StableSwap's
//! native 1:1 to an arbitrary target price. Raising `concentration` deepens the
//! effective liquidity around the target (flatter); lowering it toward 1
//! degrades the shape back toward plain constant product.
//!
//! The delta is computed from that shape, a trading fee is baked into a smaller
//! `amount_out` (kept by the pool for LPs), and the AMM re-validates the delta
//! (`amount_in == offered`, `amount_out <= reserve`, `> 0`).
//!
//! # What this emulation is, and is not
//!
//! - It **emulates an LDF via delta-pricing**, not via real ranged positions.
//!   There is one continuous shaped curve, not a ladder of bins holding
//!   inventory, so there is no per-bin state, no shares, and no shifting/
//!   recentering (which is also the exact surface Vector's port declined and
//!   that lost ~$8.3M in Bunni v2 in Sep 2025 — there is no derived idle balance
//!   here for a dust sequence to ratchet, because this Horn holds no state at
//!   all).
//! - Only a single symmetric concentration parameter is exposed, not Bunni's
//!   Uniform / Geometric / DoubleGeometric family: a constant-product AMM cannot
//!   carry an asymmetric per-bin shape without positions.
//!
//! # Safety
//!
//! For any degenerate input (zero reserves/amount, `concentration == 0`, a
//! zero/oversized target, or a non-improving solve) it returns `Proceed`, so the
//! AMM falls back to its own constant-product curve and a swap is never broken
//! by this Horn.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_binary, Addr, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult,
    Uint128, Uint256,
};
use cw_storage_plus::Item;
use thiserror::Error;

const BPS: u128 = 10_000;

/// Upper bound on the amplification/concentration factor. Beyond this the shape
/// is economically indistinguishable from "infinitely flat" and the only effect
/// of a larger value is to push the Newton solver's intermediates toward
/// overflow, so it is capped at config time rather than left unbounded (the
/// audit flagged an unbounded `concentration` as an arbitrage-drain amplifier).
pub const MAX_CONCENTRATION: u64 = 1_000_000;

/// Upper bound on each component of the target price ratio. Keeps the
/// price-scaled reserve `token_reserve * num / den` inside a range the solver
/// can evaluate without overflow for any plausible reserve.
pub const MAX_PRICE_COMPONENT: u128 = 1_000_000_000_000_000_000; // 1e18

/// Widest tolerance band (100%).
pub const MAX_TOLERANCE_BPS: u16 = BPS as u16;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("unauthorized")]
    Unauthorized {},
    #[error("fee bps must be <= 1000")]
    FeeTooHigh {},
    #[error("concentration must be between 1 and {MAX_CONCENTRATION}")]
    BadConcentration {},
    #[error("target price numerator and denominator must both be > 0 and <= {MAX_PRICE_COMPONENT}")]
    BadTarget {},
    #[error("tolerance bps must be <= {MAX_TOLERANCE_BPS}")]
    BadTolerance {},
}

// ── mirrors of amm::hooks (serialize identically) ───────────────────────────

#[cw_serde]
pub struct SwapContext {
    pub token_address: String,
    pub sender: String,
    /// true = ANSEM in / token out
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
    /// Target price = the ANSEM value of one token, as `num/den`. Depth is
    /// concentrated around the reserve ratio where `ansem_reserve` equals
    /// `token_reserve * num/den`. `num == den` concentrates at parity and this
    /// Horn reduces exactly to `horn-curve`'s StableSwap.
    pub target_price_num: Uint128,
    pub target_price_den: Uint128,
    /// Concentration factor: the StableSwap amplification `A`. Higher = deeper,
    /// flatter effective liquidity around the target; 1 ≈ plain constant product.
    pub concentration: u64,
    /// Trading fee (bps) baked into the output; kept by the pool for LPs.
    pub fee_bps: u16,
    /// The Delta only fires when the configured target price is within this many
    /// bps of the live pool ratio `ansem_reserve / token_reserve`. Once the pool
    /// has drifted off the static target the shaped quote would hand arbitrage a
    /// price better than market (an LP loss the AMM does not re-check against
    /// constant product), so outside the band the Horn returns `Proceed` and the
    /// pool's own curve prices the swap.
    pub tolerance_bps: u16,
}

const CONFIG: Item<Config> = Item::new("config");

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub target_price_num: Uint128,
    pub target_price_den: Uint128,
    pub concentration: u64,
    pub fee_bps: u16,
    pub tolerance_bps: u16,
}

#[cw_serde]
pub enum ExecuteMsg {
    UpdateConfig {
        admin: Option<String>,
        target_price_num: Option<Uint128>,
        target_price_den: Option<Uint128>,
        concentration: Option<u64>,
        fee_bps: Option<u16>,
        tolerance_bps: Option<u16>,
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
//
// Identical to `horn-curve`: the shaping this Horn adds is entirely in the
// price-scaled *frame* the invariant is evaluated in (see `shaped_out`), not in
// the invariant itself.

fn u(n: u128) -> Uint256 {
    Uint256::from(n)
}

/// Bake a bps fee into a gross output entirely in `Uint256`, so the
/// `gross * BPS` intermediate cannot overflow `u128` (which, with
/// `overflow-checks = true`, would abort the query).
fn bake_fee(gross: u128, fee_bps: u16) -> u128 {
    (u(gross) * u(BPS - fee_bps as u128) / u(BPS))
        .try_into()
        .map(|v: Uint128| v.u128())
        .unwrap_or(0)
}

/// Is the static target price within `tol_bps` of the live pool ratio
/// `ansem_reserve / token_reserve`? Compared by cross-multiplication so there is
/// no division. Returns `None` on any overflow or a degenerate input, which the
/// caller treats as "off band" (→ `Proceed`): a shaped quote is only safe to
/// hand the AMM while the target still tracks the market.
fn within_band(ar: u128, tr: u128, num: u128, den: u128, tol_bps: u16) -> Option<bool> {
    if tr == 0 || num == 0 || den == 0 {
        return None;
    }
    // pool ratio = ar/tr, target = num/den. |ar/tr - num/den| <= tol * num/den
    // <=> |ar*den - num*tr| * BPS <= tol_bps * num * tr.
    let lhs_a = u(ar).checked_mul(u(den)).ok()?;
    let lhs_b = u(num).checked_mul(u(tr)).ok()?;
    let diff = if lhs_a >= lhs_b { lhs_a - lhs_b } else { lhs_b - lhs_a };
    let scaled_diff = diff.checked_mul(u(BPS)).ok()?;
    let bound = u(tol_bps as u128)
        .checked_mul(u(num))
        .ok()?
        .checked_mul(u(tr))
        .ok()?;
    Some(scaled_diff <= bound)
}

/// Invariant D for balances (x, y) at amplification `amp`. Newton's method.
///
/// Every arithmetic step is checked: on overflow, underflow, a zero divisor, or
/// non-convergence this returns `None` so the caller falls back to `Proceed`. A
/// `before_swap` is a read-only QUERY and a panic there is NOT caught by the
/// `None -> Proceed` fallback — it aborts the whole swap — so degrading to
/// `None` is what stops a hostile (reserve, amp) pair from bricking every swap.
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
/// return the other coin's new balance `y`. Newton's method. The invariant is
/// symmetric in the two coins, so passing either side's new balance returns the
/// other side's. Same no-panic discipline as `get_d`.
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

// ── the shaped LDF curve ────────────────────────────────────────────────────

/// Price the swap against the shaped distribution. Returns the gross output
/// (before fee) in the output side's native units, or `None` if the shape
/// cannot produce a valid, positive, reserve-bounded fill (caller falls back to
/// constant product).
///
/// The trick is the frame: the token reserve is rescaled to ANSEM value by the
/// target price, so StableSwap's flat region — its natural concentration peak —
/// sits at the target price instead of at 1:1. `concentration` is the
/// amplification; higher makes the value-balanced neighbourhood flatter (deeper
/// effective depth around the target) and the tails steeper.
#[allow(clippy::too_many_arguments)]
fn shaped_out(
    input: Uint128,
    ansem_reserve: Uint128,
    token_reserve: Uint128,
    offer_ansem: bool,
    price_num: Uint128,
    price_den: Uint128,
    concentration: u64,
) -> Option<u128> {
    if input.is_zero()
        || ansem_reserve.is_zero()
        || token_reserve.is_zero()
        || concentration == 0
        || price_num.is_zero()
        || price_den.is_zero()
    {
        return None;
    }
    let num = u(price_num.u128());
    let den = u(price_den.u128());
    let a = u(concentration as u128);

    // Scaled frame: x is ANSEM as-is, y is the token reserve expressed in ANSEM
    // value. Concentration peak = where x == y = the target price. Every step is
    // `checked_*`: if the price-scaled reserves don't fit a range the solver can
    // evaluate, we return None (→ Proceed) rather than panic.
    let x = u(ansem_reserve.u128());
    let y = u(token_reserve.u128())
        .checked_mul(num)
        .ok()?
        .checked_div(den)
        .ok()?;
    if y.is_zero() {
        return None;
    }
    let d = get_d(x, y, a)?;
    if d.is_zero() {
        return None;
    }

    if offer_ansem {
        // ANSEM in (x side), token out. Output comes back in ANSEM value and is
        // converted to token units by the inverse price.
        let x_new = x.checked_add(u(input.u128())).ok()?;
        let y_new = get_y(x_new, d, a)?;
        if y_new >= y {
            return None; // no output
        }
        let out_value = y - y_new; // ANSEM value of the token leaving
        let out_tokens = out_value.checked_mul(den).ok()?.checked_div(num).ok()?; // back to token units
        let out_u128: u128 = Uint128::try_from(out_tokens).ok()?.u128();
        if out_u128 == 0 || out_u128 > token_reserve.u128() {
            return None;
        }
        Some(out_u128)
    } else {
        // token in, ANSEM out (x side). Convert the token input to ANSEM value,
        // add it to the y side, solve for the new x.
        let in_value = u(input.u128()).checked_mul(num).ok()?.checked_div(den).ok()?;
        if in_value.is_zero() {
            return None;
        }
        let y_new = y.checked_add(in_value).ok()?;
        let x_new = get_y(y_new, d, a)?;
        if x_new >= x {
            return None; // no output
        }
        let out: Uint256 = x - x_new; // already ANSEM units
        let out_u128: u128 = Uint128::try_from(out).ok()?.u128();
        if out_u128 == 0 || out_u128 > ansem_reserve.u128() {
            return None;
        }
        Some(out_u128)
    }
}

// ── entry points ────────────────────────────────────────────────────────────

/// Both price components must be non-zero and bounded, so the price-scaled
/// reserve `token_reserve * num / den` stays in a range the solver can evaluate.
fn check_target(num: Uint128, den: Uint128) -> Result<(), ContractError> {
    if num.is_zero()
        || den.is_zero()
        || num.u128() > MAX_PRICE_COMPONENT
        || den.u128() > MAX_PRICE_COMPONENT
    {
        return Err(ContractError::BadTarget {});
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
    cw2::set_contract_version(deps.storage, "ansem-horn-ldf", env!("CARGO_PKG_VERSION"))?;
    if msg.fee_bps as u128 > 1000 {
        return Err(ContractError::FeeTooHigh {});
    }
    if msg.concentration < 1 || msg.concentration > MAX_CONCENTRATION {
        return Err(ContractError::BadConcentration {});
    }
    check_target(msg.target_price_num, msg.target_price_den)?;
    if msg.tolerance_bps > MAX_TOLERANCE_BPS {
        return Err(ContractError::BadTolerance {});
    }
    CONFIG.save(
        deps.storage,
        &Config {
            admin: deps.api.addr_validate(&msg.admin)?,
            target_price_num: msg.target_price_num,
            target_price_den: msg.target_price_den,
            concentration: msg.concentration,
            fee_bps: msg.fee_bps,
            tolerance_bps: msg.tolerance_bps,
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
        target_price_num,
        target_price_den,
        concentration,
        fee_bps,
        tolerance_bps,
    } = msg;
    let mut cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    if let Some(a) = admin {
        cfg.admin = deps.api.addr_validate(&a)?;
    }
    if let Some(n) = target_price_num {
        cfg.target_price_num = n;
    }
    if let Some(d) = target_price_den {
        cfg.target_price_den = d;
    }
    // Re-validate the (possibly updated) pair as a whole.
    check_target(cfg.target_price_num, cfg.target_price_den)?;
    if let Some(c) = concentration {
        if c < 1 || c > MAX_CONCENTRATION {
            return Err(ContractError::BadConcentration {});
        }
        cfg.concentration = c;
    }
    if let Some(f) = fee_bps {
        if f as u128 > 1000 {
            return Err(ContractError::FeeTooHigh {});
        }
        cfg.fee_bps = f;
    }
    if let Some(t) = tolerance_bps {
        if t > MAX_TOLERANCE_BPS {
            return Err(ContractError::BadTolerance {});
        }
        cfg.tolerance_bps = t;
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
    // Gate the Delta to a tolerance band around the live pool ratio. A static
    // target that has drifted off market prices the shaped quote better than the
    // pool would, which the AMM settles from reserves without a constant-product
    // re-check — a real LP loss. Off band (or any overflow computing the band) we
    // hand the swap back to the pool's own curve.
    match within_band(
        ctx.ansem_reserve.u128(),
        ctx.token_reserve.u128(),
        cfg.target_price_num.u128(),
        cfg.target_price_den.u128(),
        cfg.tolerance_bps,
    ) {
        Some(true) => {}
        _ => return HookDecision::Proceed,
    }
    let gross = match shaped_out(
        ctx.input_amount,
        ctx.ansem_reserve,
        ctx.token_reserve,
        ctx.offer_ansem,
        cfg.target_price_num,
        cfg.target_price_den,
        cfg.concentration,
    ) {
        Some(g) => g,
        None => return HookDecision::Proceed, // safe fall-back to constant product
    };
    // Bake the fee into a smaller output; the difference stays in the pool.
    let net = bake_fee(gross, cfg.fee_bps);
    let out_reserve = if ctx.offer_ansem {
        ctx.token_reserve.u128()
    } else {
        ctx.ansem_reserve.u128()
    };
    if net == 0 || net > out_reserve {
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

    fn shaped(
        input: u128,
        ar: u128,
        tr: u128,
        offer_ansem: bool,
        num: u128,
        den: u128,
        c: u64,
    ) -> Option<u128> {
        shaped_out(
            Uint128::new(input),
            Uint128::new(ar),
            Uint128::new(tr),
            offer_ansem,
            Uint128::new(num),
            Uint128::new(den),
            c,
        )
    }

    /// Constant-product output for the same trade, for comparison.
    fn cp_out(input: u128, in_reserve: u128, out_reserve: u128) -> u128 {
        out_reserve * input / (in_reserve + input)
    }

    #[test]
    fn parity_target_reduces_to_stableswap() {
        // num == den means the concentration peak sits at 1:1, so this Horn is
        // exactly horn-curve's StableSwap. On balanced reserves a small trade
        // should price far flatter than constant product.
        let out = shaped(1_000_000, 1_000_000_000, 1_000_000_000, true, 1, 1, 100).unwrap();
        let cp = cp_out(1_000_000, 1_000_000_000, 1_000_000_000); // ~999_000
        assert!(out > cp, "shaped {out} not flatter than cp {cp}");
        assert!(out > 999_500, "shaped {out} not near-1:1 flat");
        assert!(out <= 1_000_000, "out {out} exceeds input at balance");
    }

    #[test]
    fn flatter_near_target() {
        // A trade that is 10% of reserves at the concentration peak. Constant
        // product would slip hard; the shaped curve stays close to the target
        // price. num=den=1 -> peak at parity, reserves balanced there.
        let shaped_out = shaped(100_000, 1_000_000, 1_000_000, true, 1, 1, 200).unwrap();
        let cp = cp_out(100_000, 1_000_000, 1_000_000); // ~90_909
        assert!(
            shaped_out > 95_000,
            "shaped {shaped_out} not flat near the target"
        );
        assert!(
            shaped_out > cp,
            "shaped {shaped_out} not flatter than cp {cp}"
        );
    }

    #[test]
    fn steeper_away_from_target() {
        // "Steeper away from the target" has two faces on this shape, and both
        // are checked here.
        //
        // 1. Convexity: at the peak a tiny trade prices at ~parity, but a trade
        //    large enough to push reserves off the peak gets a strictly worse
        //    average rate. The larger the move away from the target, the steeper.
        let small = shaped(1_000, 1_000_000_000, 1_000_000_000, true, 1, 1, 200).unwrap();
        let big = shaped(300_000_000, 1_000_000_000, 1_000_000_000, true, 1, 1, 200).unwrap();
        // Average rate = out per unit in, in parts-per-million to stay integer.
        let rate_small = small * 1_000_000 / 1_000;
        let rate_big = big * 1_000_000 / 300_000_000;
        assert!(
            rate_big < rate_small,
            "large move off the peak not steeper: {rate_big} vs {rate_small} ppm"
        );

        // 2. Directional: an identical buy on reserves already skewed off the
        //    target fills worse than the same buy at the balanced peak.
        let near = shaped(100_000, 1_000_000, 1_000_000, true, 1, 1, 200).unwrap();
        let far = shaped(100_000, 1_900_000, 100_000, true, 1, 1, 200).unwrap();
        assert!(
            far < near,
            "away-from-target fill {far} not steeper than near {near}"
        );
    }

    #[test]
    fn target_price_moves_the_peak() {
        // Target price = 2 ANSEM per token. Value-balanced reserves are
        // ansem = token * 2. A small ANSEM buy should net ~= input / price and
        // strictly beat constant product.
        let out = shaped(1_000_000, 2_000_000_000, 1_000_000_000, true, 2, 1, 100).unwrap();
        let cp = cp_out(1_000_000, 2_000_000_000, 1_000_000_000);
        assert!(out > cp, "shaped {out} not flatter than cp {cp} at p=2");
        // ~500_000 tokens for 1e6 ANSEM at price 2, near-flat.
        assert!(out > 499_800 && out <= 500_100, "out {out} not near 1/price");
    }

    #[test]
    fn token_in_direction_prices() {
        // Selling token for ANSEM at price 2: ~1e6 tokens should fetch ~2e6
        // ANSEM near the peak, beating constant product.
        let out = shaped(1_000_000, 2_000_000_000, 1_000_000_000, false, 2, 1, 100).unwrap();
        let cp = cp_out(1_000_000, 1_000_000_000, 2_000_000_000);
        assert!(out > cp, "shaped {out} not flatter than cp {cp}");
        assert!(out > 1_999_000 && out <= 2_001_000, "out {out} not near price*in");
    }

    #[test]
    fn degenerate_inputs_fall_back() {
        assert!(shaped(0, 10, 10, true, 1, 1, 100).is_none());
        assert!(shaped(10, 0, 10, true, 1, 1, 100).is_none());
        assert!(shaped(10, 10, 0, true, 1, 1, 100).is_none());
        assert!(shaped(10, 10, 10, true, 1, 1, 0).is_none());
        assert!(shaped(10, 10, 10, true, 0, 1, 100).is_none());
        assert!(shaped(10, 10, 10, true, 1, 0, 100).is_none());
    }

    fn init(deps: DepsMut, num: u128, den: u128, c: u64, fee: u16, tol: u16) {
        instantiate(
            deps,
            cosmwasm_std::testing::mock_env(),
            cosmwasm_std::testing::mock_info("admin", &[]),
            InstantiateMsg {
                admin: "admin".into(),
                target_price_num: Uint128::new(num),
                target_price_den: Uint128::new(den),
                concentration: c,
                fee_bps: fee,
                tolerance_bps: tol,
            },
        )
        .unwrap();
    }

    #[test]
    fn decide_returns_delta_and_charges_fee() {
        let mut deps = cosmwasm_std::testing::mock_dependencies();
        // Balanced reserves at target 1:1 -> squarely inside the band.
        init(deps.as_mut(), 1, 1, 100, 30, 500);
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

    /// The tolerance-band gate: a target price that has drifted off the live pool
    /// ratio must fall back to Proceed (else the shaped quote hands arbitrage a
    /// better-than-market fill the AMM settles straight out of reserves), while a
    /// target that tracks the pool still returns a Delta.
    #[test]
    fn tolerance_band_gates_the_delta() {
        // Pool ratio is ~1:1 (balanced 1e9/1e9), target says the token is worth
        // 5 ANSEM. 400% off, 1% band -> Proceed.
        let mut deps = cosmwasm_std::testing::mock_dependencies();
        init(deps.as_mut(), 5, 1, 100, 0, 100);
        assert_eq!(
            decide(deps.as_ref(), ctx(1_000_000, 1_000_000_000, 1_000_000_000, true)),
            HookDecision::Proceed,
            "off-band target must Proceed"
        );

        // Reserves value-balanced at the same target (ar = 2*tr, target = 2/1):
        // in band -> Delta.
        let mut deps = cosmwasm_std::testing::mock_dependencies();
        init(deps.as_mut(), 2, 1, 100, 0, 100);
        match decide(deps.as_ref(), ctx(1_000_000, 2_000_000_000, 1_000_000_000, true)) {
            HookDecision::Delta { .. } => {}
            other => panic!("in-band target should Delta, got {other:?}"),
        }
    }

    /// Regression: the Newton solver at extreme reserves + max concentration
    /// overflows its `Uint256` intermediates. It must degrade to `None` (→
    /// Proceed) rather than panic in the read-only `before_swap` query, which
    /// would brick every swap on the pool.
    #[test]
    fn solver_at_extreme_reserves_proceeds_without_panic() {
        // Directly on the pure pricer.
        assert!(shaped(
            u128::MAX,
            u128::MAX,
            u128::MAX,
            true,
            1,
            1,
            MAX_CONCENTRATION
        )
        .is_none());
        // And through decide(): target 1:1 with equal huge reserves is in band,
        // so it reaches the solver, which must Proceed rather than trap.
        let mut deps = cosmwasm_std::testing::mock_dependencies();
        init(deps.as_mut(), 1, 1, MAX_CONCENTRATION, 30, MAX_TOLERANCE_BPS);
        assert_eq!(
            decide(deps.as_ref(), ctx(u128::MAX, u128::MAX, u128::MAX, true)),
            HookDecision::Proceed
        );
    }

    #[test]
    fn instantiate_rejects_out_of_range_config() {
        let mut deps = cosmwasm_std::testing::mock_dependencies();
        let env = cosmwasm_std::testing::mock_env();
        let info = cosmwasm_std::testing::mock_info("admin", &[]);
        let base = |c: u64, num: u128, den: u128, fee: u16, tol: u16| InstantiateMsg {
            admin: "admin".into(),
            target_price_num: Uint128::new(num),
            target_price_den: Uint128::new(den),
            concentration: c,
            fee_bps: fee,
            tolerance_bps: tol,
        };
        // concentration over the cap
        assert!(matches!(
            instantiate(deps.as_mut(), env.clone(), info.clone(), base(MAX_CONCENTRATION + 1, 1, 1, 0, 100)).unwrap_err(),
            ContractError::BadConcentration {}
        ));
        // target component over the cap
        assert!(matches!(
            instantiate(deps.as_mut(), env.clone(), info.clone(), base(100, MAX_PRICE_COMPONENT + 1, 1, 0, 100)).unwrap_err(),
            ContractError::BadTarget {}
        ));
        // tolerance over the cap
        assert!(matches!(
            instantiate(deps.as_mut(), env.clone(), info.clone(), base(100, 1, 1, 0, MAX_TOLERANCE_BPS + 1)).unwrap_err(),
            ContractError::BadTolerance {}
        ));
    }

    #[test]
    fn unauthorized_update_is_rejected() {
        let mut deps = cosmwasm_std::testing::mock_dependencies();
        init(deps.as_mut(), 1, 1, 100, 30, 500);
        let err = execute(
            deps.as_mut(),
            cosmwasm_std::testing::mock_env(),
            cosmwasm_std::testing::mock_info("mallory", &[]),
            ExecuteMsg::UpdateConfig {
                admin: None,
                target_price_num: None,
                target_price_den: None,
                concentration: Some(5),
                fee_bps: None,
                tolerance_bps: None,
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
    }
}
