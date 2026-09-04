import { makePusher, pushIndex } from "../src/push.js";
const cfg = {
  rpcUrl: "http://127.0.0.1:8899",
  programId: "QsixfrupxfVEDDYuQsR4vJcE58bbNfctD9WjijM9BjM",
  oracleKeypair: new URL("../keys/oracle-sim.json", import.meta.url).pathname,
  idlPath: new URL("../../target/idl/floorlaunch.json", import.meta.url).pathname,
  intervalSecs: 3600,
  markets: [],
};
const pusher = makePusher(cfg as any);
const t0 = Date.now();
try {
  const sig = await pushIndex(pusher, "HEvnWHuKBznoLehG3ymJM9k7sfNjcAyU36zt8GmiriG1", 7_200_000_000);
  console.log("push OK in", Date.now() - t0, "ms:", sig.slice(0, 20));
} catch (e: any) {
  console.log("push FAILED in", Date.now() - t0, "ms:", (e.message ?? String(e)).slice(0, 300));
}
