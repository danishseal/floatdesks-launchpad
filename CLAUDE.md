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
