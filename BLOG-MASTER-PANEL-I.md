# Blog masterfile: The Last Supper, Panel I

Source document for blog post number one. The series is named after the three
1/1 panels ***commas*** minted on mainnet: Panel I explains what we do and how
it works, Panel II (later) goes deep on the economics, Panel III (later)
covers the road to mainnet. This file contains the full draft, the diagram
plan (what to reuse, what to generate, with specs), and cutdown lines for the
X thread.

Tone: for the general userbase. Confident, concrete, zero dev jargon. Numbers
are allowed; formulas are not. Brand is always ***commas***, bold italic.
No em dashes anywhere.

---

## The post

# The Last Supper, Panel I: a token that owns a price

Every launchpad sells you the same thing: a ticker, a picture, and a prayer
that attention holds. The token is backed by nothing because there is nothing
behind it. When the crowd moves on, there is no floor under the floor.

***commas*** launches tokens differently. Every token on ***commas*** is
launched against a real collectible market: a PSA 10 graded card, or the floor
of an NFT collection. Not inspired by it. Priced against it, with a live feed,
and convertible into it.

That last part is the whole story, so let's take it slowly.

## One token, one real thing

When someone launches a token on ***commas***, they pick the underlying: say,
a PSA 10 Umbreon VMAX. From that moment the token has a reference price that
does not come from the token's own chart. It comes from the card's real
market: the places where actual copies actually sell.

One million tokens represent one card. If the card is worth \$2,100, a full
unit of tokens is worth about \$2,100 of exposure. The card doubles, your
exposure doubles. You never graded, shipped, insured, or vaulted anything.

