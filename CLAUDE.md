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

Depends on the Float indexer on **:8462** from `~/float` (`scripts/soak-up.sh`).
Do not pattern-kill node; that machine runs other sessions' validators and keepers.

## Who is working on what

| When (start) | Instance | Working on |
|---|---|---|
| 2026-09-04 | session 017xMDwA | Repointing `app/` off ansem-1 onto Float testnet 46630. Holding: `app/src/lib/float/*`, `app/src/app/api/float/pools` + `[...path]`, `app/src/components/liquidity/*`, `app/src/components/wallet/*`, `components/providers.tsx`, the create wizard, trade panel and token page. Stripped the ansem-only surface (horns, social feed/posts/messages, proposals, vault). |
| 2026-09-04 | session 01LqS83j | DeskHook pools on the liquidity board, DONE and verified against a live chain. Owns `app/src/lib/float/desk-hook.ts`, `app/src/app/api/float/hook-pools/`, `deskhook-handoff/`, plus ONE line in `app/src/lib/float/registry.ts` (`DESK_HOOK` in the RegistryKey union). The section component + css + wiring are in `deskhook-handoff/` for 017xMDwA to place, since `components/liquidity/*` is theirs. Absent on 46630 on purpose: DeskHook's runtime is 41,228 bytes vs EIP-170's 24,576 and has never been deployable (33,956 even before the acquire lane); `deployCodeTo` hid it from every test including the fork test. Proven on a localnet with the limit raised: `~/float/.claude/worktrees/desk-acquire/scripts/deskhook-localnet.sh`. |
