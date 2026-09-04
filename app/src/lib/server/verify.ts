import { serializeSignDoc, pubkeyToAddress, type StdSignDoc } from "@cosmjs/amino";
import { Secp256k1, Secp256k1Signature, sha256 } from "@cosmjs/crypto";
import { fromBase64 } from "@cosmjs/encoding";
import { makeSignDoc, makeSignBytes } from "@cosmjs/proto-signing";
import { TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx";

/**
 * Verify an ADR-36 arbitrary-message signature (what Keplr/Leap `signArbitrary`
 * produces) so a write can be attributed to the wallet that owns `signer`.
 *
 * Reconstructs the canonical ADR-36 sign doc, hashes it, and checks the
 * secp256k1 signature against the provided pubkey, then confirms the pubkey
 * derives to `signer`. Returns false on any malformed input.
 */
function makeAdr36SignDoc(signer: string, message: string): StdSignDoc {
  const dataB64 = Buffer.from(message, "utf8").toString("base64");
  return {
    chain_id: "",
    account_number: "0",
    sequence: "0",
    fee: { gas: "0", amount: [] },
    msgs: [{ type: "sign/MsgSignData", value: { signer, data: dataB64 } }],
    memo: "",
  };
}

export async function verifyArbitrary(params: {
  prefix: string;
  signer: string;
  message: string;
  signatureB64: string;
  pubkeyB64: string;
}): Promise<boolean> {
  const { prefix, signer, message, signatureB64, pubkeyB64 } = params;
  try {
    // The pubkey must derive to the claimed signer address.
    const derived = pubkeyToAddress(
      { type: "tendermint/PubKeySecp256k1", value: pubkeyB64 },
      prefix,
    );
    if (derived !== signer) return false;

    const serialized = serializeSignDoc(makeAdr36SignDoc(signer, message));
    const hash = sha256(serialized);
    const sig = Secp256k1Signature.fromFixedLength(fromBase64(signatureB64));
    return await Secp256k1.verifySignature(sig, hash, fromBase64(pubkeyB64));
  } catch {
    return false;
  }
}

/**
 * Verify a SIGN_MODE_DIRECT signature over a SignDoc whose TxBody carries the
 * auth message in its `memo` and has no messages (so nothing is broadcast).
 * This is the path for wallets that expose only `signDirect` (the ANSEM wallet).
 *
 * Rebuilds the exact sign bytes from the client-supplied body/authInfo bytes,
 * hashes them, checks the secp256k1 signature against the pubkey, confirms the
 * pubkey derives to `signer`, AND decodes the TxBody to require
 * `memo === message` so the signature is bound to that exact auth message.
 * Returns false on any malformed input or mismatch.
 */
export async function verifyDirect(params: {
  prefix: string;
  signer: string;
  message: string;
  signatureB64: string;
  pubkeyB64: string;
  bodyBytesB64: string;
  authInfoBytesB64: string;
  accountNumber: string;
  chainId: string;
}): Promise<boolean> {
  const {
    prefix,
    signer,
    message,
    signatureB64,
    pubkeyB64,
    bodyBytesB64,
    authInfoBytesB64,
    accountNumber,
    chainId,
  } = params;
  try {
    // The pubkey must derive to the claimed signer address.
    const derived = pubkeyToAddress(
      { type: "tendermint/PubKeySecp256k1", value: pubkeyB64 },
      prefix,
    );
    if (derived !== signer) return false;

    const bodyBytes = fromBase64(bodyBytesB64);
    const signDoc = makeSignDoc(
      bodyBytes,
      fromBase64(authInfoBytesB64),
      chainId,
      Number(accountNumber),
    );
    const hash = sha256(makeSignBytes(signDoc));
    const sig = Secp256k1Signature.fromFixedLength(fromBase64(signatureB64));
    const okSig = await Secp256k1.verifySignature(sig, hash, fromBase64(pubkeyB64));
    if (!okSig) return false;

    // Bind the signature to the exact auth message: it must be the TxBody memo.
    const body = TxBody.decode(bodyBytes);
    return body.memo === message;
  } catch {
    return false;
  }
}

/**
 * Dispatch to the right verifier by scheme. "direct" uses a SIGN_MODE_DIRECT
 * SignDoc (ANSEM wallet); anything else falls back to ADR-36 (Keplr/Leap).
 */
export async function verifySocial(params: {
  prefix: string;
  signer: string;
  message: string;
  scheme?: string;
  signatureB64: string;
  pubkeyB64: string;
  bodyBytesB64?: string;
  authInfoBytesB64?: string;
  accountNumber?: string;
  chainId?: string;
}): Promise<boolean> {
  if (params.scheme === "direct") {
    if (
      !params.bodyBytesB64 ||
      !params.authInfoBytesB64 ||
      params.accountNumber == null ||
      !params.chainId
    ) {
      return false;
    }
    return verifyDirect({
      prefix: params.prefix,
      signer: params.signer,
      message: params.message,
      signatureB64: params.signatureB64,
      pubkeyB64: params.pubkeyB64,
      bodyBytesB64: params.bodyBytesB64,
      authInfoBytesB64: params.authInfoBytesB64,
      accountNumber: params.accountNumber,
      chainId: params.chainId,
    });
  }
  return verifyArbitrary({
    prefix: params.prefix,
    signer: params.signer,
    message: params.message,
    signatureB64: params.signatureB64,
    pubkeyB64: params.pubkeyB64,
  });
}

/**
 * The message a client signs to prove ownership for a social write. Includes the
 * action + a recent timestamp so a captured signature can't be replayed forever.
 */
export function socialAuthMessage(action: string, timestamp: number): string {
  return `ansem social: ${action}\nts: ${timestamp}`;
}

/** Reject signatures whose timestamp is older than this (replay window). */
export const AUTH_MAX_AGE_MS = 5 * 60_000;

/**
 * The auth fields every signed social-write request body carries, on top of its
 * action-specific fields. `scheme` selects the verifier; the `*B64` /
 * accountNumber / chainId fields are only present for scheme "direct".
 */
export type SocialWriteBody = {
  ts?: number;
  signature?: string;
  pubkey?: string;
  scheme?: string;
  bodyBytesB64?: string;
  authInfoBytesB64?: string;
  accountNumber?: string;
  chainId?: string;
};
