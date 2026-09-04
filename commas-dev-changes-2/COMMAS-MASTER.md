# Commas - Master Build Log

Last updated: 2026-07-31

Brand: **commas** (domain commas.art). Repo stays named `floorlaunch`.
Public repo: github.com/cocainebit/floorlaunch (main).

Commas is a Solana launchpad for **collectible-backed synthetic tokens**. Each
token is pegged to the funding/floor of a real underlying (graded cards as the
flagship, NFT floors secondary) through an on-chain index, without holding the
physical asset in a vault. It is a funding-pegged synthetic, not a wrapper.

---

## 1. What exists (top level)

| Piece | Path | What it is | State |
|---|---|---|---|
| Anchor program | `programs/` | The on-chain launchpad (markets, curve, funding, graduation) | Built, 16 tests passing (2026-07-22) |
| App | `app/` | Launch/trade frontend for launch.commas.art | Built |
| Indexer | `indexer/` | Read-only market API + WebSocket feed + on-chain keepers | **Deployed live on Fly** |
| Blog | `blog/` | Next.js 16 blog with Privy auth + real backend | Built, not yet on Vercel |
| Docs | `docs/` | Mintlify docs, commas.art branding | Built |
| Launcher | `launcher/` | Scripts that mint the underlying Core NFTs + rebrand metadata | Used on mainnet |
| Relayer | `relayer/` | Oracle/relayer scripts | Built |

Design/economics references already in repo: `DESIGN.md`,
`PROTOCOL-MASTER.md`, `ECONOMICS-MASTER.md`, `BLOG-MASTER-PANEL-I.md`,
`floorlaunch-underlyings.docx`.

---

## 2. On-chain program

- Program ID: `QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM`
- Anchor + Solana. Tests: `tests/floorlaunch.ts` (16 passing as of 2026-07-22).
- Market lifecycle: `bootstrap` -> bonding curve -> graduation at a SOL target
  (default 100 SOL) into an internal AMM venue.
- Key market fields (served by the indexer): `cardIndexSol`, `unitsPerItem`,
  `indexPerToken`, `markPerToken`, bonding-curve virtual reserves
  (`curveVirtualSol`, `curveVirtualTokens`, `curveSolRaised`), `fundingIndex`,
  `graduationTargetSol`, `maxOpenInterest`, `insuranceSol`, `totalCollateralSol`.
- Underlyings catalog: `app/src/underlyings.json` (NFT collections + card sets;
  each entry has identifier, collectionId, market pubkey, floor snapshot, image).

Mainnet program deploy is still **pending**. The live indexer currently reads
the configured RPC (devnet).

### Deploy cost (2026-07-31 optimization pass)
The deploy is a **refundable rent deposit**, not a fee, sized to the binary.
- Added size-opt release profile (`opt-level="s"`, `strip=true`): binary
  **683 KB -> 566 KB**. All 21 tests still pass against the optimized `.so`.
- token-2022 feature bloat can't be trimmed (Anchor macros pull it in
  unconditionally; LTO already dead-strips the rest).
- Program keypair `target/deploy/floorlaunch-keypair.json` == on-chain id.

| max-len | headroom | cost (refundable) |
|---|---|---|
| 579320 | exact | 4.03 SOL |
| 637252 | +10% (recommended) | 4.44 SOL |
| 1158640 | 2x default | 8.06 SOL |

Deploy command (mainnet, run when admin/payer funded ~5 SOL):
```
solana program deploy \
  --url "https://mainnet.helius-rpc.com/?api-key=<KEY>" \
  --keypair <admin-payer.json> \
  --program-id target/deploy/floorlaunch-keypair.json \
  --upgrade-authority <admin-payer.json> \
  --max-len 637252 \
  --with-compute-unit-price 50000 \
  target/deploy/floorlaunch.so
```
Then flip the indexer to mainnet:
`fly secrets set RPC_URL="https://mainnet.helius-rpc.com/?api-key=<KEY>"`.

---

## 3. Indexer (DEPLOYED)

Long-lived Node process: Express REST + `ws` WebSocket + Anchor event
subscription, one `http.createServer` on port **8787**, WS at `/ws`.

- Live URL: **https://commas-indexer.fly.dev**
- Verified serving: `GET /markets` returns 2 markets with live `solUsd` (~72.94),
  no auth errors.
