import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { RelayerConfig, MarketConfig, EstimateDetail } from "./types.js";
import { estimateNftIndex } from "./sources/magiceden.js";
import { estimateCardIndex } from "./sources/card.js";
import { fetchDammMarkLamports } from "./sources/meteora.js";
import { makePusher, pushIndex, pushMark, Pusher } from "./push.js";

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function estimateMarket(m: MarketConfig): Promise<EstimateDetail | null> {
  switch (m.kind) {
    case "nft":
      return estimateNftIndex(m);
    case "card":
      return estimateCardIndex(m);
  }
}

export async function runCycle(cfg: RelayerConfig, pusher: Pusher) {
  for (const m of cfg.markets) {
    const label = m.kind === "nft" ? m.symbol : `${m.name} ${m.grade}`;
    try {
      const est = await estimateMarket(m);
      if (!est) {
        log(`HOLD ${label}: estimate gated (insufficient sales or disagreement), not pushing`);
        continue;
      }
      const sig = await pushIndex(pusher, m.market, est.estimateLamports);
      log(
        `PUSH ${label}: ${est.estimateLamports} lamports ` +
          `(sales used ${est.salesUsed}, dropped ${est.salesDropped}, ` +
          `ask ${est.referenceAskLamports ?? "n/a"}, dev ${est.deviationBps ?? "n/a"} bps) ${sig}`
      );
      if (m.externalPool && m.synthMint) {
        const mark = await fetchDammMarkLamports(m.externalPool, m.synthMint);
        const markSig = await pushMark(pusher, m.market, mark);
        log(`MARK ${label}: ${mark} lamports from pool ${m.externalPool} ${markSig}`);
      }
    } catch (e: any) {
      log(`ERROR ${label}: ${e.message ?? e}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cfgIdx = args.indexOf("--config");
  const cfgPath = cfgIdx >= 0 ? args[cfgIdx + 1] : "config/relayer.yaml";
  const once = args.includes("--once");

  const cfg = parse(readFileSync(cfgPath, "utf8")) as RelayerConfig;
  const pusher = makePusher(cfg);
  log(
    `relayer up: ${cfg.markets.length} market(s), oracle ${pusher.oracle.publicKey.toBase58()}, rpc ${cfg.rpcUrl}`
  );

  await runCycle(cfg, pusher);
  if (once) return;
  setInterval(() => runCycle(cfg, pusher), cfg.intervalSecs * 1000);
}

const isDirectRun = process.argv[1]?.endsWith("main.ts");
if (isDirectRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
