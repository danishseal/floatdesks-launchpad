/**
 * Wallet layer.
 *
 * Production path: Privy as the connect layer (external Solana wallets like
 * Phantom/Solflare plus embedded wallets), behind the useFlWallet()
 * abstraction so nothing downstream consumes Privy directly. Only the app
 * ID is used here; it is public and read from VITE_PRIVY_APP_ID. The Privy
 * app secret is server-side only and never belongs in this bundle.
 *
 * Dev path (?dev=1): a localStorage burner keypair with an automatic
 * airdrop, so transaction flows are testable headlessly where no extension
 * wallet exists.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import {
  useWallets,
  useSignTransaction,
  toSolanaWalletConnectors,
} from "@privy-io/react-auth/solana";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

export const RPC_URL =
  (import.meta as any).env?.VITE_RPC_URL ?? "https://api.mainnet-beta.solana.com";
export const IS_LOCALNET =
  RPC_URL.includes("127.0.0.1") || RPC_URL.includes("localhost");
const PRIVY_APP_ID = (import.meta as any).env?.VITE_PRIVY_APP_ID as string;
const DEV_KEY_STORAGE = "fl-dev-signer";

const isDevMode = () =>
  new URLSearchParams(window.location.search).has("dev");

function devKeypair(): Keypair {
  const stored = localStorage.getItem(DEV_KEY_STORAGE);
  if (stored) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)));
  }
  const kp = Keypair.generate();
  localStorage.setItem(DEV_KEY_STORAGE, JSON.stringify([...kp.secretKey]));
  return kp;
}

export interface FlWallet {
  connected: boolean;
  publicKey: PublicKey | null;
  /** Anchor provider bound to the active signer; null when disconnected. */
  provider: anchor.AnchorProvider | null;
  connect: () => void;
  disconnect: () => void;
  label: string;
}

const FlWalletContext = createContext<FlWallet>({
  connected: false,
  publicKey: null,
  provider: null,
  connect: () => {},
  disconnect: () => {},
  label: "Connect wallet",
});

export const useFlWallet = () => useContext(FlWalletContext);

/**
 * Adapt Privy's byte-in / byte-out signer into the object-in / object-out
 * wallet Anchor expects. Privy takes a serialized transaction and returns
 * a serialized signed transaction, so we serialize on the way in and
 * rehydrate the same transaction kind on the way out.
 */
function makeAnchorWallet(
  wallet: any,
  signTransaction: (input: any) => Promise<{ signedTransaction: Uint8Array }>,
  publicKey: PublicKey
) {
  const sign = async (tx: Transaction | VersionedTransaction) => {
    const legacy = tx instanceof Transaction;
    const bytes = legacy
      ? tx.serialize({ requireAllSignatures: false, verifySignatures: false })
      : tx.serialize();
    const { signedTransaction } = await signTransaction({
      transaction: new Uint8Array(bytes),
      wallet,
    });
    return legacy
      ? Transaction.from(signedTransaction)
      : VersionedTransaction.deserialize(signedTransaction);
  };
  return {
    publicKey,
    signTransaction: sign,
    signAllTransactions: async (txs: (Transaction | VersionedTransaction)[]) => {
      const out: (Transaction | VersionedTransaction)[] = [];
      for (const tx of txs) out.push(await sign(tx));
      return out;
    },
  };
}

function DevBridge({ children }: { children: ReactNode }) {
  const [kp] = useState(devKeypair);
  const [ready, setReady] = useState(false);
  const connection = useMemo(() => new Connection(RPC_URL, "confirmed"), []);

  useEffect(() => {
    (async () => {
      try {
        const bal = await connection.getBalance(kp.publicKey);
        if (bal < 5e9) {
          const sig = await connection.requestAirdrop(
            kp.publicKey,
            IS_LOCALNET ? 100e9 : 5e9
          );
          await connection.confirmTransaction(sig);
        }
      } catch {}
      setReady(true);
    })();
  }, []);

  const value = useMemo<FlWallet>(() => {
    const wallet = {
      publicKey: kp.publicKey,
      signTransaction: async (tx: any) => {
        if (tx.partialSign) tx.partialSign(kp);
        else tx.sign([kp]);
        return tx;
      },
      signAllTransactions: async (txs: any[]) => {
        for (const tx of txs) {
          if (tx.partialSign) tx.partialSign(kp);
          else tx.sign([kp]);
        }
        return txs;
      },
    };
    return {
      connected: ready,
      publicKey: kp.publicKey,
      provider: ready
        ? new anchor.AnchorProvider(connection, wallet as any, {
            commitment: "confirmed",
          })
        : null,
      connect: () => {},
      disconnect: () => {},
      label: ready
        ? `dev ${kp.publicKey.toBase58().slice(0, 4)}..${kp.publicKey.toBase58().slice(-4)}`
        : "dev signer…",
    };
  }, [ready]);

  return (
    <FlWalletContext.Provider value={value}>{children}</FlWalletContext.Provider>
  );
}

function PrivyBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const connection = useMemo(() => new Connection(RPC_URL, "confirmed"), []);

  const wallet = wallets?.[0];
  const address = wallet?.address ?? null;
  const connected = ready && authenticated && !!wallet;

  const value = useMemo<FlWallet>(() => {
    const publicKey = address ? new PublicKey(address) : null;
    return {
      connected,
      publicKey,
      provider:
        connected && wallet && publicKey
          ? new anchor.AnchorProvider(
              connection,
              makeAnchorWallet(wallet, signTransaction, publicKey) as any,
              { commitment: "confirmed" }
            )
          : null,
      connect: () => login(),
      disconnect: () => logout(),
      label: publicKey
        ? `${publicKey.toBase58().slice(0, 4)}..${publicKey.toBase58().slice(-4)}`
        : "Connect wallet",
    };
  }, [connected, address]);

  return (
    <FlWalletContext.Provider value={value}>{children}</FlWalletContext.Provider>
  );
}

const solanaConnectors = toSolanaWalletConnectors();

export function FlWalletProvider({ children }: { children: ReactNode }) {
  if (isDevMode()) return <DevBridge>{children}</DevBridge>;
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: { walletChainType: "solana-only" },
        externalWallets: { solana: { connectors: solanaConnectors } },
        embeddedWallets: {
          solana: { createOnLogin: "users-without-wallets" },
        },
      }}
    >
      <PrivyBridge>{children}</PrivyBridge>
    </PrivyProvider>
  );
}
