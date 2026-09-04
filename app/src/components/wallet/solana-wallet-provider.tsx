"use client";

// ANSEM-chain wallet provider. Replaces the Solana/Privy bridge with the ANSEM
// browser extension (window.bwickWallet.cosmos, Keplr fallback) on ansem-1.
// Keeps the `SolanaWalletProvider` + `useFloorWallet` names so existing imports
// resolve unchanged; the returned shape now exposes `getSigningClient()` for
// CosmWasm execute instead of a Solana AnchorProvider.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { GasPrice } from "@cosmjs/stargate";
import {
  makeAuthInfoBytes,
  makeSignDoc,
  encodePubkey,
  type OfflineSigner,
  type OfflineDirectSigner,
} from "@cosmjs/proto-signing";
import { encodeSecp256k1Pubkey } from "@cosmjs/amino";
import { TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { toBase64 } from "@cosmjs/encoding";
import {
  CHAIN_ID,
  RPC_URL,
  REST_URL,
  DENOM,
  BASE_DENOMS,
  INDEXER_HTTP,
} from "@/lib/floorlaunch/config";

type WalletKind = "ansem" | "keplr";

interface KeplrLike {
  experimentalSuggestChain: (info: unknown) => Promise<void>;
  enable: (chainId: string) => Promise<void>;
  disable?: (chainId: string) => Promise<void>;
  getOfflineSigner: (chainId: string) => OfflineSigner;
  getKey: (chainId: string) => Promise<{ name: string; bech32Address: string }>;
  signArbitrary?: (
    chainId: string,
    signer: string,
    data: string | Uint8Array,
  ) => Promise<{ signature: string; pub_key: { type: string; value: string } }>;
}

function providerFor(kind: WalletKind): KeplrLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    // Current ANSEM extension injects its Keplr-shaped surface under
    // `ansemWallet`; older builds used `bwickWallet`. Prefer the new global and
    // fall back to the legacy one so both extension versions connect.
    ansemWallet?: { cosmos?: KeplrLike };
    bwickWallet?: { cosmos?: KeplrLike };
    keplr?: KeplrLike;
  };
  if (kind === "ansem") return w.ansemWallet?.cosmos ?? w.bwickWallet?.cosmos ?? null;
  return w.keplr ?? null;
}

const CHAIN_INFO = {
  chainId: CHAIN_ID,
  chainName: "ANSEM Chain",
  rpc: RPC_URL,
  rest: REST_URL,
  bip44: { coinType: 118 },
  bech32Config: {
    bech32PrefixAccAddr: "ansem",
    bech32PrefixAccPub: "ansempub",
    bech32PrefixValAddr: "ansemvaloper",
    bech32PrefixValPub: "ansemvaloperpub",
    bech32PrefixConsAddr: "ansemvalcons",
    bech32PrefixConsPub: "ansemvalconspub",
  },
  currencies: [{ coinDenom: "CHANSE", coinMinimalDenom: DENOM, coinDecimals: 6 }],
  feeCurrencies: [
    {
      coinDenom: "CHANSE",
      coinMinimalDenom: DENOM,
      coinDecimals: 6,
      gasPriceStep: { low: 0.01, average: 0.025, high: 0.04 },
    },
  ],
  stakeCurrency: { coinDenom: "CHANSE", coinMinimalDenom: DENOM, coinDecimals: 6 },
  features: ["cosmwasm"],
};

/**
 * Result of signing a social-auth message. Two schemes:
 *  - "adr36": the wallet's native `signArbitrary` (Keplr/Leap). Server verifies
 *    the canonical ADR-36 amino sign doc.
 *  - "direct": a SIGN_MODE_DIRECT SignDoc with no messages and the auth message
 *    carried in the TxBody memo (the ANSEM wallet's offline signer only exposes
 *    `signDirect`). The byte fields let the server rebuild the exact sign bytes.
 */
export type SocialSignature =
  | { scheme: "adr36"; signature: string; pubkey: string }
  | {
      scheme: "direct";
      signature: string;
      pubkey: string;
      bodyBytesB64: string;
      authInfoBytesB64: string;
      accountNumber: string;
      chainId: string;
    };

interface AnsemWallet {
  connected: boolean;
  connecting: boolean;
  address: string | null;
  /** Kept for shape-compat; always null on the Cosmos chain. */
  publicKey: null;
  balance: number | null; // CHANSE (whole units)
  ansemBalance: number | null; // ANSEM (whole units)
  walletName: string;
  connect: (kind?: WalletKind) => Promise<void>;
  disconnect: () => void;
  refreshBalance: () => Promise<void>;
  /** A CosmWasm signing client bound to the connected signer. */
  getSigningClient: () => Promise<SigningCosmWasmClient>;
  /** Sign a social-auth message for authenticating off-chain writes. Uses the
   * wallet's ADR-36 signArbitrary when available, else a SIGN_MODE_DIRECT
   * SignDoc that binds the message in its memo. No on-chain tx is broadcast. */
  signSocial: (message: string) => Promise<SocialSignature>;
}

const Ctx = createContext<AnsemWallet | null>(null);
const STORAGE_KEY = "ansem-wallet-kind";

