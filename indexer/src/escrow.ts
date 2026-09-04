/**
 * Identity fee escrow, program-PDA edition.
 *
 * Each identity (an X handle, a YouTube channel, an Elite Fourum user)
 * maps to a program-derived system account seeded by
 * sha256("platform:handle"). No key exists for it anywhere: fees for
 * unverified identities accumulate via plain transfers, and funds can
 * only leave through the program's admin-signed release_escrow
 * instruction, invoked here after ownership verification.
 *
 * Verification is nonce-in-bio: we issue a nonce, the owner puts it in
 * their public bio/description, we fetch and check. Per-platform:
 *   youtube      channel page description (public fetch)
 *   elitefourum  Discourse public user JSON (bio_raw)
 *   x            no public bio API; manual/admin approval until X OAuth
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";

const STORE = new URL("../data/escrows.json", import.meta.url).pathname;
const ADMIN_KEY = `${homedir()}/.config/solana/id.json`;

export type Platform = "x" | "youtube" | "elitefourum";

export interface EscrowEntry {
  platform: Platform;
  handle: string;
  escrowPubkey: string;
  createdAt: number;
  verified: boolean;
  verifiedWallet?: string;
  pendingWallet?: string;
  nonce?: string;
  sweeps: { sig: string; lamports: number; at: number }[];
}

const key = (p: Platform, h: string) => `${p}:${h.toLowerCase().replace(/^@/, "")}`;
const idHash = (p: Platform, h: string) =>
  createHash("sha256").update(key(p, h)).digest();

function load(): Record<string, EscrowEntry> {
  try {
    return JSON.parse(readFileSync(STORE, "utf8"));
  } catch {
    return {};
  }
}
const save = (d: Record<string, EscrowEntry>) =>
  writeFileSync(STORE, JSON.stringify(d, null, 2));

let programId: PublicKey | null = null;
let cachedIdl: any = null;
export function initEscrow(idl: any) {
  cachedIdl = structuredClone(idl);
  programId = new PublicKey(idl.address);
}

export function escrowAddress(platform: Platform, handle: string): PublicKey {
  if (!programId) throw new Error("escrow module not initialized");
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), idHash(platform, handle)],
    programId
  )[0];
}

export function getOrCreateEscrow(platform: Platform, handle: string) {
  const d = load();
  const k = key(platform, handle);
  if (!d[k]) {
    d[k] = {
      platform,
      handle: handle.replace(/^@/, ""),
      escrowPubkey: escrowAddress(platform, handle).toBase58(),
      createdAt: Math.floor(Date.now() / 1000),
      verified: false,
      sweeps: [],
    };
    save(d);
  }
  return d[k];
}

export function startVerification(platform: Platform, handle: string, wallet: string) {
  const d = load();
  const k = key(platform, handle);
  if (!d[k]) throw new Error("no escrow for this identity");
  new PublicKey(wallet); // validates
  const nonce = `floorlaunch-${randomBytes(6).toString("hex")}`;
  d[k].nonce = nonce;
  d[k].pendingWallet = wallet;
  save(d);
  const where: Record<Platform, string> = {
    youtube: "your channel description",
    elitefourum: "your Elite Fourum profile About Me",
    x: "your X bio (then an admin confirms, until X API verification ships)",
  };
  return { nonce, instructions: `Add "${nonce}" to ${where[platform]}, then check verification.` };
}

async function fetchBio(platform: Platform, handle: string): Promise<string | null> {
  try {
    if (platform === "youtube") {
      const r = await fetch(`https://www.youtube.com/@${encodeURIComponent(handle)}/about`, {
        headers: { "user-agent": "Mozilla/5.0" },
      });
      if (!r.ok) return null;
      return await r.text();
    }
    if (platform === "elitefourum") {
      const r = await fetch(`https://www.elitefourum.com/u/${encodeURIComponent(handle)}.json`, {
        headers: { accept: "application/json" },
      });
      if (!r.ok) return null;
      const j: any = await r.json();
      return JSON.stringify(j.user?.bio_raw ?? "") + JSON.stringify(j.user?.bio_cooked ?? "");
    }
    return null; // x: manual until OAuth
  } catch {
    return null;
  }
}

export async function checkVerification(
  rpcUrl: string,
  platform: Platform,
  handle: string,
  opts: { adminOverride?: boolean } = {}
) {
  const d = load();
  const e = d[key(platform, handle)];
  if (!e) throw new Error("no escrow for this identity");
  if (!e.nonce || !e.pendingWallet) throw new Error("verification not started");

  let found = false;
  if (opts.adminOverride) {
    found = true;
  } else {
    const bio = await fetchBio(platform, e.handle);
    found = bio !== null && bio.includes(e.nonce);
    if (platform === "x" && !found) {
      return { verified: false, reason: "x verification is admin-approved until X API credentials exist" };
    }
  }
  if (!found) return { verified: false, reason: "nonce not found in public bio yet" };

  e.verified = true;
  e.verifiedWallet = e.pendingWallet;
  save(d);
  const sweep = await sweepEscrow(rpcUrl, platform, e.handle);
  return { verified: true, wallet: e.verifiedWallet, sweep };
}

/** Release the escrow PDA to the verified wallet via the program. */
export async function sweepEscrow(rpcUrl: string, platform: Platform, handle: string) {
  const d = load();
  const e = d[key(platform, handle)];
  if (!e?.verified || !e.verifiedWallet) throw new Error("not verified");
  if (!cachedIdl) throw new Error("escrow module not initialized");

  const connection = new Connection(rpcUrl, "confirmed");
  const escrow = escrowAddress(platform, e.handle);
  const bal = await connection.getBalance(escrow);
  if (bal <= 0) return { swept: 0 };

  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(ADMIN_KEY, "utf8")))
  );
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
    commitment: "confirmed",
  });
  const program = new anchor.Program(cachedIdl, provider);
  const [globalPda] = PublicKey.findProgramAddressSync([Buffer.from("global")], programId!);
  const sig = await program.methods
    .releaseEscrow(Array.from(idHash(platform, e.handle)) as any, null)
    .accountsPartial({
      global: globalPda,
      admin: admin.publicKey,
      escrow,
      recipient: new PublicKey(e.verifiedWallet),
    })
    .rpc();
  e.sweeps.push({ sig, lamports: bal, at: Math.floor(Date.now() / 1000) });
  save(d);
  return { swept: bal / 1e9, sig };
}

export function listEscrows() {
  return load();
}
