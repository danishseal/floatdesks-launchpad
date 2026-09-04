/**
 * Catalog of the Horns, the v4-style hook contracts on the graduation AMM.
 * `slug` matches the raw source served from /public/horns/<slug>.rs (copied
 * verbatim from contracts/horn-<slug>/src/lib.rs), so the explorer previews the
 * real code. Blurbs are honest descriptions of what each contract does, and
 * `example` is a concrete "how it would play out" scenario for each one.
 *
 * `icon` is an optional path to a per-Horn logo (dropped into /public/horns/art/
 * once art lands); until one is set the UI shows a neutral monogram fallback.
 */

export type HornCategory = "Reward layer" | "Fee strategy" | "Liquidity & pricing" | "Composition" | "Reference";

export type Horn = {
  slug: string;
  name: string;
  tagline: string;
  category: HornCategory;
  /** Which hook points the contract implements. */
  hooks: string[];
  blurb: string;
  points: string[];
  /** A concrete, illustrative walkthrough of the Horn in action. */
  example: string;
  /** Optional path to a logo (e.g. "/horns/art/vault.png"). Unset -> monogram. */
  icon?: string;
};

export const HORN_CATEGORIES: HornCategory[] = [
  "Reward layer",
  "Fee strategy",
  "Liquidity & pricing",
  "Composition",
  "Reference",
];

