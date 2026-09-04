use cosmwasm_schema::cw_serde;
use cosmwasm_std::{
    to_binary, Addr, Coin, Deps, QuerierWrapper, StdError, SubMsg, Uint128, WasmMsg,
};

use crate::error::ContractError;

/// Which callbacks a hook implements.
///
/// Uniswap V4 encodes this in the hook's contract address by mining a vanity
/// key. CosmWasm addresses derive from code id and instance sequence, so there
/// are no bits to mine and no gas reason to; permissions are recorded in pool
/// state instead. Same outcome, different mechanism.
pub mod flags {
    pub const BEFORE_SWAP: u16 = 1 << 0;
    pub const AFTER_SWAP: u16 = 1 << 1;
    // Reserved for stage 2 so hook authors can rely on stable bit positions.
    pub const BEFORE_ADD_LIQUIDITY: u16 = 1 << 2;
    pub const AFTER_ADD_LIQUIDITY: u16 = 1 << 3;
    pub const BEFORE_REMOVE_LIQUIDITY: u16 = 1 << 4;
    pub const AFTER_REMOVE_LIQUIDITY: u16 = 1 << 5;
    pub const BEFORE_INITIALIZE: u16 = 1 << 6;
    pub const AFTER_INITIALIZE: u16 = 1 << 7;
    pub const BEFORE_DONATE: u16 = 1 << 8;
    pub const AFTER_DONATE: u16 = 1 << 9;
}

#[cw_serde]
pub struct HookConfig {
    pub address: Addr,
    pub flags: u16,
}

impl HookConfig {
    pub fn has(&self, flag: u16) -> bool {
        self.flags & flag != 0
    }
}

/// Context handed to a decision query. Deliberately everything the hook needs
/// to price or veto the swap, so it never has to query the AMM back mid-call.
#[cw_serde]
pub struct SwapContext {
    pub token_address: String,
    pub sender: String,
    /// true = ANSEM in / token out
    pub offer_ansem: bool,
    pub input_amount: Uint128,
    pub ansem_reserve: Uint128,
    pub token_reserve: Uint128,
    /// Fee the AMM would apply if the hook says nothing.
    pub default_fee_bps: u16,
}

/// What a `before_*` hook may return.
///
/// This is a *query*, not an execute. In CosmWasm a query is synchronous and
/// can return a value but cannot mutate; a SubMsg mutates but its reply lands
/// after the swap is already decided. Pricing decisions therefore have to be
/// queries, which also makes them impossible to reenter.
#[cw_serde]
pub enum HookDecision {
    /// Run the AMM's own math unchanged.
    Proceed,
    /// Abort the whole message.
    Reject { reason: String },
    /// Use this fee for this call only.
    OverrideFee { fee_bps: u16 },
    /// Replace the curve entirely: the AMM settles exactly these amounts and
    /// never runs its own constant-product math. This is what lets a single
    /// pool implement a different pricing curve (stable, oracle-pegged,
    /// auction, whatever the hook author writes).
    Delta {
        amount_in: Uint128,
        amount_out: Uint128,
    },
}

#[cw_serde]
pub enum HookQuery {
    BeforeSwap { ctx: SwapContext },
}

#[cw_serde]
pub enum HookExecute {
    AfterSwap {
        token_address: String,
        sender: String,
        offer_ansem: bool,
        input_amount: Uint128,
        output_amount: Uint128,
        fee_amount: Uint128,
    },
}

/// Absolute ceiling on a hook-supplied fee, mirroring the AMM's own cap. A
/// pool creator picks the hook, so a malicious one must not be able to set a
/// confiscatory fee.
pub const MAX_HOOK_FEE_BPS: u16 = 1000;

/// What the AMM should actually do for this swap.
#[derive(Debug, PartialEq)]
pub struct SwapPlan {
    pub fee_bps: u16,
    /// `Some((amount_in, amount_out))` means the hook priced this swap itself
    /// and the constant-product math is skipped.
    pub delta: Option<(Uint128, Uint128)>,
}

