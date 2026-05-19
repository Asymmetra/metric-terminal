"use client";

import type { SignerProvider } from "./types";
import { SignerNotImplementedError } from "./types";

/**
 * Privy + paymaster signer — stub.
 *
 * Reserved seat for the production impl. The interface shape proves call
 * sites compile against the same SignerProvider; the real impl will live
 * in Asymmetra's app and be copy-pasted from this skeleton.
 *
 * Activate via NEXT_PUBLIC_SIGNER=privy-stub to verify the wiring.
 */
export function makePrivyStubSigner(): SignerProvider {
  return {
    publicKey: null,
    isReady: false,
    displayName: "Privy (stub)",

    async signMessage(_message: string) {
      throw new SignerNotImplementedError("Privy", "signMessage");
    },

    async signAndSendTransaction(_unsigned) {
      throw new SignerNotImplementedError("Privy", "signAndSendTransaction");
    },
  };
}
