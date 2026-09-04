# commas - launch handoff (devnet -> mainnet)

The **protocol is already live on mainnet.** This doc is what a dev needs to
take the front end live and create the first markets.

## Already done (nothing to change)
- Program: `QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM` (mainnet, upgradeable)
- Global config: `3HmyakKbiYHBKjXUpmZWffBiLzQ2f3ZwR22HAHucTz2t`
  (admin `BNbCZ…GNAX`, oracle `EXTDwZBm…DfGj`)
- Indexer: `https://commas-indexer.fly.dev` - already on mainnet, keys set as
  Fly secrets (`RPC_URL`, `DAS_RPC_URL`, `ADMIN_KEYPAIR`, `ORACLE_KEYPAIR`).
  The oracle/fee/graduation keepers run here. `/holdings/:owner` is live.

The program id is the **same** on devnet and mainnet, so no id swaps anywhere.

## What to swap for the front end

### Launch app (`app/`, Vite)
| Var | Value |
| --- | --- |
| `VITE_RPC_URL` | `https://mainnet.helius-rpc.com/?api-key=<HELIUS_KEY>` (was devnet) |
| `VITE_PRIVY_APP_ID` | `cms4p9blf01o40cjm0wexxlzs` (unchanged) |

The indexer URL no longer needs editing: `app/src/config.ts` now defaults to the
mainnet indexer (`https://commas-indexer.fly.dev`). Override only if self-hosting
via `VITE_INDEXER_HTTP` / `VITE_INDEXER_WS`.

### Blog (`blog/`, Next.js)
| Var | Value |
| --- | --- |
| `NEXT_PUBLIC_TOKENS_API` | `https://commas-indexer.fly.dev/listings` |
| `NEXT_PUBLIC_PRIVY_APP_ID` | `cms4p9blf01o40cjm0wexxlzs` |
| `PRIVY_APP_SECRET` | (from secrets file) |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | for comment/subscriber persistence on Vercel |

## Keys - only if self-hosting the indexer
If the dev uses the hosted `commas-indexer.fly.dev` (recommended), they need **no
signing keys** - launches sign server-side there. Raw mainnet keys are only
needed to run a separate indexer instance; they're in the secrets file sent
separately. NOTE: the mainnet admin key is the treasury + upgrade authority -
treat it accordingly.

## Creating the first market
Markets are admin-gated. Through the launch UI (or a direct POST):
`POST https://commas-indexer.fly.dev/dev/launch` with
`{ identifier, meta: { ticker, name, launchedBy, … }, feePaymentSig }`, where
`feePaymentSig` is a tx sending 0.1 SOL from `launchedBy` to the treasury
`BNbCZjxJJ3UT75XyvzHA7ZL9yb7kVonw2GR1TDtSGNAX`. The backend verifies the fee,
signs `create_market` + the initial oracle push, and returns the new market.
`/markets` is empty until the first one is created.

## Sanity checks
```
curl https://commas-indexer.fly.dev/markets      # [] until first launch
curl https://commas-indexer.fly.dev/listings
curl https://commas-indexer.fly.dev/holdings/<wallet>
```