/// Ask the hook whether and how this swap should proceed.
///
/// A hook that errors, or returns something unparseable, fails the whole
/// message rather than being skipped: silently ignoring a hook would let a
/// broken hook disable the very policy the pool installed it for.
pub fn before_swap(
    querier: &QuerierWrapper,
    hook: &Option<HookConfig>,
    ctx: SwapContext,
) -> Result<SwapPlan, ContractError> {
    let default_fee = ctx.default_fee_bps;
    let plain = SwapPlan { fee_bps: default_fee, delta: None };
    let Some(h) = hook else { return Ok(plain) };
    if !h.has(flags::BEFORE_SWAP) {
        return Ok(plain);
    }
    let offered = ctx.input_amount;
    let available_out = if ctx.offer_ansem { ctx.token_reserve } else { ctx.ansem_reserve };

    let decision: HookDecision = querier
        .query_wasm_smart(h.address.clone(), &HookQuery::BeforeSwap { ctx })
        .map_err(|e| {
            ContractError::Std(StdError::generic_err(format!("hook before_swap failed: {e}")))
        })?;

    match decision {
        HookDecision::Proceed => Ok(plain),
        HookDecision::Reject { reason } => Err(ContractError::Std(StdError::generic_err(
            format!("swap rejected by hook: {reason}"),
        ))),
        HookDecision::OverrideFee { fee_bps } => {
            if fee_bps > MAX_HOOK_FEE_BPS {
                return Err(ContractError::Std(StdError::generic_err(format!(
                    "hook fee {fee_bps} bps exceeds max {MAX_HOOK_FEE_BPS}"
                ))));
            }
            Ok(SwapPlan { fee_bps, delta: None })
        }
        HookDecision::Delta { amount_in, amount_out } => {
            // The hook is untrusted code chosen by the pool creator, so these
            // invariants are enforced here rather than assumed. They are the
            // whole reason custom accounting is safe to allow.

            // 1. It may not spend more than the user actually sent, and may not
            //    leave a remainder stranded in the contract. Partial fills would
            //    need an explicit refund path; require exact consumption.
            if amount_in != offered {
                return Err(ContractError::Std(StdError::generic_err(format!(
                    "hook delta amount_in {amount_in} does not match offered {offered}"
                ))));
            }
            // 2. It may not pay out more than the pool holds.
            if amount_out > available_out {
                return Err(ContractError::Std(StdError::generic_err(format!(
                    "hook delta amount_out {amount_out} exceeds reserve {available_out}"
                ))));
            }
            // 3. A zero payout is a rejection dressed up as a fill; make the
            //    hook say Reject so the caller gets a reason.
            if amount_out.is_zero() {
                return Err(ContractError::Std(StdError::generic_err(
                    "hook delta amount_out is zero; use Reject to decline a swap",
                )));
            }
            Ok(SwapPlan { fee_bps: 0, delta: Some((amount_in, amount_out)) })
        }
    }
}

/// Fire-and-forget notification after the swap has been applied. Emitted as a
/// SubMsg so the hook can record state; its failure reverts the swap, which is
/// what a pool that installed an accounting hook would want.
///
/// `funds` are the skimmed fee coins the AMM diverts to this hook (see the
/// pool's `skim_bps`). They are empty for a pure observation hook; when
/// non-empty the AMM has already removed them from the pool's reserves, so the
/// hook receives real value to route (e.g. the Fee-Share Horn → Horn Vault).
pub fn after_swap(
    hook: &Option<HookConfig>,
    msg: HookExecute,
    funds: Vec<Coin>,
) -> Result<Option<SubMsg>, ContractError> {
    let Some(h) = hook else { return Ok(None) };
    if !h.has(flags::AFTER_SWAP) {
        return Ok(None);
    }
    Ok(Some(SubMsg::new(WasmMsg::Execute {
        contract_addr: h.address.to_string(),
        msg: to_binary(&msg)?,
        funds,
    })))
}

/// Validate a hook at pool-creation time: the address must resolve and the
/// declared flags must be non-empty, so a typo does not produce a pool with a
/// hook that is never called.
pub fn validate(deps: &Deps, hook: &Option<HookConfig>) -> Result<(), ContractError> {
    let Some(h) = hook else { return Ok(()) };
    deps.api.addr_validate(h.address.as_str())?;
    if h.flags == 0 {
        return Err(ContractError::Std(StdError::generic_err(
            "hook declares no callbacks; omit the hook instead",
        )));
    }
    Ok(())
}

// ── Stage 2: the remaining six callbacks ────────────────────────────────────
//
// Same split as swaps: a `before_*` decision query that can veto, and an
// `after_*` SubMsg that lets the hook record state. Liquidity contexts carry
// the locked-LP fields, because the single most valuable thing a
// before_remove_liquidity hook can do on this chain is enforce that the
// launchpad's graduation liquidity stays put.