[FIGURE A: reuse `09-asset-classes` or generate the simpler "attention vs
asset" panel described in the diagram plan]

## The launch is the boring part, on purpose

Launching works like every launchpad you already know, and that is deliberate:

- Every token starts at a **25 SOL market cap** on a bonding curve.
- When the curve has raised **100 SOL**, the market migrates automatically to
  an AMM, and **the entire 100 SOL goes into the pool**. No team allocation,
  no liquidity games: what was raised is what you trade against.
- Supply is fixed forever the moment the token is created. Nobody, including
  us, can ever mint more.

Launching costs 0.1 SOL, takes about a minute, and the creator earns half of
every trading fee the market ever generates. You can even route those fees to
someone else: an X account, a YouTube channel, a forum legend who has no idea
you exist. The fees wait in escrow until the real person claims them.

[FIGURE B: reuse `01-curve-phase` left panel, or the simplified launch strip
described in the diagram plan]

## The two doors

Here is where ***commas*** stops being a launchpad and becomes a market.

Every ***commas*** market has two ways in and two ways out:

- **The SOL door.** Buy and sell with SOL, like any token. These trades pay a
  0.70% fee.
- **The card door.** If you hold a real, vaulted copy of the collectible, you
  can deposit it and receive tokens worth exactly what the card is worth. And
  it works in reverse: pay tokens worth one card, and walk away with an
  actual card from the pool. **The card door is completely free.** No fee in
  either direction, on purpose: bringing the real thing into the market is
  the behavior we most want to reward.

The pool is not an abstraction. It holds real copies that real holders
deposited, and any of them can be claimed by anyone willing to pay what a
copy is worth.

[FIGURE C: reuse `03-two-doors` as is. It was drawn for exactly this section]

## Why token buying moves the real card

This is the question everyone should ask, so here is the mechanism, step by
step. Say a wave of buying pushes the token above the card's real price:

1. The token now trades rich: tokens are worth more than the card they
   represent.
2. That gap is free money for anyone holding a real copy: deposit the card,
   receive tokens worth more than the card, sell the difference.
3. Where do those people get copies? The cheapest place possible: they buy
   the card's floor listings on the open market.
4. Every copy they deposit gets locked in the pool, and every floor listing
   they bought is gone. Fewer copies for sale means a firmer, higher floor.
5. The live price feed sees the higher floor and raises the token's
   reference price. The loop closes, one level up.

Token demand literally consumes the collectible's cheapest supply. A memecoin
pump buys nothing but its own chart. A ***commas*** pump buys the floor of a
real market.

[FIGURE D: reuse `06-transmission-loop`. The centerpiece figure of the post]

And the reverse is softer than you would expect. If the token dumps below the
card's value, the cheap exit is to buy tokens and redeem real cards from the
pool, which supports the token on the way down. The pool can only release the
copies it actually holds, so the downside is capped in a way the upside is
not. The pool acts like a ratchet: it absorbs copies aggressively and gives
them back reluctantly.

[FIGURE E: reuse `07-asymmetry`]

## For the people who already own the cards

If you hold the collectible, ***commas*** gives you two tools that never
existed for cards before:

- **Sell without selling.** Deposit a copy when the token is rich, take the
  premium, and buy back later. Your collection becomes a yield instrument.
- **Hedge.** Lock SOL as collateral, draw tokens against it, and sell them to
  flatten your exposure without touching the physical card. When the token
  trades above the card's real price, the market literally pays hedgers to
  lean against it.

## What keeps it honest

A short list, in plain words:

- Supply is fixed at creation and can only shrink. The mint is dead.
- The curve's terms cannot be edited after launch. Ever.
- The price feed is smoothed, rate-limited, and wrapped in a circuit breaker:
  if a bad print deviates too far, the market freezes instead of moving.
- Swap pricing uses a time-averaged price, so a single-transaction sandwich
  cannot move the rate against you.

## What is live, and what is next

The full protocol is live on devnet today: launches, trading, the card door,
hedging, and the price feeds, with the docs at commas.art covering every
detail from a quickstart to the exact math. A ***commas*** token will launch
on [pump.fun](https://pump.fun); the announcement and the official contract
address will come from [@commasdotart](https://x.com/commasdotart) and
nowhere else.

Three panels were minted on Solana mainnet to mark the start. This post was
Panel I. The next one opens the economics all the way up.

---

## Diagram plan

Reused from the docs set (already generated, dark + light):

| Slot | Figure | Note |
| --- | --- | --- |
| C | `03-two-doors` | Use unchanged |
| D | `06-transmission-loop` | Use unchanged, the centerpiece |
| E | `07-asymmetry` | Use unchanged |

To generate new (specs, same `fl_style` system):

**FIGURE A: "Backed by attention vs backed by a market."** Two side-by-side
panels. Left: a memecoin token box with an arrow to a cloud labeled
"attention" and a dotted line falling away beneath it, caption "when the
crowd leaves, nothing is under it". Right: the ***commas*** token box with a
double-headed arrow to a card labeled "PSA 10, \$2,100 real market", caption
"priced against it, convertible into it". Minimal, monochrome + one accent.

**FIGURE B (optional): "A launch in one strip."** Three small boxes left to
right: "launch at 25 SOL cap" then "curve raises 100 SOL" then "AMM opens
with all 100 SOL inside", with a thin timeline underneath and the 0.1 SOL
fee noted under the first box. Only generate if the post feels text-heavy
without it; `01-curve-phase` is the fallback.

**Cover image:** the Panel I artwork itself (the mainnet 1/1), full bleed,
with the post title set in Inter over the lower third. No generated graphics
on the cover.

---

## X thread cutdowns

1. every launchpad token is backed by attention. ours are backed by a market.
   introducing ***commas***: launch tokens against real graded cards and NFT
   floors. panel I:
2. one million tokens = one card. the card is \$2,100, a unit of tokens is
   \$2,100 of exposure. the card doubles, you double. no grading, no
   shipping, no vault key.
3. every market has two doors. SOL door: trade like any token, 0.7% fee.
   card door: deposit a real copy, get its exact value in tokens. or pay
   tokens, walk away with a real card. the card door is free.
4. why buying the token moves the real card: rich token -> depositing cards
   is free money -> arbs buy the cheapest real listings to deposit -> the
   floor thins and rises -> the feed follows. token demand consumes real
   supply.
5. and on the way down, the pool gives back only what it holds. absorbs
   aggressively, releases reluctantly. a ratchet on the float.
6. live on devnet now. docs at commas.art. token soon on pump.fun, CA only
   from this account.
