"use client";

import bs58 from "bs58";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import type { SignerProvider, UnsignedTx } from "./types";
import { SignerNotReadyError } from "./types";

/**
 * Phantom-backed SignerProvider.
 *
 * Constructed from a captured wallet adapter snapshot + Solana connection.
 * Stale-closure-safe because useSigner() rebuilds the instance whenever the
 * underlying adapter state changes.
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
      const payer = wallet.publicKey;

      if (unsigned.kind === "solana-versioned") {
        const raw = Uint8Array.from(atob(unsigned.base64), (c) => c.charCodeAt(0));
        const vtx = VersionedTransaction.deserialize(raw);
        const signature = await wallet.sendTransaction(vtx, connection);
        return { signature };
      }

      // solana-instructions: legacy path used by useTransactionBuilder until
      // Phase D rewires it. Builds a legacy Transaction from base64-encoded
      // instructions, mirroring what deserializeInstructions does today.
      const instructions = unsigned.instructionsBase64.map(decodeInstruction);
      const { blockhash } = await connection.getLatestBlockhash();
      const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash });
      tx.add(...instructions);
      const signature = await wallet.sendTransaction(tx, connection);
      return { signature };
    },
  };
}

/**
 * Decode a base64 Solana instruction (the shape phoenix-rise returns from
 * Cargo-side ser/de). Mirrors metric-frontend/src/lib/solana.ts but kept
 * local here so the signer module doesn't reach across the codebase.
 */
function decodeInstruction(b64: string): TransactionInstruction {
  // Wire format: { programId: base58, keys: [{pubkey, isSigner, isWritable}], data: base64 }
  const json = JSON.parse(atob(b64));
  return new TransactionInstruction({
    programId: new PublicKey(json.programId),
    keys: json.keys.map((k: { pubkey: string; isSigner: boolean; isWritable: boolean }) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(json.data, "base64"),
  });
}