#[cw_serde]
pub struct LiquidityContext {
    pub token_address: String,
    pub sender: String,
    pub ansem_amount: Uint128,
    pub token_amount: Uint128,
    pub shares: Uint128,
    pub ansem_reserve: Uint128,
    pub token_reserve: Uint128,
    pub lp_total_supply: Uint128,
    pub locked_lp_supply: Uint128,
    pub locked_lp_unlock_at: Option<u64>,
}

#[cw_serde]
pub struct InitializeContext {
    pub token_address: String,
    pub creator: String,
    pub ansem_amount: Uint128,
    pub token_amount: Uint128,
}

#[cw_serde]
pub struct DonateContext {
    pub token_address: String,
    pub sender: String,
    pub ansem_amount: Uint128,
    pub token_amount: Uint128,
}

#[cw_serde]
pub enum HookQueryV2 {
    BeforeAddLiquidity { ctx: LiquidityContext },
    BeforeRemoveLiquidity { ctx: LiquidityContext },
    BeforeInitialize { ctx: InitializeContext },
    BeforeDonate { ctx: DonateContext },
}

#[cw_serde]
pub enum HookExecuteV2 {
    AfterAddLiquidity { ctx: LiquidityContext },
    AfterRemoveLiquidity { ctx: LiquidityContext },
    AfterInitialize { ctx: InitializeContext },
    AfterDonate { ctx: DonateContext },
}

/// Shared gate for every non-swap `before_*` callback.
///
/// These may only veto. Returning `OverrideFee` or `Delta` from a liquidity,
/// initialize or donate hook is a programming error and is rejected loudly
/// rather than ignored, so a hook author finds out immediately instead of
/// silently having no effect.
fn gate(
    querier: &QuerierWrapper,
    hook: &Option<HookConfig>,
    flag: u16,
    query: &HookQueryV2,
    what: &str,
) -> Result<(), ContractError> {
    let Some(h) = hook else { return Ok(()) };
    if !h.has(flag) {
        return Ok(());
    }
    let decision: HookDecision = querier
        .query_wasm_smart(h.address.clone(), query)
        .map_err(|e| {
            ContractError::Std(StdError::generic_err(format!("hook {what} failed: {e}")))
        })?;
    match decision {
        HookDecision::Proceed => Ok(()),
        HookDecision::Reject { reason } => Err(ContractError::Std(StdError::generic_err(
            format!("{what} rejected by hook: {reason}"),
        ))),
        _ => Err(ContractError::Std(StdError::generic_err(format!(
            "hook {what} may only return Proceed or Reject"
        )))),
    }
}

pub fn before_add_liquidity(
    q: &QuerierWrapper, hook: &Option<HookConfig>, ctx: LiquidityContext,
) -> Result<(), ContractError> {
    gate(q, hook, flags::BEFORE_ADD_LIQUIDITY,
         &HookQueryV2::BeforeAddLiquidity { ctx }, "before_add_liquidity")
}

pub fn before_remove_liquidity(
    q: &QuerierWrapper, hook: &Option<HookConfig>, ctx: LiquidityContext,
) -> Result<(), ContractError> {
    gate(q, hook, flags::BEFORE_REMOVE_LIQUIDITY,
         &HookQueryV2::BeforeRemoveLiquidity { ctx }, "before_remove_liquidity")
}

pub fn before_initialize(
    q: &QuerierWrapper, hook: &Option<HookConfig>, ctx: InitializeContext,
) -> Result<(), ContractError> {
    gate(q, hook, flags::BEFORE_INITIALIZE,
         &HookQueryV2::BeforeInitialize { ctx }, "before_initialize")
}

pub fn before_donate(
    q: &QuerierWrapper, hook: &Option<HookConfig>, ctx: DonateContext,
) -> Result<(), ContractError> {
    gate(q, hook, flags::BEFORE_DONATE,
         &HookQueryV2::BeforeDonate { ctx }, "before_donate")
}

