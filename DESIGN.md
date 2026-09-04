# floorlaunch

Launchpad for funding-pegged synthetic tokens whose underlying is a
collectible-market price: graded trading cards (flagship asset class) or an
NFT collection's floor. No custody of the underlying, no vault. One Anchor
program.

## Asset classes

The program is underlying-agnostic: `Market.collection` is an opaque
identifier and all class differences live in the oracle relayer and listing
policy.

1. Graded cards (flagship, decided 2026-07-23). Underlying = one card+grade
   unit (e.g. PSA 10 of card X) or a basket index (e.g. vintage Pokemon
   PSA 10 index). Reference market is off-chain (eBay sold listings,
   TCGplayer, graded price guides) and far larger than any on-chain synth
   market, so the tail-wags-dog ceiling that limits NFT floors mostly does
   not apply. Relayer consumes per-card per-grade price APIs (TCG Price
   Lookup et al.), cross-checks tokenized venues (Collector Crypt,
   Courtyard), and converts USD to lamports via Pyth SOL/USD. Data refresh
   is daily, which the clamped funding design tolerates. Listing policy
   favors mid-tier cards with large graded populations and steady sales
   volume over thin grails. Physical delivery valve (v2) becomes practical:
   a Collector Crypt vaulted-card NFT of matching card+grade is a clean
   on-chain bearer of the physical.
2. NFT collection floors (secondary). As specified below; index built from
   collection bids and sale TWAPs on Tensor and Magic Eden.

## Product summary

For each whitelisted collection there is one market with one SPL token
("synth"). 1,000,000 synth = 1 floor NFT, so target price per synth is
`index / 1_000_000`. The token starts on a bonding curve (launch phase), then
graduates into an internal constant-product AMM. Price is tethered to the
floor index by CDP mint/burn arbitrage plus a clamped funding rate on shorts.

Natural users:
- Longs: buy synth on the curve/AMM for liquid floor exposure.
- Shorts: NFT holders hedge by posting SOL collateral, minting synth at the
  index, and selling it. They buy back and burn to close.

## Why this shape (constraints it satisfies)

- No vault: adverse selection, lemons, and custody honeypot all avoided.
- Oracle manipulation cannot drain a pot: a bad index print only tilts
  funding flow (clamped per day) and mint/burn pricing (breaker halts on
  large deviation). There is no oracle-priced redemption against pooled
  third-party money.
- Tail-wags-dog ceiling: per-market open interest cap, set relative to real
  collection depth, limits synthetic size vs the NFT market.
- Blue chips only: market creation is admin-gated (depth criteria enforced
  off chain at listing time).

## Price index (oracle)

Push oracle, authority-signed (same relayer pattern as prior BWICK oracle
work). The relayer computes off chain: median of {top collection bid, sale
TWAP} across Tensor and Magic Eden, outlier-rejected, and pushes
`push_index(price_lamports)` for the whole NFT (not per synth).

On chain per market:
- `index_twap` = time-weighted EMA of accepted observations, pulled toward
  each new push by min(dt, window)/window over `index_window_secs`
- min interval between pushes (`min_push_interval_secs`)
- circuit breaker: if a new observation deviates from current TWAP by more
  than `breaker_bps`, the observation is stored but the market flips to
  `Frozen` (mint, burn, swap, funding paused; add_collateral still allowed;
  liquidations paused). Admin unfreezes after review.

## Launch phase (bonding curve)

pump.fun-style constant product with virtual reserves:
- virtual SOL `v_sol`, virtual token `v_tok`, invariant `k = v_sol * v_tok`
- `curve_buy(sol_in)` mints tokens out of the curve allocation;
  `curve_sell(tok_in)` returns SOL. Fee `curve_fee_bps` to fee vault.
- Graduation when real SOL raised >= `graduation_target_sol`:
  - `insurance_share_bps` of raised SOL seeds the market insurance fund
  - the rest becomes AMM real SOL reserve, paired against
    `amm_seed_tokens` minted to the AMM at the curve's closing price
  - status Bootstrap -> Live

