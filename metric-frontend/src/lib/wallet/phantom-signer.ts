"use client";

import bs58 from "bs58";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import type { SignerProvider, UnsignedTx } from "./types";
import { SignerNotReadyError } from "./types";

/**
 * Phantom-backed SignerProvider.
 *
 * Constructed from a captured wallet adapter snapshot + Solana connection.
 * Stale-closure-safe because useSigner() rebuilds the instance whenever the
 * underlying adapter state changes.
 *
 * Handles `solana-versioned` UnsignedTx — the partially-signed
 * VersionedTransaction shape Imperial's `/deposit/build-tx` returns. Order
 * placement does not flow through this signer because Imperial signs +
 * submits orders server-side under a JWT delegation; the only client-side
 * tx signing is deposit/withdraw.
 */
export function makePhantomSigner(
  wallet: WalletContextState,
  connection: Connection
): SignerProvider {
  const publicKey = wallet.publicKey ? wallet.publicKey.toBase58() : null;
  const isReady = !!wallet.publicKey && !!wallet.sendTransaction;

  return {
    publicKey,
    isReady,
    displayName: "Phantom",

    async signMessage(message: string) {
      if (!wallet.signMessage) {
        throw new SignerNotReadyError();
      }
      const bytes = new TextEncoder().encode(message);
      const sig = await wallet.signMessage(bytes);
      return { signatureBase58: bs58.encode(sig) };
    },

    async signAndSendTransaction(unsigned: UnsignedTx) {
      if (!wallet.publicKey || !wallet.sendTransaction) {
        throw new SignerNotReadyError();
      }
      if (unsigned.kind === "solana-versioned") {
        const raw = Uint8Array.from(atob(unsigned.base64), (c) => c.charCodeAt(0));
        const vtx = VersionedTransaction.deserialize(raw);
        const signature = await wallet.sendTransaction(vtx, connection);
        return { signature };
      }
      // Tagged-union exhaustiveness — UnsignedTx currently has one variant.
      // If we ever add another (EVM calldata for non-Solana venues), TS
      // will force a compiler-level review here.
      const _exhaustive: never = unsigned.kind;
      throw new Error(`Unknown UnsignedTx kind: ${String(_exhaustive)}`);
    },
  };
}
