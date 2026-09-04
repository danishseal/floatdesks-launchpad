# Local Floorlaunch Stack Runbook

This runbook brings up the full local development stack on a teammate's
machine:

1. a local Solana validator with the Floorlaunch program loaded;
2. the indexer connected to that validator; and
3. the Vite frontend connected to the same validator and indexer.

It deliberately does **not** use the public devnet RPC. That endpoint is
rate-limited and is not a dependable local-development dependency.

## Inputs that must be supplied securely

The repository needs these two artifacts before a teammate can launch markets:

| Artifact | Required location | Purpose |
| --- | --- | --- |
| `oracle-sim.json` | repository root | private oracle signer trusted by the configured program |
| `floorlaunch.json` | repository root | Anchor IDL matching the deployed Floorlaunch program |

`oracle-sim.json` is a private key. Transfer it through the team's approved
secret-sharing channel; do not commit it, paste it in chat, or put it in a
ticket. The setup below creates the nested path expected by the relayer and
indexer without copying the secret.

The program ID used throughout this runbook is:

```text
QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM
```

## Prerequisites

- macOS or Linux shell, Git, and Node.js 22+ with npm.
- Solana CLI and `solana-test-validator` (the currently verified setup uses
  Solana CLI 2.1.0).
- Anchor CLI 0.31.1.
- A local Solana CLI keypair at `~/.config/solana/id.json`. The local validator
  grants its configured identity ample test SOL; the initializer uses this
  keypair as the local program admin.

Verify the tools before proceeding:

```bash
node --version
npm --version
solana --version
anchor --version
test -f ~/.config/solana/id.json
```

## One-time checkout preparation

From the repository root, install JavaScript dependencies and validate the
two supplied artifacts:

```bash
npm ci
(cd indexer && npm ci)
(cd app && npm ci)
test -s floorlaunch.json
test -s oracle-sim.json
```

The current checkout does not contain a committed local program binary. Fetch
the binary from the deployed devnet program, then wire the IDL and oracle key
into the paths used by local scripts:

```bash
mkdir -p target/deploy target/idl relayer/keys
solana program show QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM --url devnet
solana program dump QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM \
  target/deploy/floorlaunch.so --url devnet
ln -sfn ../../floorlaunch.json target/idl/floorlaunch.json
ln -sfn ../../oracle-sim.json relayer/keys/oracle-sim.json
```

The `program show` command is a safety check: its program ID must match the
one above. Do not substitute another program binary or generate a new oracle
key without intentionally changing the local program configuration.

### If program download is unavailable

Build the program only with a current Rust/Cargo toolchain compatible with its
dependencies, then use the resulting `target/deploy/floorlaunch.so`. An older
Cargo can fail on dependencies that require Rust's 2024 edition. Do not treat
an IDL as a replacement for the program binary; the validator needs the `.so`.

## Start the stack

Open three terminals at the repository root. Keep all three processes running.

### Terminal 1: validator

```bash
solana-test-validator --reset --ledger /tmp/floorlaunch-validator \
  --bpf-program QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM \
  target/deploy/floorlaunch.so
```

Wait until it prints the JSON RPC URL `http://127.0.0.1:8899`.

`--reset` creates a new chain every time. That is appropriate for a clean
local test but means all markets and the global configuration disappear on a
restart.

### Initialize the fresh validator (once after every reset)

In a fourth short-lived terminal, after the validator is ready:

```bash
cd relayer
RPC_URL=http://127.0.0.1:8899 npx tsx scripts/init-global.ts
```

Expected result:

```text
global initialized, oracle: <public key>
```

Run this exactly once per fresh ledger. If it reports that the account is
already initialized, keep the existing ledger and continue; do not retry the
initializer. If the validator was reset, run it again before launching a
market.

### Terminal 2: indexer

```bash
cd indexer
RPC_URL=http://127.0.0.1:8899 \
RPC_WS_URL=ws://127.0.0.1:8900 \
IDL_PATH="$PWD/../floorlaunch.json" \
npm start
```

Expected output includes `indexer on :8787` and a program-log subscription.

### Terminal 3: frontend

```bash
cd app
VITE_RPC_URL=http://127.0.0.1:8899 npm run dev -- --host 127.0.0.1
```

Open the URL Vite prints, normally `http://127.0.0.1:5173`.

## Verification checklist

Run these from another terminal after all services are up:

```bash
solana cluster-version --url http://127.0.0.1:8899
solana program show QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM \
  --url http://127.0.0.1:8899
curl --fail --max-time 5 http://127.0.0.1:8787/markets
curl --fail --max-time 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5173/
```

Success criteria:

- validator reports a version and the Floorlaunch program exists locally;
- `/markets` returns HTTP 200 (an empty `[]` is expected before the first
  local launch);
- frontend returns HTTP 200;
- a launch succeeds without `AccountNotInitialized` for `global`.

## Troubleshooting and reliable restarts

| Symptom | Cause | Action |
| --- | --- | --- |
| `AccountNotInitialized` for `global` | Fresh/reset validator was not initialized. | Run `relayer/scripts/init-global.ts` once against port 8899. |
| Program account not found | Validator started without the `--bpf-program` argument or binary is missing. | Stop it, fetch/verify the binary, and restart Terminal 1. |
| Markets appear from an old chain or API data is inconsistent after a reset | `indexer/data/` is local generated state persisted from an earlier ledger. | Stop the indexer, inspect `indexer/data/`, remove only its generated state files if a clean test is intended, then restart it. |
| HTTP 429 / markets hang | The process is connected to a public devnet RPC rather than the local validator. | Confirm Terminal 2 has `RPC_URL=http://127.0.0.1:8899`; do not use `run-devnet.sh` for this local workflow. |
| Oracle authorization error | Wrong/missing oracle key or a key was regenerated. | Restore the approved `oracle-sim.json`, recreate the symlink, reset the validator, then initialize it again. |
| Browser extension listener/orphan warnings | Wallet-extension diagnostics. | Treat separately unless the launch request itself fails; inspect the indexer terminal for the actionable server error. |

Use `Ctrl-C` in each owning terminal to stop the corresponding service. For a
clean restart, stop the indexer and frontend first, then the validator; start
in the order documented above. Keep `/tmp/floorlaunch-validator` scoped to
this project only—do not delete broad system or home directories.
