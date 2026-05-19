"use client";

import { useMemo } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { SignerProvider } from "./types";
import { makePhantomSigner } from "./phantom-signer";
import { makePrivyStubSigner } from "./privy-stub";

type SignerKind = "phantom" | "privy-stub";

function activeKind(): SignerKind {
  const v = process.env.NEXT_PUBLIC_SIGNER;
  return v === "privy-stub" ? "privy-stub" : "phantom";
}

/**
 * Returns the active SignerProvider, rebuilt whenever its underlying
 * dependencies (wallet adapter state, RPC connection) change.
 *
 * Components subscribe to wallet state by reading from the returned
 * SignerProvider — `signer.publicKey` and `signer.isReady` are reactive
 * because the parent hooks call back into React state.
 */
export function useSigner(): SignerProvider {
  const wallet = useWallet();
  const { connection } = useConnection();

  return useMemo(() => {
    if (activeKind() === "privy-stub") {
      return makePrivyStubSigner();
    }
    return makePhantomSigner(wallet, connection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.publicKey, wallet.sendTransaction, wallet.signMessage, connection]);
}
