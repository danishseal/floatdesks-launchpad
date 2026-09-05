# floatdesks-launchpad

The Float launchpad front end. Next.js 16 app in `app/`, dev on **port 3460**
(3000 is another session's).

## What this is, and what it is not

This tree has three lineages stacked in it and they do not agree:

- `programs/floorlaunch`, `PROTOCOL-MASTER.md`, `ECONOMICS-MASTER.md`, `docs/`:
  the **commas / floorlaunch** Solana collectible launchpad. Historical.
- `app/`: was an **ansem-1 CosmWasm** launchpad fork, being repointed at
  **Float on Robinhood Chain**. This is the live product.
- `LAUNCH-HANDOFF.md`, `app/env.example`: stale. They document
  `NEXT_PUBLIC_FLOORLAUNCH_*` vars that nothing reads.

## Hard rules

- No em dashes anywhere (code, comments, UI copy, commits).
- **One address is hardcoded: the Registry.** Everything else resolves at
  runtime through `app/src/lib/float/registry.ts`. Registry keys are the ASCII
  name right-padded to 32 bytes (`cast format-bytes32-string`), NOT keccak; a
  wrong key returns the zero address instead of reverting, so zero is treated as
  a hard failure. Anything that pins a contract address at build time is a bug:
  ~/float's soak did exactly that and posted prices into a dead oracle for three
  days.
- Nothing here is share-backed. `sharesHeld` is 0 on every market, so copy says
  cash-backed. Never "synthetic" or "derivative"; the nouns are fSHARE, listing,
  market, reserve.
- No invented numbers on the liquidity board. Every column traces to a chain
  call or an indexer row, or it says it does not exist. The page this replaced
  shipped a hardcoded `$18,854,306` TVL and an "EPOCH 42" counter for a vault
  that has no epochs.

## Layout

- `app/src/lib/float/` the chain layer: `networks.ts` (presets, one env var to
  switch), `registry.ts` (resolution + venue detection), `chain.ts` (all reads
  and writes), `abi.ts` (generated from `~/float/contracts/out`).
- `app/src/app/api/float/` server routes: `[...path]` proxies the Float indexer
  and adds block timestamps to trade rows (the indexer stores `block`, no `ts`);
  `pools` assembles the liquidity board.
- `app/src/components/wallet/` injected EVM wallet. Privy is a drop-in behind
  `NEXT_PUBLIC_WALLET_MODE`.

## Backends

Switch with `NEXT_PUBLIC_FLOAT_NETWORK`, or the in-app switcher.

| key | chain | registry | venue |
|---|---|---|---|
| `float-testnet` (default) | 46630 | `0xc300f9B7903FaF66dAC973884965652c61AD05Ae` | TokenLaunchpad |
| `float-mainnet` | 4663 | `0x7134d98596490838FC16e8CA16bC2FDd57aD3202` | CurveFunder (reads only) |

Each network needs its OWN indexer process, since one process indexes one
registry: testnet on **:8462** (`~/float/scripts/soak-up.sh`), mainnet on
**:8463** (same `indexer.js`, `REGISTRY=0x7134d985…`, `DB=mainnet-7134d985.db`).
The origin is part of the network preset, overridable with `FLOAT_INDEXER_ORIGIN`.
The public mainnet RPC throttles `eth_getLogs`, so backfill in small chunks.
Do not pattern-kill node; that machine runs other sessions' validators and keepers.

## Who is working on what

| When (start) | Instance | Working on |
|---|---|---|
| 2026-09-04 | session 017xMDwA | Repointing `app/` off ansem-1 onto Float testnet 46630. Holding: `app/src/lib/float/*`, `app/src/app/api/float/pools` + `[...path]`, `app/src/components/liquidity/*`, `app/src/components/wallet/*`, `components/providers.tsx`, the create wizard, trade panel and token page. Stripped the ansem-only surface (horns, social feed/posts/messages, proposals, vault). |
| 2026-09-04 | session 01LqS83j | DeskHook pools section (DONE, absent until a hook is deployed), then the LP surface: `app/src/lib/float/pools.ts`, `app/src/app/api/float/lp-pools/`, the pools section and per-pool detail page on the liquidity board, and add/remove liquidity through PositionManager (mint + burn verified on a mainnet fork). Enumeration spans BOTH launchers, since three of the four launches live on the superseded CurveFunder 0xD55E56Be that no registry key points at. NOW: **v4 swaps execute.** The graduated-token swap that reverted with empty data was a struct mismatch, not a route or approval problem: the UniversalRouter deployed on 4663 carries one more dynamic field between `path` and `amountIn` than current v4-periphery's ExactInputParams, so our encoding shifted amountIn by a word, the router read zero, took it for OPEN_DELTA and reached for a credit it did not have. Found by tracing its opcodes and reading every calldata word it loaded; `app/scripts/fork-swap.ts` runs both directions against a fork and matches the chain's own quoter to the digit. `v4-router.ts` is mine now, handed over by 017xMDwA; the Trade button is still theirs to wire. |
| 2026-09-05 | session 9979f4b4 (float worktree curve-funder) | **Flipped this app's dev server on :3460 to `float-mainnet`** (was float-testnet) so a mainnet launch can be done from the web, and rebuilt the mainnet indexer on :8463, which had START_BLOCK 54796533 against a first Listings log at 54401768 and so reported zero listings on a chain carrying four. Touching NO app source: this is env + processes only. The one thing I want in `create-token-wizard.tsx` is the `launchNew` path (the wizard only calls `cfTx.launchToken`, so an unlisted company cannot be picked); that file is 017xMDwA's, so I am flagging it rather than editing it. Also patched ~/float/services/indexer/indexer.js with RPC retry/backoff, because a single 429 during backfill killed the process. NOW TAKING `create-token-wizard.tsx` (017xMDwA's, untouched since 07:32 and today's commits are the LP lane) to add the `launchNew` path: the wizard only calls `cfTx.launchToken`, so a company with no listing cannot be picked and the genesis set is unreachable from the web. Diff is additive, plus one new file `app/src/lib/float/catalogue.ts`. Also fixed the ansem leftovers in `top-nav.tsx` (docs + X links). |
| 2026-09-05 | session 014hR8Jr | **Token page.** Three asks, all shipped and verified by render on all five mainnet launches. (1) The AMM/Curve badge next to the title is now the real pair, `SNOOZE / fNTDO2`, from a new `/api/float/token-contracts`; `base_label` could not supply it because this venue hardcodes it to "USDG", so the fSHARE ticker is resolved from the curve's own `underlying` through `Listings.get`. Not uppercased: the leading lowercase f is the part that says fSHARE. (2) **The chart had never had a source on this venue.** `/candles` fell through to the indexer proxy, which does not index `CurveBuy`/`CurveSell` and answered `[]` for every token, so tokens that HAD traded printed "Chart will appear after first trade" over their own trades. New `app/src/app/api/float/candles/route.ts` + `lib/float/curve-trades.ts` build OHLC from `CurveBuy`/`CurveSell` (exact, USDG-denominated) UNION the meme pool's v4 `Swap` logs priced through the token's own USDG/fSHARE pool (a graduated token stops trading on the curve, so curve-only history stops dead at graduation). Verified: SNOOZE's last close equals the live pool price computed independently from `sqrtPriceX96`, and DOZE's likewise. `gen-abi.py` grew an event lane, it had emitted functions + errors and ZERO events, the same shape of gap as the dead error layer (b5ee8fe). (3) Copyable contracts grid under About: token, fSHARE, both pool ids, launcher, PoolManager. **Three silent-fiction bugs found and worked around, all the same root: a fanned-out read with a per-item `.catch()` returns a SHORT list that looks complete.** `lpPools()` answered 6, 8 and 2 pools on three consecutive calls; `cfAllTokensDetailed()` lost the very token the page was open on, which rendered as "Token not found" and as a 404 from my route. Neither logs anything. Fix on my side: never enumerate to answer a question about a KNOWN address. `lib/float/token-owner.ts` probes `curves(token)` on each launcher and returns found/absent/**unreadable** as three distinct answers; `lib/float/token-pools.ts` reads `curve.poolId` + `stockPoolOf` and takes the pool key from the PoolManager's own `Initialize` log. Plus `lib/float/retry.ts` (3 attempts, jittered backoff) on my read paths. `cfLaunchers()` exported from curve-funder.ts (additive). **Left for the owners, not touched:** `lpPools()` and `cfAllTokensDetailed()` still go short under load, so the liquidity board and any token list still under-report intermittently. `fetchCurveFunderTokens` computes `current_price` from the curve formula even for GRADUATED tokens, so the header reads $7.33e-7 for SNOOZE where the pool trades at $2.52e-8, a 29x overstatement that also feeds mcap and the Bullpen table. Also fixed en route: the wallet said "0 CHANSE / <0.0001 Floatdesk" for a USDG balance and a native gas balance (now read from `activeNetwork().quoteSymbol` and the chain's `nativeCurrency`), plus the remaining CHANSE copy in token-explorer and analytics; and `trading-chart-canvas` overwrote every candle's open with the PREVIOUS candle's close, which drew one candle across an hour and four trades and printed "O $269.60" on a candle that opened at $270.24. **LATER, same session.** Removed "My account" from the wallet menu. **Token page grid regrouped:** the rail now SPANS both rows (`xl:row-span-2`) instead of sharing row one. While they shared it the row was the taller of the two, my contracts grid pushed the rail past the chart card (909 vs 674), and the 235px difference showed as a dead band above the Holders panel with the resize handle apparently doing nothing. A `minHeight` on the card fixed the band and broke it the other way (the rail still held the row open, so dragging shorter moved nothing); spanning the rail decouples them. Measured: drag up 200px now gives chart -200 and Holders panel -200, tracking 1:1, dead band 0. Also deleted the empty 700px bottom-right cell, which held proposals before they were stripped. **TOOK `create-token-wizard.tsx`** (9979f4b4's; their work was committed and the tree was clean) for a drag-and-drop logo: new `components/trading/image-drop.tsx`. There is no pinning service here and `uploadImage()` in lib/api.ts is an ansem stub that throws, so the only destination that works is the launch metadata itself, which `buildTokenMetaUri` already writes ON CHAIN as a data: blob. So the file is downscaled to 128px and re-encoded WebP down a quality ladder until it fits 6KB, capped hard at 24KB, because bytes on chain cost `ceil(bytes/32)*20000 + bytes*16` gas. The cost shown comes from the chain's own `getGasPrice()` and says "cost unknown" if that read fails. Verified: a 237KB PNG became a 1.6KB WebP, quoted at 0.00042 ETH against a hand-check of 1,066,224 gas x 0.4026 gwei. The wizard's old hidden `<input type=file>` had no handler at all. **Note on browser verification:** the automation's screenshot space is 1568px wide against a 1920px viewport, so `getBoundingClientRect` coordinates must be scaled by 0.8167 before being passed to a click or drag. Unscaled, clicks land ~22% off and silently hit nothing, which cost me a wrong conclusion that the resize handle was dead. |