- Endpoints: `/markets`, `/listings`, `/candles/:market`, `/trades/:market`,
  `/aggregator`, `/index/:market`, WebSocket `/ws`.
- Ships **no keys** by default (read-only API). The oracle/fee/graduation
  keepers only activate if `ORACLE_KEYPAIR` / `ADMIN_KEYPAIR` are provided.

### Deploy stack
- `indexer/Dockerfile` - `node:22-slim`, `npm ci`, bundled data
  (`IDL_PATH`, `CATALOG_PATH`, `LISTINGS_PATH` all point at `/app/bundled` +
  `/app/data`), seeds `data/listings.json`, `CMD npm start` (tsx).
- `indexer/fly.toml` - app `commas-indexer`, region `iad`, internal port 8787,
  `force_https`, `auto_stop_machines='off'`, `min_machines_running=1`, 512MB.
- `indexer/src/keypair.ts` - `resolveSecretKey()` reads key from env (JSON/base64),
  then path env, then default path, returns null to skip a keeper cleanly.
- `indexer/DEPLOY.md` - full runbook.

### Config on Fly
- Secret `RPC_URL` = Helius devnet URL (`https://devnet.helius-rpc.com/?api-key=...`).
- Fly account has a card on file (trial machines stopped after 5 min; resolved).

### Frontend wiring (raw fly.dev, custom domain skipped)
```
NEXT_PUBLIC_FLOORLAUNCH_API_URL=https://commas-indexer.fly.dev
NEXT_PUBLIC_FLOORLAUNCH_WS_URL=wss://commas-indexer.fly.dev/ws
NEXT_PUBLIC_TOKENS_API=https://commas-indexer.fly.dev/listings
```
(No trailing slash on the API URL; code appends `/markets` etc.)

---

## 4. Blog (Next.js 16, bun)

Single flagship post ("Panel I") plus full custom UI. Path: `blog/`.
Not yet deployed to Vercel (deferred until ready).

### Auth + backend
- **Privy** wallet + email login. App id `cms4p9blf01o40cjm0wexxlzs`
  (secret in `blog/.env.local`, gitignored). Solana wallets enabled in the
  Privy dashboard; `providers.tsx` sets `loginMethods: ["wallet","email"]`,
  `walletChainType: "solana-only"`, `walletList: ["phantom","solflare",
  "detected_solana_wallets"]`, and `solana.rpcs` via `@solana/kit`
  (`createSolanaRpc` / `createSolanaRpcSubscriptions`) so Phantom/Solflare
  connect. Verified: logged in via Solflare and posted a comment.
- **Real backend** (not localStorage), persists across users and restarts:
  - `blog/src/lib/store.ts` auto-detects Upstash: uses Redis
    (`commas:comments` list, `commas:subscribers` set) when
    `UPSTASH_REDIS_REST_URL` + `_TOKEN` are set, else a local file store
    (`comments.json` / `subscribers.json`).
  - `blog/src/lib/privy.ts` - `verifyAuthor(token)` via `@privy-io/server-auth`
    (`verifyAuthToken` + `getUserById`).
  - Route handlers `api/comments` and `api/subscribe` (`force-dynamic`);
    posting a comment requires a Bearer access token.
  - Upstash adapter proven against the real DB (SCARD returned 1), then test
    data cleaned and keys removed from local env so local dev uses the file store.

### UI details shipped
Search bar top-left; center floating widget = commas.art white logo at 0.7
opacity; sidebar reduced to 3 icons (Home / Search / Pen), search icon toggles a
SearchModal that searches posts + tokens (token rows show logo + `$TICKER`,
`flFROG` renders as `$FROG`); Sign in / Subscribe / Share (copy URL + "Copied") /
comment-jump buttons all wired; footer nav Home / Launch (launch.commas.art) /
Docs / Twitter; CTA "Launch on Commas" -> launch.commas.art with a subtle blue
glow; hero image `public/blog-hero.png` (Charizard); Panel I asset card links to
Solscan + Metaplex for asset `7iMMDFqAp2W5S4SiYKQWVC4QksDGvGRFQarzrpyZqA9N`.

### Key deps / gotchas
- `@solana-program/memo` pinned to **0.10.0** (0.12 needs kit ^7; we run kit 5.5.1).