export const HORNS: Horn[] = [
  // ── Reward layer ────────────────────────────────────────────────────────
  {
    slug: "vault",
    icon: "/horns/art/vault.png",
    name: "Horn Vault",
    tagline: "The reward keystone: stake ANSEM or CHANSE, earn every pool's skim",
    category: "Reward layer",
    hooks: ["stake / unstake / claim"],
    blurb:
      "A MasterChef-style staking contract with two global sinks (ANSEM and CHANSE). Every graduated pool's skimmed fee flows into these sinks, and stakers earn a per-share cut that accrues each block. Rewards are tracked with a 1e18-precision accumulator in 256-bit math so dust never strands.",
    points: [
      "Two shared sinks: one for ANSEM stakers, one for CHANSE stakers",
      "Accrue-per-share accounting; deposits are permissionless",
      "Optional stake cooldown (min_stake_seconds) to blunt just-in-time farming",
      "Reward denominations are capped so the harvest loop is always bounded",
    ],
    example:
      "You hold 10,000 CHANSE and stake it in the CHANSE sink. Through the day, graduated pools skim fees into that sink and your share accrues every block. You claim the accumulated rewards without your stake ever leaving, then unstake once the cooldown clears.",
  },
  {
    slug: "feeshare",
    icon: "/horns/art/feeshare.png",
    name: "Fee-Share",
    tagline: "Routes each swap's skim into the Vault's two sinks",
    category: "Reward layer",
    hooks: ["after_swap"],
    blurb:
      "The plumbing between the AMM and the Vault. It receives the after-swap skim and splits it into the ANSEM and CHANSE sinks by a configured ratio. The deposit rides as a reply-on-error sub-message, so a paused or broken Vault can never revert the underlying swap; the skim is simply retained for a later flush.",
    points: [
      "Splits the skim ANSEM/CHANSE by a set ratio",
      "reply-on-error: a broken Vault never breaks a trade",
      "Vault liveness is queried defensively; a failed query degrades, not reverts",
    ],
    example:
      "A trader swaps on a graduated coin and the pool takes its usual fee. Fee-Share catches that skim and drops, say, 60% into the ANSEM sink and 40% into the CHANSE sink. If the Vault happens to be paused, the swap still completes and the skim is held safely for the next flush.",
  },
  {
    slug: "gauge",
    icon: "/horns/art/gauge.png",
    name: "Gauge",
    tagline: "Anti-JIT vesting gate in front of the Vault",
    category: "Reward layer",
    hooks: ["after_swap", "settle"],
    blurb:
      "Sits in front of the Vault and buffers incoming skim into short vesting buckets keyed by maturity. A permissionless settle() drains only matured buckets, oldest first, capped per call, bounding how much a just-in-time staker can capture by staking, settling, and unstaking in one shot.",
    points: [
      "Skim vests over a short window before it reaches stakers",
      "settle() only touches matured buckets, paginated by a per-call cap",
      "The real per-staker guarantee is the Vault's own stake cooldown",
    ],
    example:
      "Someone tries to stake right before a big swap, grab its skim, then unstake. Gauge buffers that swap's skim into a short vesting bucket, so it has not matured by the time they leave. When settle() later drains the matured bucket, the reward goes to the stakers who actually stayed.",
  },
  {
    slug: "rehypo",
    icon: "/horns/art/rehypo.png",
    name: "Rehypothecation",
    tagline: "Treasury Horn: banks the skim, optionally deploys idle reserves",
    category: "Reward layer",
    hooks: ["after_swap", "rebalance / harvest"],
    blurb:
      "Banks the skim as a treasury and can deploy idle reserves into a pluggable external yield sink, keeping a minimum reserve ratio on hand. Permissionless rebalance/harvest keep the split honest. Ships with no sink wired by default, so out of the box it is a safe passive fee bank.",
    points: [
      "Pluggable yield sink (deposit / withdraw / balance interface)",
      "Enforced reserve floor; sink can't be repointed while funds are deployed",
      "Default sink is unset; passive treasury until governance wires one",
    ],
    example:
      "A pool's skim collects in the treasury Horn. It keeps, say, a 20% reserve on hand; if governance has wired a yield sink, it deploys the idle 80% to earn and harvests the yield back to holders. With no sink wired (the default), it simply banks the fees as a safe passive treasury.",
  },

  // ── Fee strategy ────────────────────────────────────────────────────────
  {
    slug: "dynfee",
    icon: "/horns/art/dynfee.png",
    name: "Dynamic Fee",
    tagline: "Adjusts the swap fee to conditions",
    category: "Fee strategy",
    hooks: ["before_swap (OverrideFee)"],
    blurb:
      "Overrides the pool fee per swap based on trade conditions rather than a flat rate: higher fee for the moves you want to price for, lower for the flow you want to attract. The override is always clamped to a hard maximum so a misconfiguration can never brick trading.",
    points: [
      "Per-swap fee override via the before_swap hook",
      "Hard-capped at MAX_HOOK_FEE_BPS",
    ],
    example:
      "Volatility spikes and heavy one-sided sell flow hits the pool. For that flow, Dynamic Fee raises the swap fee from, say, 0.3% up toward 0.9% to price the risk, then eases it back down as conditions calm, never crossing the hard fee cap.",
  },
  {
    slug: "decay",
    icon: "/horns/art/decay.png",
    name: "Fee Decay",
    tagline: "Launch fee starts high and decays down",
    category: "Fee strategy",
    hooks: ["before_swap (OverrideFee)"],
    blurb:
      "Starts a pool at an elevated fee right after graduation and decays it toward the base rate over a set window. Snipers who rush the first blocks pay the most; the fee settles to normal for everyone who follows.",
    points: [
      "Time/blocks-based fee ramp from a launch high to the base fee",
      "Front-runs the front-runners without a permanent tax",
    ],
    example:
      "A coin graduates. For the first hour the fee starts high, say 5%, and decays toward the 0.3% base. A sniper buying in the first block pays the full 5%; someone who buys an hour later pays the normal 0.3%.",
  },
  {
    slug: "auction",
    icon: "/horns/art/auction.png",
    name: "Fee Auction (am-AMM)",
    tagline: "Managers bid to own the pool's fee and collect its skim",
    category: "Fee strategy",
    hooks: ["before_swap (OverrideFee)", "after_swap"],
    blurb:
      "An am-AMM fee seat: managers bid (highest deposit wins) to own a pool's fee, paying rent that decays per second. The sitting manager sets the fee via the before_swap override and collects the skim as claimable. This recaptures MEV/arbitrage value that would otherwise leak to searchers and routes it back on-chain.",
    points: [
      "Highest bidder holds the fee seat; rent decays per second",
      "Rent settles at the old rate before any config change; no retroactive seizure",
      "A sitting manager can't be out-rented mid-tenure or have rent raised on them",
    ],
    example:
      "Two managers want the fee seat on a hot pool. Manager A bids the higher deposit and wins, paying rent that ticks down each second. While seated, A sets the pool fee and collects its skim as claimable. If B later out-bids, A's rent settles at the old rate first, with no retroactive seizure.",
  },
  {
    slug: "schedule",
    icon: "/horns/art/schedule.png",
    name: "Dutch Fee Schedule",
    tagline: "Delta-priced ramp over a fixed launch window",
    category: "Fee strategy",
    hooks: ["before_swap (Delta)"],
    blurb:
      "Prices swaps against a scheduled curve that ramps over a fixed window after launch, then hands control back to the pool. Only applies inside a price-tolerance band; once the window ends or the pool wanders off-band, it steps aside and the swap runs on the plain AMM. Every fill is capped to a fraction of the reserve.",
    points: [
      "Time-boxed dutch schedule, then reverts to the pool",
      "Tolerance band + per-swap fill cap keep it from ever draining a reserve",
      "Overflow-safe: any math edge degrades to a normal swap, never a panic",
    ],
    example:
      "Right after launch, swaps are priced against a dutch schedule that ramps over a fixed window, say 30 minutes, then control hands back to the plain AMM. Each fill is capped to a slice of the reserve, and if price wanders outside the tolerance band the schedule steps aside early.",
  },
  {
    slug: "witness",
    icon: "/horns/art/witness.png",
    name: "Same-Block Witness",
    tagline: "Surcharges same-block follow-on swaps",
    category: "Fee strategy",
    hooks: ["before_swap (OverrideFee)", "after_swap"],
    blurb:
      "Witnesses prior swap activity within the same block and applies a surcharge to same-block follow-on trades, the classic sandwich shape. The extra fee makes the sandwich uneconomic and feeds the surcharge back into the reward layer.",
    points: [
      "Detects and surcharges same-block activity (anti-sandwich)",
      "Turns MEV pressure into holder yield",
    ],
    example:
      "A bot buys, waits for a victim's swap in the same block, then sells to sandwich them. Same-Block Witness spots the same-block follow-on and surcharges it, say an extra 2%, making the sandwich unprofitable and feeding that surcharge back to holders.",
  },

  // ── Liquidity & pricing ─────────────────────────────────────────────────
  {
    slug: "curve",
    icon: "/horns/art/curve.png",
    name: "StableSwap Curve",
    tagline: "Re-prices swaps on a StableSwap invariant",
    category: "Liquidity & pricing",
    hooks: ["before_swap (Delta)"],
    blurb:
      "Overrides the constant-product math with a StableSwap invariant (Newton-solved in 256-bit) for pegged or correlated pairs: deep, near-flat liquidity around the peg that steepens toward constant-product as reserves skew, so it can't be drained at par. The solver degrades to a normal swap on any numeric edge.",
    points: [
      "StableSwap depth for pegged/correlated assets",
      "No-panic solver: non-convergence or overflow → plain swap",
      "Priced purely from live reserves, so its quote can't drift from pool state",
    ],
    example:
      "Two pegged assets, say two dollar-tokens, trade in the pool. StableSwap Curve re-prices swaps on a near-flat invariant around the peg, so a large swap moves the price far less than constant-product would, while still steepening if the reserves skew hard.",
  },
  {
    slug: "ldf",
    icon: "/horns/art/ldf.png",
    name: "Liquidity Distribution",
    tagline: "Bunni-style shaped liquidity via delta-pricing",
    category: "Liquidity & pricing",
    hooks: ["before_swap (Delta)"],
    blurb:
      "Emulates a Bunni-v2 liquidity distribution function on a positionless AMM by delta-pricing against a shaped curve, concentrating depth around a target price. Applies only inside a tolerance band around that target, and its solver degrades to a normal swap on any overflow or non-convergence.",
    points: [
      "Concentrates depth at a configurable target price",
      "Tolerance band keeps target ≈ market before it acts",
      "Fully checked math; caps on concentration and price components",
    ],
    example:
      "A creator wants liquidity concentrated around a $0.01 target. Liquidity Distribution shapes the effective depth around that price, so trades near $0.01 get tight pricing. Once price drifts outside the tolerance band, it steps aside and the trade runs on the plain AMM.",
  },
  {
    slug: "arb",
    icon: "/horns/art/arb.png",
    name: "Oracle Arb",
    tagline: "Hands traders a capped, budgeted improvement toward the oracle",
    category: "Liquidity & pricing",
    hooks: ["before_swap (Delta)", "after_swap"],
    blurb:
      "References the ANSEM oracle: when the oracle price beats the pool's marginal price for the trader, it returns a capped Delta handing over the improvement, nudging the pool toward the reference. Every subsidy is drawn from a funded budget that decrements on each swap, so cumulative LP give-away is bounded. Requires a fresh oracle or it steps aside.",
    points: [
      "Oracle-referenced price improvement, per-swap capped",
      "Funded SUBSIDY_BUDGET bounds total LP-funded subsidy",
      "Stale/unavailable oracle → plain swap, never a panic",
    ],
    example:
      "The ANSEM oracle reads a fair price a couple percent above the pool's current marginal price. Oracle Arb hands the next buyer a capped slice of that improvement, nudging the pool toward fair value and drawing the subsidy from a funded budget that runs down over time. If the oracle is stale, it does nothing.",
  },
  {
    slug: "twamm",
    icon: "/horns/art/twamm.png",
    name: "TWAMM",
    tagline: "Large orders executed as time-sliced fills",
    category: "Liquidity & pricing",
    hooks: ["resting orders", "advance"],
    blurb:
      "A time-weighted AMM: park a large order and have it executed as time-proportional slices via a permissionless advance(), which measures each fill from the pool by reply. Spreads a whale order across time to cut price impact; TWAP-style execution built into the pool.",
    points: [
      "Resting orders filled in time-proportional slices",
      "Permissionless advance() drives execution; fills measured by reply",
    ],
    example:
      "A whale wants to sell a large bag without tanking the price. They park it as a TWAMM order and a permissionless advance() executes it as small, time-proportional slices over hours, spreading the impact instead of dumping it all in one swap.",
  },
  {
    slug: "limit",
    icon: "/horns/art/limit.png",
    name: "Limit Order Book",
    tagline: "On-chain resting orders, filled before the AMM",
    category: "Liquidity & pricing",
    hooks: ["place / cancel / claim", "swap-through-book"],
    blurb:
      "A price-ordered on-chain order book. Makers place resting sell orders at a chosen price; a swap routes through the book first (taking any better-priced maker liquidity) and then the AMM for the remainder. Fund conservation is exact and the matching walk is hard-capped so the book can never gas-brick a swap.",
    points: [
      "Price-ordered index; matching walk capped to a bounded candidate set",
      "Taker sweeps the book, then the AMM, in one route",
      "Every order carries a refundable escrow floor",
    ],
    example:
      "A maker places a resting sell order at $0.05. When a buyer swaps, the route first fills against that $0.05 maker order (better than the AMM price), then sends the remainder through the AMM. The maker's order stays escrowed until it fills or they cancel it.",
  },
  {
    slug: "floor",
    icon: "/horns/art/floor.png",
    name: "Price Floor",
    tagline: "A funded buyback wall under the price",
    category: "Liquidity & pricing",
    hooks: ["before_swap / after_swap"],
    blurb:
      "A capital-backed price floor: deposited funds stand as a buyback wall at or below a set floor price, absorbing sells so the market has a funded settlement alternative. This is the backing primitive the FWA-style 'backed positions' idea builds on.",
    points: [
      "Funded wall that buys support at/under a floor",
      "Gives holders a real floor, not just a promise",
    ],
    example:
      "A creator deposits funds to stand as a buyback wall at $0.02. If the price falls to that floor, the deposited capital absorbs sells, giving holders a funded settlement floor to trade against instead of just a promise.",
  },

  // ── Composition ─────────────────────────────────────────────────────────
  {
    slug: "composite",
    icon: "/horns/art/composite.png",
    name: "Composite Router",
    tagline: "Attach many Horns to one pool",
    category: "Composition",
    hooks: ["before_swap", "after_swap"],
    blurb:
      "A router that lets one pool run several Horns at once. It combines their before_swap decisions under strict rules (any Reject wins, at most one Delta is allowed, and conflicting fee overrides are rejected), then fans the after_swap out to each child. The trust chain is explicit: AMM → Composite → children.",
    points: [
      "One pool, many Horns, deterministic combination rules",
      "Reject wins; a single Delta max; conflicting OverrideFees rejected",
      "Fans after_swap out to every attached child Horn",
    ],
    example:
      "A creator wants both Fee Decay and Fee-Share reward routing on one pool. Composite Router runs both: it combines their before_swap decisions under strict rules (one Delta max, no conflicting fee overrides), then fans after_swap out to each child so several Horns run on the same pool safely.",
  },

  // ── Reference ───────────────────────────────────────────────────────────
  {
    slug: "_hooks-interface",
    name: "Hook Interface",
    tagline: "The AMM-side contract every Horn plugs into",
    category: "Reference",
    hooks: ["before_swap query", "after_swap execute"],
    blurb:
      "Not a Horn: this is the AMM's hook layer (amm/src/hooks.rs) that defines how every Horn attaches. before_swap is a query returning a decision (Proceed / Reject / OverrideFee / Delta); after_swap is a reply-on-never sub-message so a failing Horn reverts the swap. Any Delta a Horn returns is re-validated here against reserves, which is why no Horn can drain a pool.",
    points: [
      "Decision types: Proceed, Reject, OverrideFee, Delta",
      "before_swap = query; after_swap = revert-on-fail sub-message",
      "Delta is re-validated against reserves, the systemic safety backstop",
    ],
    example:
      "A swap comes in. The AMM asks the attached Horn before_swap and gets back one of Proceed, Reject, OverrideFee, or Delta; it re-validates any Delta against live reserves, runs the swap, then calls after_swap as a revert-on-fail message. This is the interface every Horn plugs into.",
  },
];
