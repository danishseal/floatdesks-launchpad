import { fetchDammMarkLamports } from "../src/sources/meteora.js";
const mark = await fetchDammMarkLamports("B1AdQ85N2mJ2xtMg9bgThhsPoA6T3M26rt4TChWSiPpr", "3iQL8BFS2vE7mww4ehAqQHAsbmRNCrPxizWAT2Zfyr9y");
console.log("VIRTUAL/SOL pool mark:", mark, "lamports per 1M-token unit =", (mark / 1e9).toFixed(2), "SOL");
console.log("per-token:", (mark / 1e9 / 1e6).toFixed(8), "SOL");