export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [walletName, setWalletName] = useState<string>("");
  const [signer, setSigner] = useState<OfflineSigner | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [ansemBalance, setAnsemBalance] = useState<number | null>(null);

  const refreshBalance = useCallback(async () => {
    if (!address) return;
    try {
      // Read all bank balances straight from the chain so we show both native
      // denoms the wallet holds: CHANSE (uchanse) and ANSEM (uansem).
      const res = await fetch(
        `${REST_URL}/cosmos/bank/v1beta1/balances/${address}`,
      );
      if (!res.ok) return;
      const json = (await res.json()) as {
        balances?: Array<{ denom: string; amount: string }>;
      };
      const amt = (denom: string) =>
        Number(json.balances?.find((b) => b.denom === denom)?.amount ?? "0") / 1e6;
      setBalance(amt(BASE_DENOMS.chanse));
      setAnsemBalance(amt(BASE_DENOMS.ansem));
    } catch {
      /* leave prior balances */
    }
  }, [address]);

  const connect = useCallback(
    async (kind: WalletKind = "ansem") => {
      setConnecting(true);
      try {
        let provider = providerFor(kind);
        if (!provider) provider = providerFor(kind === "ansem" ? "keplr" : "ansem");
        if (!provider) throw new Error("No ANSEM wallet or Keplr detected.");
        try {
          await provider.experimentalSuggestChain(CHAIN_INFO);
        } catch {
          /* some builds throw if already added */
        }
        await provider.enable(CHAIN_ID);
        const s = provider.getOfflineSigner(CHAIN_ID);
        const key = await provider.getKey(CHAIN_ID);
        setSigner(s);
        setAddress(key.bech32Address);
        setWalletName(key.name || "ANSEM Wallet");
        try {
          window.localStorage.setItem(STORAGE_KEY, kind);
        } catch {
          /* quota */
        }
      } finally {
        setConnecting(false);
      }
    },
    [],
  );

  const disconnect = useCallback(() => {
    setAddress(null);
    setSigner(null);
    setWalletName("");
    setBalance(null);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const getSigningClient = useCallback(async () => {
    if (!signer) throw new Error("Connect a wallet first.");
    return SigningCosmWasmClient.connectWithSigner(RPC_URL, signer, {
      gasPrice: GasPrice.fromString(`0.025${DENOM}`),
    });
  }, [signer]);

  const signSocial = useCallback(
    async (message: string): Promise<SocialSignature> => {
      if (!address) throw new Error("Connect a wallet first.");
      let kind: WalletKind = "ansem";
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === "ansem" || raw === "keplr") kind = raw;
      } catch {
        /* ignore */
      }
      let provider = providerFor(kind);
      if (!provider) provider = providerFor(kind === "ansem" ? "keplr" : "ansem");

      // Preferred path: the wallet's native ADR-36 signArbitrary (Keplr/Leap).
      if (provider?.signArbitrary) {
        const res = await provider.signArbitrary(CHAIN_ID, address, message);
        return { scheme: "adr36", signature: res.signature, pubkey: res.pub_key.value };
      }

      // Fallback for wallets whose offline signer only exposes signDirect (the
      // ANSEM wallet's cosmos provider is one - it has NO signArbitrary and NO
      // signAmino). Build a deterministic SIGN_MODE_DIRECT SignDoc with no
      // messages and the auth message carried in the TxBody memo, so the
      // signature is cryptographically bound to that exact message. Nothing is
      // broadcast; this never touches the chain and costs no gas.
      const direct = signer as OfflineDirectSigner | null;
      if (!direct || typeof direct.signDirect !== "function") {
        throw new Error("This wallet doesn't support message signing.");
      }
      const accounts = await direct.getAccounts();
      const account = accounts.find((a) => a.address === address) ?? accounts[0];
      if (!account) throw new Error("Wallet has no accounts.");
      const pubkeyAny = encodePubkey(encodeSecp256k1Pubkey(account.pubkey));
      const bodyBytes = TxBody.encode(
        TxBody.fromPartial({ messages: [], memo: message }),
      ).finish();
      const authInfoBytes = makeAuthInfoBytes(
        [{ pubkey: pubkeyAny, sequence: 0 }],
        [],
        0,
        undefined,
        undefined,
      );
      const signDoc = makeSignDoc(bodyBytes, authInfoBytes, CHAIN_ID, 0);
      const res = await direct.signDirect(address, signDoc);
      // Return exactly what the wallet signed (res.signed) so the server rebuilds
      // identical sign bytes regardless of any normalization the wallet applied.
      return {
        scheme: "direct",
        signature: res.signature.signature,
        pubkey: res.signature.pub_key.value,
        bodyBytesB64: toBase64(res.signed.bodyBytes),
        authInfoBytesB64: toBase64(res.signed.authInfoBytes),
        accountNumber: res.signed.accountNumber.toString(),
        chainId: res.signed.chainId,
      };
    },
    [address, signer],
  );

  // Auto-reconnect on mount if a prior kind is remembered.
  useEffect(() => {
    let kind: WalletKind | null = null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === "ansem" || raw === "keplr") kind = raw;
    } catch {
      /* ignore */
    }
    if (kind && providerFor(kind)) void connect(kind);
  }, [connect]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  // Re-connect on extension account switch.
  useEffect(() => {
    const handler = () => {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === "ansem" || raw === "keplr") void connect(raw);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("keplr_keystorechange", handler);
    return () => window.removeEventListener("keplr_keystorechange", handler);
  }, [connect]);

  const value = useMemo<AnsemWallet>(
    () => ({
      connected: Boolean(address),
      connecting,
      address,
      publicKey: null,
      balance,
      ansemBalance,
      walletName,
      connect,
      disconnect,
      refreshBalance,
      getSigningClient,
      signSocial,
    }),
    [address, connecting, balance, ansemBalance, walletName, connect, disconnect, refreshBalance, getSigningClient, signSocial],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFloorWallet(): AnsemWallet {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFloorWallet must be used within SolanaWalletProvider");
  return ctx;
}
