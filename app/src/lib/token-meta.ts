"use client";

import { useQuery } from "@tanstack/react-query";
import { REST_URL } from "@/lib/floorlaunch/config";
import type { SocialSignature } from "@/components/wallet/solana-wallet-provider";

/**
 * Client for the per-token off-chain meta store (see
 * src/lib/server/token-meta-store.ts + /api/token-meta). Today it carries one
 * flag, `teamLaunch`, set by the creator in the launch wizard.
 *
 * Writes are authenticated by a wallet signature the same way social writes are:
 * the connected wallet signs `ansem social: <action>\nts: <ts>`, proving it owns
 * the `setBy` address. The read side (see `effectiveTeamLaunch`) only honors the
 * flag when `setBy` equals the token's on-chain creator, so a non-creator can
 * never make the flag effective. The exact message string is reproduced on the
 * server (src/app/api/token-meta/route.ts) so the two cannot drift.
 */

export type TokenMeta = { teamLaunch?: boolean; setBy?: string };

/** The action a team-launch write signs. Bound to the token + the flag value. */
export function teamLaunchSignAction(token: string, teamLaunch: boolean): string {
  return `set-team-launch:${token}:${teamLaunch ? 1 : 0}`;
}

/** Mirror of the server's socialAuthMessage(action, ts). Kept inline so this
 *  client module does not pull the server-only verify.ts (and its crypto deps)
 *  into the browser bundle. */
function authMessage(action: string, ts: number): string {
  return `ansem social: ${action}\nts: ${ts}`;
}

interface Signer {
  address: string | null;
  signSocial: (message: string) => Promise<SocialSignature>;
}

// ── read ────────────────────────────────────────────────────────────────────

export const TOKEN_META_QUERY_KEY = (token: string) =>
  ["token-meta", token] as const;

async function fetchTokenMeta(token: string): Promise<TokenMeta> {
  const r = await fetch(`/api/token-meta?token=${encodeURIComponent(token)}`);
  if (!r.ok) return {};
  return ((await r.json()) as { meta?: TokenMeta }).meta ?? {};
}

export function useTokenMeta(token: string) {
  return useQuery({
    queryKey: TOKEN_META_QUERY_KEY(token),
    queryFn: () => fetchTokenMeta(token),
    enabled: Boolean(token),
    staleTime: 60_000,
  });
}

/**
 * A team-launch flag is only effective when it was set by the token's real
 * on-chain creator. This is the single source of truth for gating metadata
 * governance: pass the meta record and the creator from the live token detail.
 */
export function effectiveTeamLaunch(
  meta: TokenMeta | undefined,
  creator: string | null | undefined,
): boolean {
  return Boolean(
    meta?.teamLaunch && meta.setBy && creator && meta.setBy === creator,
  );
}

// ── write ─────────────────────────────────────────────────────────────────

/** Sign + persist the team-launch flag for a token, as the connected wallet. */
export async function saveTeamLaunch(
  token: string,
  teamLaunch: boolean,
  signer: Signer,
): Promise<TokenMeta> {
  if (!signer.address) throw new Error("Connect a wallet first.");
  const ts = Date.now();
  const sig = await signer.signSocial(
    authMessage(teamLaunchSignAction(token, teamLaunch), ts),
  );
  const r = await fetch("/api/token-meta", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, teamLaunch, setBy: signer.address, ts, ...sig }),
  });
  if (!r.ok) {
    throw new Error(
      (await r.json().catch(() => ({}))).error ?? "Could not save token flag",
    );
  }
  return ((await r.json()) as { meta: TokenMeta }).meta;
}

// ── resolving the new token address from its launch tx ──────────────────────

/**
 * Resolve the CW20 token contract address a `create_token` launch produced,
 * given its tx hash. The launch instantiates exactly one contract (the token),
 * so we read the single `instantiate` event's `_contract_address`. The tx is
 * already committed by the time `createToken` returns, but the REST tx service
 * can lag a beat behind the broadcast, so we retry briefly.
 */
export async function resolveTokenAddressFromTx(
  hash: string,
  attempts = 5,
): Promise<string | null> {
  const rest = REST_URL.replace(/\/$/, "");
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${rest}/cosmos/tx/v1beta1/txs/${hash}`, {
        cache: "no-store",
      });
      if (r.ok) {
        const j = (await r.json()) as {
          tx_response?: {
            events?: Array<{
              type: string;
              attributes: Array<{ key: string; value: string }>;
            }>;
          };
        };
        const events = j.tx_response?.events ?? [];
        for (const ev of events) {
          if (ev.type !== "instantiate") continue;
          const attr = ev.attributes.find((a) => a.key === "_contract_address");
          if (attr?.value) return attr.value;
        }
      }
    } catch {
      /* retry */
    }
    if (i < attempts - 1) {
      await new Promise((res) => setTimeout(res, 1200));
    }
  }
  return null;
}