### Env (blog/.env.local, gitignored)
```
NEXT_PUBLIC_PRIVY_APP_ID=cms4p9blf01o40cjm0wexxlzs
PRIVY_APP_SECRET=... (set)
# optional, for prod persistence:
# UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
# NEXT_PUBLIC_TOKENS_API=https://commas-indexer.fly.dev/listings
```

### Landing page
`blog/src/app/page.tsx` - commas.art landing (sky-gradient / scanline style,
original commas copy, "COMMAS IS LIVE" block). Committed at `59b6330`.

---

## 5. Docs

Mintlify docs in `docs/`. Rebranded to commas.art: `docs.json` navbar primary
button Home -> https://commas.art/, wordmark logos in `docs/logo/
commas-art-{light,dark}.png` sized to 0.8x via `docs/cards.css`
(`.nav-logo { height: 19.2px !important; }`), copy-button height 34px.

---

## 5b. Card holdings (Collector Crypt link) - 2026-07-31

Finding: the `collectionId` on every catalog entry is a **synthetic sha256**
of the identifier string (see `relayer/scripts/allowlist.ts` `derive()`), used
only to seed the market PDA. None of them resolve on-chain. So "do you hold
this" cannot key off `collectionId`.

But the **graded cards are real on-chain assets** via Collector Crypt ($CARDS):
- Our card underlyings were seeded from `https://api.collectorcrypt.com/marketplace`
  (`allowlist.ts` `scanCardsFull`), which returns per-card `nftAddress`,
  `nftStandard:"core"`, and grade metadata. The scraper kept only aggregate
  counts (`ccListings`/`ccFloorUsd`) and dropped the mints.
- Every Collector Crypt card is a **Metaplex Core** asset grouped under one
  collection: **`CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac`**.
- Each asset carries on-chain attributes (`Year`, `Set`, `Serial Number`,
  `Grading Company`, `The Grade`) that rebuild our catalog key exactly:
  `card:{year}|{set}|#{serial}|{gradingCompany}|{grade}`.

Holdings mechanism (no CC API needed at runtime, pure Helius DAS):
1. `getAssetsByOwner(wallet)`, filter `grouping.collection == CC_COLLECTION`.
2. Rebuild each held card's key from attributes, match to catalog card ids.
3. Return the matched underlyings (+ their market pubkeys).

