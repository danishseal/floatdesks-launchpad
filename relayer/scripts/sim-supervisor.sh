#!/bin/bash
# Relaunches the market sim when it exits (fresh RPC/websocket each run).
while true; do
  npx tsx scripts/sim.ts
  echo "[supervisor] sim exited ($?), restarting in 3s"
  sleep 3
done
