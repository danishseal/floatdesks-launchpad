#!/bin/bash
# commas mainnet bring-up. Run ONCE, after funding the admin wallet.
# Does: deploy program -> fund oracle hot key -> init global config ->
# point the hosted indexer at mainnet. The only cost is the deploy rent
# (~4.4 SOL, refundable) + a little for the oracle + tx fees.
set -euo pipefail
cd "$(dirname "$0")"

ADMIN_KEY=~/.config/solana/commas-mainnet-admin.json          # BNbCZ treasury/admin
ORACLE_KEY=relayer/keys/oracle-mainnet.json                   # fresh oracle hot key
PROGRAM_KEY=target/deploy/floorlaunch-keypair.json            # program id Qsixfru...M9BjM
SO=target/deploy/floorlaunch.so
MAXLEN=637252                                                 # +10% headroom

# Resolve the mainnet Helius URL from the rpc file (same key, mainnet host).
K=$(grep -Eo '[0-9a-f]{8}-[0-9a-f-]{27}' ~/Desktop/floorlaunch-rpc.txt 2>/dev/null | head -1)
[ -z "$K" ] && { echo "could not read Helius key from ~/Desktop/floorlaunch-rpc.txt"; exit 1; }
RPC="https://mainnet.helius-rpc.com/?api-key=$K"

ADMIN_PUB=$(solana address -k "$ADMIN_KEY")
ORACLE_PUB=$(solana address -k "$ORACLE_KEY")
BAL=$(solana balance "$ADMIN_PUB" --url "$RPC" | awk '{print $1}')

echo "=== commas mainnet bring-up ==="
echo "  admin/payer  : $ADMIN_PUB  ($BAL SOL)"
echo "  oracle       : $ORACLE_PUB"
echo "  program id   : $(solana address -k "$PROGRAM_KEY")"
echo "  binary       : $(stat -f%z "$SO") bytes, --max-len $MAXLEN"
echo "  rpc          : ${RPC%%api-key=*}api-key=..."
NEED=4.6
awk "BEGIN{exit !($BAL < $NEED)}" && { echo; echo "!! admin has $BAL SOL, need ~$NEED. Fund $ADMIN_PUB then re-run."; exit 1; }
read -r -p "Proceed with mainnet deploy (spends ~4.4 SOL rent)? [y/N] " ok
[ "$ok" = "y" ] || { echo "aborted"; exit 0; }

echo "--- 1/4 deploy program ---"
solana program deploy \
  --url "$RPC" --keypair "$ADMIN_KEY" \
  --program-id "$PROGRAM_KEY" --upgrade-authority "$ADMIN_KEY" \
  --max-len "$MAXLEN" --with-compute-unit-price 50000 "$SO"

echo "--- 2/4 fund oracle hot key (0.1 SOL for price pushes) ---"
solana transfer --url "$RPC" --keypair "$ADMIN_KEY" --allow-unfunded-recipient "$ORACLE_PUB" 0.1

echo "--- 3/4 init global config (admin=$ADMIN_PUB, oracle=$ORACLE_PUB) ---"
RPC_URL="$RPC" ADMIN_KEY_PATH="$ADMIN_KEY" ORACLE_KEY_PATH="$ORACLE_KEY" \
  npx tsx relayer/scripts/init-global.ts

echo "--- 4/4 point the hosted indexer at mainnet ---"
fly secrets set -a commas-indexer \
  RPC_URL="$RPC" \
  ADMIN_KEYPAIR="$(cat "$ADMIN_KEY")" \
  ORACLE_KEYPAIR="$(cat "$ORACLE_KEY")"

echo
echo "DONE. Verify: curl https://commas-indexer.fly.dev/markets"
echo "The program, global config, and indexer are now on mainnet."
