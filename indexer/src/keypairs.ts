import { Keypair } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULT_ADMIN_KEY_PATH = `${homedir()}/.config/solana/id.json`;
const DEFAULT_ORACLE_KEY_PATH = fileURLToPath(
  new URL("../../relayer/keys/oracle-sim.json", import.meta.url),
);

function parseSecret(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    const decoded = Buffer.from(source, "base64");
    if (decoded.length === 64) return [...decoded];
    return JSON.parse(decoded.toString("utf8"));
  }
}

function loadKeypair(envName: string, fallbackPath: string): Keypair {
  const serialized = process.env[envName]?.trim();
  if (!serialized && !existsSync(fallbackPath)) {
    throw new Error(
      `${envName} is not configured (set the Fly secret or its key path)`,
    );
  }
  const source = serialized ?? readFileSync(fallbackPath, "utf8");
  const secret = parseSecret(source.trim());
  if (!Array.isArray(secret) || secret.length !== 64) {
    throw new Error(`${envName} must be a JSON array containing 64 bytes`);
  }
  if (
    secret.some(
      (value) =>
        !Number.isInteger(value) || Number(value) < 0 || Number(value) > 255,
    )
  ) {
    throw new Error(`${envName} contains an invalid secret-key byte`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export function loadAdminKeypair(): Keypair {
  return loadKeypair(
    "ADMIN_KEYPAIR",
    process.env.ADMIN_KEY_PATH ?? DEFAULT_ADMIN_KEY_PATH,
  );
}

export function loadOracleKeypair(): Keypair {
  return loadKeypair(
    "ORACLE_KEYPAIR",
    process.env.ORACLE_KEY_PATH ?? DEFAULT_ORACLE_KEY_PATH,
  );
}