Curve tokens are backed by pool SOL (like any launchpad token), not by
shorts. CDP supply comes later and is separately collateralized.

## Live phase

### Internal AMM
Constant product on real reserves with `amm_fee_bps`. Mark price EMA
(`mark_ema`) updated on every swap and on the funding crank, half-life
`mark_ema_halflife_secs`. All tether math uses `mark_ema`, never spot, so
single-block AMM manipulation cannot move funding or liquidation checks.

### CDP shorts
- `open_short(collateral_sol, tokens_to_mint)`: requires
  `collateral >= tokens * index_per_token * initial_cr_bps / 10000`.
  Tokens are minted to the shorter (they sell them however they like).
- `add_collateral`, `withdraw_collateral` (post-withdraw CR must be >= initial)
- `repay_burn(tokens)`: burns from the shorter's wallet, reduces debt.
  Collateral withdrawable as CR allows.
- Debt is stored funding-indexed (see below).

Tether logic:
- mark above index: minting at index and selling at mark is profitable,
  new supply pushes mark down.
- mark below index: shorts buy back cheap and burn for profit, buy
  pressure pushes mark up. Funding also pays anyone willing to be short
  while mark sits under index, recruiting new shorts.

### Funding
Crank-driven (`accrue_funding`, permissionless, rate-limited):
- `premium = (mark_ema - index_per_token) / index_per_token`
- `rate_per_day = clamp(premium * funding_k_bps, +-max_funding_bps_per_day)`
- Applied to short debt via a global cumulative `funding_index`:
  when mark > index, shorts' effective debt shrinks (they are being paid
  to hold the tether side); when mark < index, shorts' debt grows, pushing
  them to buy back and burn, which lifts mark.
- Funding on shorts is settled against the insurance fund in v1 (long-side
  staking pool can join in v2). Insurance fund flow is bounded by the clamp
  and by per-market OI caps.

### Liquidation
- CR = collateral / (debt_tokens * index_per_token)
- below `maintenance_cr_bps`: permissionless `liquidate` burns tokens
  supplied by the liquidator equal to the debt (full liquidation in v1) and
  pays them collateral worth `debt * (1 + liq_bonus_bps)`; remainder to the
  position owner; shortfall covered by insurance fund.

### Caps and guards
- `max_open_interest_tokens` per market (sum of all CDP debt)
- funding clamp per day, breaker on index jumps, EMA mark everywhere
- admin: freeze/unfreeze, param updates, oracle authority rotation

## Accounts (PDAs)

- `Global` ["global"]: admin, oracle_authority, fee_vault, default params
- `Market` ["market", collection_key]: status, synth mint, params, curve
  state, AMM reserves, index ring buffer + TWAP, mark EMA, funding index,
  OI totals, insurance fund lamports, vaults (curve/AMM/collateral/insurance
  are lamport balances on the market's sol_vault PDA, tracked by field)
- `ShortPosition` ["short", market, owner]: collateral lamports,
  debt_tokens (funding-indexed snapshot), entry funding index

Synth mint PDA ["mint", market], authority = market PDA. 6 decimals.
`TOKENS_PER_NFT = 1_000_000`, so `index_per_token_lamports =
index_lamports / 1_000_000` (u128 math, scaled 1e6 where needed).

## Instructions

init_global, set_params, set_oracle_authority,
create_market (admin), push_index (oracle), freeze / unfreeze (admin),
curve_buy, curve_sell, graduate,
amm_buy, amm_sell,
open_short, add_collateral, withdraw_collateral, repay_burn,
accrue_funding (crank), liquidate,
withdraw_fees (admin).

## v2 (explicitly out of scope now)

- physical delivery valve (deliver floor NFT, auction, proceeds to pool)
- long-side staked funding
- permissionless market creation with on-chain depth attestations
- Long-style timed auction frames instead of plain curve