Proven end-to-end against wallet `EofCkTaFXUjdwpQdbTnjMsZD1nqjGTenUGFsfEdkraYN`
(holds 124 CC cards; matched 1 of our 57 underlyings: Piplup #42 CGC 10 x2).

Built: `indexer/src/launch.ts` (`CC_COLLECTION`, `loadCatalog`, `cardHoldings`)
+ `GET /holdings/:owner` in `index.ts`, using `DAS_RPC_URL` (mainnet Helius,
falls back to `RPC`). Typechecks clean. **Deploy pending Fly billing** (deploy
blocked: "We require your billing information" at fly.io/dashboard/achi/billing).
After billing: `fly deploy` + `fly secrets set DAS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=<KEY>"`,
then `curl .../holdings/<wallet>`.

Caveats: NFT-collection underlyings still use synthetic `collectionId`s, so a
holdings view for the 11 NFT collections needs their real verified-collection
addresses (not yet mapped). Only the ~57 card underlyings are wired.

## 6. Mainnet NFTs (rebranded)

Three Metaplex **Core** assets were minted for the Panel series and their
metadata was updated floorlaunch -> commas via the update authority
(`launcher/rebrand-nfts.mjs`, ArDrive Turbo uploads):

| Panel | Asset | Rebrand tx |
|---|---|---|
| I | `7iMMDFqAp2W5S4SiYKQWVC4QksDGvGRFQarzrpyZqA9N` | `3obyAx7E` |
| II | `CQEWqnUS...` | `5tEzBELo` |
| III | `DYSHhuaj...` | `5swrF5xJ` |

---

## 7. Recent commits

```
10787e9 indexer: make it deployable (Docker + Fly, env-config, no hardcoded paths)
59b6330 blog: commas.art landing page at root
f219650 blog: Upstash Redis store adapter with file-store fallback
a3304c1 blog: add Solana RPC config so Solflare/Phantom connect works
eded324 blog search: token logo on the left, $TICKER instead of fl prefix
d627056 blog: working search (posts+tokens), footer + CTA cleanup
8dce613 blog: remove analytics + email icons from the sidebar
fc4f33b blog: surface Phantom + Solflare directly on the login modal
99f26bf blog: center widget at 0.7 opacity
c591ced blog: real backend for comments + subscribers
6559b88 rebrand mainnet NFTs floorlaunch -> commas; docs navbar Home -> commas.art
55d42fa blog: wallet+email sign-in, email subscribe, working share/jump/asset links
```

---

## 7b. Mainnet bring-up - LIVE (2026-08-02)

Protocol is live on mainnet. Program `QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM`
(deploy sig 5Jtaf4iHczVru4tApP7h8YiUn26Rjcwjv1cfjVMmQP97HcLfe5vBFq4M1v8XvC7hGEkdprSgsiyc8A6vyrYNoTUd),
global config `3HmyakKbiYHBKjXUpmZWffBiLzQ2f3ZwR22HAHucTz2t` (admin=BNbCZ,
oracle=EXTDwZBm9oj2E4qvJwTnjq33f6C39uCfhdhcBarADfGj). Indexer flipped to mainnet
(RPC_URL + ADMIN_KEYPAIR + ORACLE_KEYPAIR set on Fly). `/markets` returns [] until
the first market is created. Admin BNbCZ ~2.4 SOL left after ~4.4 refundable rent.

Remaining to a public launch: create first market(s), point the frontend
(launch.commas.art + blog) at the mainnet indexer and deploy them. Security:
BNbCZ (treasury+admin+upgrade+launch signer) is now on the Fly box - revisit
custody post-launch.

--- original prep notes ---
Everything was prepped so the ONLY remaining task was funding the deploy.

- Admin/payer/upgrade-authority = the **BNbCZ treasury wallet** (user's choice),
  key at `~/.config/solana/commas-mainnet-admin.json`. Mainnet balance ~1.96 SOL;
  needs ~4.6 to deploy (~4.4 rent + buffer).
- Oracle = fresh dedicated hot key `EXTDwZBm9oj2E4qvJwTnjq33f6C39uCfhdhcBarADfGj`
  (`relayer/keys/oracle-mainnet.json`, gitignored). NOT the upgrade authority.
- Program id stays `QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM` (same keypair,
  cluster-independent). Binary is the optimized 565.7 KB build.
- `init-global.ts` is now env-aware (`ADMIN_KEY_PATH` / `ORACLE_KEY_PATH`).
- **`deploy-mainnet.sh`** does it all once funded: deploy -> fund oracle 0.1 SOL
  -> init global (admin=BNbCZ, oracle=EXTDwZBm) -> flip the Fly indexer to
  mainnet (RPC_URL + ADMIN_KEYPAIR + ORACLE_KEYPAIR secrets). Preflight aborts
  if the admin balance is under ~4.6 SOL.

Note on v1 vs DBC: this is the **v1 custom program**, not Meteora DBC. Params
are immutable after init, but freeze/unfreeze and fee-withdrawal ARE admin
functions - the BNbCZ key holds real authority (and will sit on the Fly box to
sign launches). Concentration risk: BNbCZ = treasury + admin + upgrade authority
+ launch signer. Acceptable for launch per operator; revisit (separate keys /
multisig upgrade authority) post-launch.

Review before flip: global `graduationTargetSol` default in init-global params
is 10 SOL (devnet value) - confirm the intended mainnet economics.

## 8. Open / pending

- [ ] Mainnet program deploy (needs ~5.5 SOL to admin key `BmPrXvji...`).
- [ ] Decide devnet vs mainnet RPC for the live indexer (currently devnet).
- [ ] Deploy blog to Vercel + Upstash (4 env vars) when ready.
- [ ] Commit the new blog hero image if not already committed.
- [ ] Custom domain api.commas.art was **skipped** on purpose; using raw
      commas-indexer.fly.dev. (Reopen with `fly certs add api.commas.art` if wanted.)
- [ ] Point launch app + blog envs at the fly.dev URLs above.

---

## 9. Access map (where secrets live)

- Privy secret: `blog/.env.local` (gitignored).
- Helius RPC key: `~/Desktop/floorlaunch-rpc.txt`; also a Fly secret on the indexer.
- Fly app: `commas-indexer` (iad), card on file.
- Program admin key: `BmPrXvji...` (funding pending).
- Oracle/admin keypairs for keepers: `oracle-sim.json`, `floorlaunch.json`
  (zipped to Desktop earlier). NOT shipped in the indexer image.
