#!/bin/bash
# Start the floorlaunch stack against devnet. Reads the Helius key from
# ~/Desktop/floorlaunch-rpc.txt when present, else falls back to the
# public devnet RPC.
KEYLINE=$(awk '/^-+$/{found=1;next} found && NF {print; exit}' ~/Desktop/floorlaunch-rpc.txt 2>/dev/null)
[ -z "$KEYLINE" ] && KEYLINE=$(grep -Eo '[0-9a-f-]{36}|https://[^ ]+' ~/Desktop/floorlaunch-rpc.txt 2>/dev/null | head -1)
# This script targets DEVNET: if a full URL was pasted, keep only its
# api key and force the devnet host (the same key works on all clusters).
if [[ "$KEYLINE" == *api-key=* ]]; then KEYLINE="${KEYLINE##*api-key=}"; fi
if [[ "$KEYLINE" == https://* ]]; then RPC="$KEYLINE";
elif [ -n "$KEYLINE" ]; then RPC="https://devnet.helius-rpc.com/?api-key=$KEYLINE";
else RPC="https://api.devnet.solana.com"; fi
echo "RPC: ${RPC%%api-key=*}..."
pkill -f "tsx src/index.ts"; pkill -f "next dev"; sleep 1
cd "$(dirname "$0")/indexer" && RPC_URL="$RPC" npm start > /tmp/floorlaunch-indexer.log 2>&1 &
cd "$(dirname "$0")/app" && NEXT_PUBLIC_SOLANA_RPC_URL="$RPC" npm run dev > /tmp/floorlaunch-app.log 2>&1 &
sleep 6
curl -s -o /dev/null -w "indexer %{http_code}\n" http://127.0.0.1:8787/markets
curl -s -o /dev/null -w "app     %{http_code}\n" http://localhost:3000
