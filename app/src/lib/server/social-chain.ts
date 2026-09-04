/**
 * Relay signed social actions to the on-chain `ansem-social` contract.
 *
 * Authorship is proven by the user's signature (carried in the message), so the
 * relayer is only a gas sponsor: it submits a validly-signed action and can
 * never forge or alter authorship. The client signs the contract's canonical
 * message (see lib/social-sign.ts `canonicalSocialMessage`), so the SAME
 * signature that the off-chain store verifies is the one the contract verifies.
 *
 * Everything here degrades to `null` (post still lands off-chain) when the relay
 * is not configured or the broadcast fails, so social never hard-breaks on a
 * chain hiccup. Configure via env:
 *   SOCIAL_CONTRACT          ansem1... address of the deployed ansem-social
 *   SOCIAL_RELAYER_MNEMONIC  a funded ansem key that pays gas (its own key,
 *                            not shared with any other service)
 *   ANSEM_CHAIN_RPC_URL      default https://rpc.ansemchain.fun
 *   SOCIAL_GAS_PRICE         default 0.025uchanse
 */
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { GasPrice } from "@cosmjs/stargate";

const RPC = process.env.ANSEM_CHAIN_RPC_URL ?? "https://rpc.ansemchain.fun";
const CONTRACT = process.env.SOCIAL_CONTRACT ?? "";
const MNEMONIC = process.env.SOCIAL_RELAYER_MNEMONIC ?? "";
const PREFIX = process.env.BECH32_PREFIX ?? "ansem";
const GAS_PRICE = process.env.SOCIAL_GAS_PRICE ?? "0.025uchanse";

export function socialChainEnabled(): boolean {
  return Boolean(CONTRACT && MNEMONIC);
}

/** The signed-payload fields a route hands us, straight from the client. */
export type SignedPayload = {
  author: string;
  signature: string;
  pubkey: string;
  scheme?: string; // "direct" | "adr36" (default)
  bodyBytesB64?: string;
  authInfoBytesB64?: string;
  accountNumber?: string;
  chainId?: string;
};

/** Build the `direct` object the contract expects, or undefined for ADR-36. */
function directOf(p: SignedPayload) {
  if (p.scheme !== "direct") return undefined;
  if (!p.bodyBytesB64 || !p.authInfoBytesB64) return undefined;
  return {
    body_bytes: p.bodyBytesB64,
    auth_info_bytes: p.authInfoBytesB64,
    account_number: p.accountNumber ?? "0",
    chain_id: p.chainId ?? "",
  };
}

let clientPromise: Promise<{ client: SigningCosmWasmClient; address: string }> | null = null;
async function relayer() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: PREFIX });
      const [account] = await wallet.getAccounts();
      const client = await SigningCosmWasmClient.connectWithSigner(RPC, wallet, {
        gasPrice: GasPrice.fromString(GAS_PRICE),
      });
      return { client, address: account.address };
    })().catch((e) => {
      clientPromise = null; // let a later call retry a transient connect failure
      throw e;
    });
  }
  return clientPromise;
}

export type RelayResult = { onchainId?: string; txhash: string };

/** Broadcast one ExecuteMsg; returns the tx hash + the emitted post `id`
 *  attribute (present for post/reply). Returns null on any failure so the
 *  caller can fall back to the off-chain-only path. */
async function relay(exec: Record<string, unknown>): Promise<RelayResult | null> {
  if (!socialChainEnabled()) return null;
  try {
    const { client, address } = await relayer();
    const res = await client.execute(address, CONTRACT, exec, "auto");
    let onchainId: string | undefined;
    for (const ev of res.events) {
      if (ev.type === "wasm") {
        const a = ev.attributes.find((x) => x.key === "id");
        if (a) onchainId = a.value;
      }
    }
    return { onchainId, txhash: res.transactionHash };
  } catch (e) {
    console.warn("[social-chain] relay failed (kept off-chain):", (e as Error).message);
    return null;
  }
}

export function relayPost(p: SignedPayload, text: string, ts: number): Promise<RelayResult | null> {
  return relay({
    post: { author: p.author, text, ts, signature: p.signature, pubkey: p.pubkey, direct: directOf(p) },
  });
}

export function relayReply(
  p: SignedPayload,
  postId: number,
  text: string,
  ts: number,
): Promise<RelayResult | null> {
  return relay({
    reply: { author: p.author, post_id: postId, text, ts, signature: p.signature, pubkey: p.pubkey, direct: directOf(p) },
  });
}

export function relayLike(p: SignedPayload, postId: number, ts: number): Promise<RelayResult | null> {
  return relay({
    like: { author: p.author, post_id: postId, ts, signature: p.signature, pubkey: p.pubkey, direct: directOf(p) },
  });
}

export function relayRepost(p: SignedPayload, postId: number, ts: number): Promise<RelayResult | null> {
  return relay({
    repost: { author: p.author, post_id: postId, ts, signature: p.signature, pubkey: p.pubkey, direct: directOf(p) },
  });
}