/// Emit an `after_*` notification when the hook declares that callback.
pub fn notify(
    hook: &Option<HookConfig>, flag: u16, msg: &HookExecuteV2,
) -> Result<Option<SubMsg>, ContractError> {
    let Some(h) = hook else { return Ok(None) };
    if !h.has(flag) {
        return Ok(None);
    }
    Ok(Some(SubMsg::new(WasmMsg::Execute {
        contract_addr: h.address.to_string(),
        msg: to_binary(msg)?,
        funds: vec![],
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::mock_dependencies;
    use cosmwasm_std::{from_binary, to_binary, ContractResult, SystemResult, WasmQuery};

    fn ctx() -> SwapContext {
        SwapContext {
            token_address: "token".into(),
            sender: "alice".into(),
            offer_ansem: true,
            input_amount: Uint128::new(1_000),
            ansem_reserve: Uint128::new(1_000_000),
            token_reserve: Uint128::new(1_000_000),
            default_fee_bps: 100,
        }
    }

    fn hook(flags: u16) -> Option<HookConfig> {
        Some(HookConfig { address: Addr::unchecked("hookaddr"), flags })
    }

    /// Wire a querier that answers every wasm smart query with `decision`.
    fn deps_returning(decision: HookDecision) -> cosmwasm_std::OwnedDeps<
        cosmwasm_std::MemoryStorage,
        cosmwasm_std::testing::MockApi,
        cosmwasm_std::testing::MockQuerier,
    > {
        let mut deps = mock_dependencies();
        deps.querier.update_wasm(move |q| match q {
            WasmQuery::Smart { .. } => {
                SystemResult::Ok(ContractResult::Ok(to_binary(&decision).unwrap()))
            }
            _ => SystemResult::Ok(ContractResult::Err("unexpected".into())),
        });
        deps
    }

    #[test]
    fn no_hook_uses_default_fee() {
        let deps = mock_dependencies();
        assert_eq!(before_swap(&deps.as_ref().querier, &None, ctx()).unwrap().fee_bps, 100);
    }

    #[test]
    fn unflagged_hook_is_not_called() {
        // Flags say the hook does not implement before_swap, so the querier is
        // never consulted; a mock that would panic proves it.
        let deps = mock_dependencies();
        let h = hook(flags::AFTER_SWAP);
        assert_eq!(before_swap(&deps.as_ref().querier, &h, ctx()).unwrap().fee_bps, 100);
    }

    #[test]
    fn proceed_keeps_default_fee() {
        let deps = deps_returning(HookDecision::Proceed);
        let h = hook(flags::BEFORE_SWAP);
        assert_eq!(before_swap(&deps.as_ref().querier, &h, ctx()).unwrap().fee_bps, 100);
    }

    #[test]
    fn override_fee_is_applied() {
        let deps = deps_returning(HookDecision::OverrideFee { fee_bps: 42 });
        let h = hook(flags::BEFORE_SWAP);
        assert_eq!(before_swap(&deps.as_ref().querier, &h, ctx()).unwrap().fee_bps, 42);
    }

    #[test]
    fn reject_fails_the_swap() {
        let deps = deps_returning(HookDecision::Reject { reason: "blocked".into() });
        let h = hook(flags::BEFORE_SWAP);
        let err = before_swap(&deps.as_ref().querier, &h, ctx()).unwrap_err();
        assert!(format!("{err}").contains("blocked"));
    }

    /// A hook must not be able to set a confiscatory fee just because the pool
    /// creator installed it.
    #[test]
    fn override_fee_is_capped() {
        let deps = deps_returning(HookDecision::OverrideFee { fee_bps: MAX_HOOK_FEE_BPS + 1 });
        let h = hook(flags::BEFORE_SWAP);
        assert!(before_swap(&deps.as_ref().querier, &h, ctx()).is_err());
    }

    /// A hook may price the swap itself; the AMM then skips its own curve.
    #[test]
    fn delta_replaces_the_curve() {
        let deps = deps_returning(HookDecision::Delta {
            amount_in: Uint128::new(1_000),   // must equal ctx().input_amount
            amount_out: Uint128::new(7),      // an arbitrary price the curve would never give
        });
        let plan = before_swap(&deps.as_ref().querier, &hook(flags::BEFORE_SWAP), ctx()).unwrap();
        assert_eq!(plan.delta, Some((Uint128::new(1_000), Uint128::new(7))));
        assert_eq!(plan.fee_bps, 0, "the hook priced it, so the AMM adds no fee");
    }

    /// The three invariants that make untrusted custom accounting safe.
    #[test]
    fn delta_cannot_spend_more_than_offered() {
        let deps = deps_returning(HookDecision::Delta {
            amount_in: Uint128::new(1_001),   // ctx() offered 1_000
            amount_out: Uint128::new(7),
        });
        let err = before_swap(&deps.as_ref().querier, &hook(flags::BEFORE_SWAP), ctx()).unwrap_err();
        assert!(format!("{err}").contains("does not match offered"));
    }

    #[test]
    fn delta_cannot_drain_more_than_the_reserve() {
        let deps = deps_returning(HookDecision::Delta {
            amount_in: Uint128::new(1_000),
            amount_out: Uint128::new(1_000_001), // reserve is 1_000_000
        });
        let err = before_swap(&deps.as_ref().querier, &hook(flags::BEFORE_SWAP), ctx()).unwrap_err();
        assert!(format!("{err}").contains("exceeds reserve"));
    }

    #[test]
    fn delta_zero_payout_must_use_reject() {
        let deps = deps_returning(HookDecision::Delta {
            amount_in: Uint128::new(1_000),
            amount_out: Uint128::zero(),
        });
        let err = before_swap(&deps.as_ref().querier, &hook(flags::BEFORE_SWAP), ctx()).unwrap_err();
        assert!(format!("{err}").contains("use Reject"));
    }

    #[test]
    fn after_swap_emitted_only_when_flagged() {
        let msg = || HookExecute::AfterSwap {
            token_address: "token".into(), sender: "alice".into(), offer_ansem: true,
            input_amount: Uint128::new(1), output_amount: Uint128::new(1),
            fee_amount: Uint128::new(0),
        };
        assert!(after_swap(&None, msg(), vec![]).unwrap().is_none());
        assert!(after_swap(&hook(flags::BEFORE_SWAP), msg(), vec![]).unwrap().is_none());
        assert!(after_swap(&hook(flags::AFTER_SWAP), msg(), vec![]).unwrap().is_some());
    }

    #[test]
    fn validate_rejects_flagless_hook() {
        let deps = mock_dependencies();
        assert!(validate(&deps.as_ref(), &hook(0)).is_err());
        assert!(validate(&deps.as_ref(), &hook(flags::BEFORE_SWAP)).is_ok());
        assert!(validate(&deps.as_ref(), &None).is_ok());
    }

    #[test]
    fn decision_wire_format_is_snake_case() {
        // Hook authors serialize these by hand; lock the JSON shape.
        let j = String::from_utf8(to_binary(&HookDecision::OverrideFee { fee_bps: 7 })
            .unwrap().to_vec()).unwrap();
        assert!(j.contains("override_fee"), "unexpected: {j}");
        let back: HookDecision = from_binary(&to_binary(&HookDecision::Proceed).unwrap()).unwrap();
        assert_eq!(back, HookDecision::Proceed);
    }

    fn liq_ctx() -> LiquidityContext {
        LiquidityContext {
            token_address: "token".into(), sender: "alice".into(),
            ansem_amount: Uint128::new(10), token_amount: Uint128::new(10),
            shares: Uint128::new(5), ansem_reserve: Uint128::new(1000),
            token_reserve: Uint128::new(1000), lp_total_supply: Uint128::new(100),
            locked_lp_supply: Uint128::new(50), locked_lp_unlock_at: None,
        }
    }

    #[test]
    fn liquidity_gate_passes_without_hook_or_flag() {
        let deps = mock_dependencies();
        assert!(before_remove_liquidity(&deps.as_ref().querier, &None, liq_ctx()).is_ok());
        assert!(before_remove_liquidity(
            &deps.as_ref().querier, &hook(flags::BEFORE_SWAP), liq_ctx()).is_ok());
    }

    /// The headline use: a hook refusing to let graduation liquidity leave.
    #[test]
    fn liquidity_gate_can_block_removal() {
        let deps = deps_returning(HookDecision::Reject { reason: "lp is locked".into() });
        let err = before_remove_liquidity(
            &deps.as_ref().querier, &hook(flags::BEFORE_REMOVE_LIQUIDITY), liq_ctx()).unwrap_err();
        assert!(format!("{err}").contains("lp is locked"));
    }

    /// A fee or delta from a liquidity hook is meaningless; fail loudly rather
    /// than silently doing nothing.
    #[test]
    fn liquidity_gate_rejects_pricing_decisions() {
        let deps = deps_returning(HookDecision::OverrideFee { fee_bps: 10 });
        let err = before_add_liquidity(
            &deps.as_ref().querier, &hook(flags::BEFORE_ADD_LIQUIDITY), liq_ctx()).unwrap_err();
        assert!(format!("{err}").contains("only return Proceed or Reject"));
    }

    #[test]
    fn notify_respects_flags() {
        let m = HookExecuteV2::AfterAddLiquidity { ctx: liq_ctx() };
        assert!(notify(&None, flags::AFTER_ADD_LIQUIDITY, &m).unwrap().is_none());
        assert!(notify(&hook(flags::AFTER_SWAP), flags::AFTER_ADD_LIQUIDITY, &m).unwrap().is_none());
        assert!(notify(&hook(flags::AFTER_ADD_LIQUIDITY), flags::AFTER_ADD_LIQUIDITY, &m)
            .unwrap().is_some());
    }
}
