// CosmWasm transactions + simulate queries against the ansem-1 launchpad.
// Replaces the old Solana/Anchor transaction builders.

import type { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { REST_URL, DENOM } from "@/lib/floorlaunch/config";
import { getLaunchpadContract, getAmmContract } from "@/lib/floorlaunch/live-config";

function toBase64(s: string): string {
  if (typeof btoa === "function") {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  return Buffer.from(s, "utf8").toString("base64");
}

async function smartQuery<T>(contract: string, msg: unknown): Promise<T> {
  const res = await fetch(
    `${REST_URL}/cosmwasm/wasm/v1/contract/${contract}/smart/${toBase64(
      JSON.stringify(msg),
    )}`,
    { headers: { accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`smart query -> HTTP ${res.status}`);
  return (await res.json() as { data: T }).data;
}

/** The launchpad creation fee (utoken CHANSE) from the on-chain Config. */
export async function creationFeeUtoken(): Promise<string> {
  const cfg = await smartQuery<{ creation_fee: string }>((await getLaunchpadContract()), {
    config: {},
  });
  return cfg.creation_fee ?? "0";
}

export interface CreateTokenArgs {
  name: string;
  symbol: string;
  image: string;
  description: string;
  socialLinks?: string[];
  /** "uchanse" (CHANSE) | "uansem" (ANSEM). */
  baseDenom: string;
  /** Required (utoken) when baseDenom === "uansem": the ANSEM graduation raise. */
  baseGradThreshold?: string;
  /**
   * Optional Horns config applied when the coin graduates to the AMM.
   * `skimBps` = fraction of each swap fee (bps, 0..1000) diverted to Horn Vault
   * stakers; `ansemBps` = share of that skim routed to the ANSEM sink (rest to
   * CHANSE). Only sent when a Horn is attached; the field is ignored by a
   * launchpad that predates Horns, so existing launches are unaffected.
   *
   * `composite` = extra Horns (by slug) to attach alongside the reward skim via
   * the Composite router. Forwarded as `composite_horns`; a launchpad that
   * predates hook composition ignores the unknown field (cw_serde default), so
   * this is a forward-compatible preview until the Horns program wires in.
   */
  horn?: { skimBps: number; ansemBps: number; composite?: string[] };
}

export async function createToken(
  client: SigningCosmWasmClient,
  sender: string,
  args: CreateTokenArgs,
): Promise<string> {
  const msg: Record<string, unknown> = {
    create_token: {
      name: args.name,
      symbol: args.symbol,
      image: args.image,
      description: args.description,
      social_links: args.socialLinks ?? [],
      base_denom: args.baseDenom,
      ...(args.baseDenom === "uansem" && args.baseGradThreshold
        ? { base_grad_threshold: args.baseGradThreshold }
        : {}),
      ...(args.horn
        ? {
            horn: {
              skim_bps: args.horn.skimBps,
              ansem_bps: args.horn.ansemBps,
              ...(args.horn.composite && args.horn.composite.length
                ? { composite_horns: args.horn.composite }
                : {}),
            },
          }
        : {}),
    },
  };
  // Creation fee is always CHANSE (uchanse) regardless of base denom.
  const fee = await creationFeeUtoken();
  const res = await client.execute(sender, (await getLaunchpadContract()), msg, "auto", "", [
    { denom: DENOM, amount: fee },
  ]);
  return res.transactionHash;
}

/** Quote: base-denom in (utoken) → tokens out (utoken). */
export async function simulateBuy(
  tokenAddress: string,
  amountIn: string,
): Promise<string> {
  try {
    const r = await smartQuery<{ tokens_out: string }>((await getLaunchpadContract()), {
      simulate_buy: { token_address: tokenAddress, ansem_amount: amountIn },
    });
    return r.tokens_out ?? "0";
  } catch {
    return "0";
  }
}

/** Quote: tokens in (utoken) → base-denom out (utoken). */
export async function simulateSell(
  tokenAddress: string,
  tokensIn: string,
): Promise<string> {
  try {
    const r = await smartQuery<{ ansem_out: string }>((await getLaunchpadContract()), {
      simulate_sell: { token_address: tokenAddress, token_amount: tokensIn },
    });
    return r.ansem_out ?? "0";
  } catch {
    return "0";
  }
}

export async function buy(
  client: SigningCosmWasmClient,
  sender: string,
  tokenAddress: string,
  baseDenom: string,
  spendUtoken: string,
  minTokensOut: string,
): Promise<string> {
  const res = await client.execute(
    sender,
    (await getLaunchpadContract()),
    { buy: { token_address: tokenAddress, min_tokens_out: minTokensOut } },
    "auto",
    "",
    [{ denom: baseDenom, amount: spendUtoken }],
  );
  return res.transactionHash;
}

export async function sell(
  client: SigningCosmWasmClient,
  sender: string,
  tokenAddress: string,
  tokensUtoken: string,
  minBaseOut: string,
): Promise<string> {
  // Sell = CW20 Send of the token to the launchpad with a SellTokens hook.
  const res = await client.execute(
    sender,
    tokenAddress, // the token IS its CW20 contract
    {
      send: {
        contract: (await getLaunchpadContract()),
        amount: tokensUtoken,
        msg: toBase64(JSON.stringify({ min_ansem_out: minBaseOut })),
      },
    },
    "auto",
  );
  return res.transactionHash;
}

// ── AMM routing (graduated tokens) ──────────────────────────────────────────
// Once a token graduates off the curve it trades on the AMM. Same buy/sell
// semantics, different contract + message:
//   buy  (base -> token): execute Swap{offer_ansem:true}  with base funds
//   sell (token -> base): CW20 Send to the AMM w/ SwapTokenForAnsem hook
//   quote: SimulateSwap -> output_amount

/** Quote: base-denom in (utoken) -> tokens out (utoken), on the AMM. */
export async function ammSimulateBuy(
  tokenAddress: string,
  amountIn: string,
): Promise<string> {
  try {
    const r = await smartQuery<{ output_amount: string }>((await getAmmContract()), {
      simulate_swap: { token_address: tokenAddress, offer_ansem: true, offer_amount: amountIn },
    });
    return r.output_amount ?? "0";
  } catch {
    return "0";
  }
}

/** Quote: tokens in (utoken) -> base-denom out (utoken), on the AMM. */
export async function ammSimulateSell(
  tokenAddress: string,
  tokensIn: string,
): Promise<string> {
  try {
    const r = await smartQuery<{ output_amount: string }>((await getAmmContract()), {
      simulate_swap: { token_address: tokenAddress, offer_ansem: false, offer_amount: tokensIn },
    });
    return r.output_amount ?? "0";
  } catch {
    return "0";
  }
}

export async function ammBuy(
  client: SigningCosmWasmClient,
  sender: string,
  tokenAddress: string,
  baseDenom: string,
  spendUtoken: string,
  minTokensOut: string,
): Promise<string> {
  const res = await client.execute(
    sender,
    (await getAmmContract()),
    { swap: { token_address: tokenAddress, offer_ansem: true, min_output: minTokensOut } },
    "auto",
    "",
    [{ denom: baseDenom, amount: spendUtoken }],
  );
  return res.transactionHash;
}

export async function ammSell(
  client: SigningCosmWasmClient,
  sender: string,
  tokenAddress: string,
  tokensUtoken: string,
  minBaseOut: string,
): Promise<string> {
  // Token -> base swap = CW20 Send of the token to the AMM with the
  // SwapTokenForAnsem hook ({ min_output }).
  const res = await client.execute(
    sender,
    tokenAddress,
    {
      send: {
        contract: (await getAmmContract()),
        amount: tokensUtoken,
        msg: toBase64(JSON.stringify({ min_output: minBaseOut })),
      },
    },
    "auto",
  );
  return res.transactionHash;
}
