/**
 * Wallet/signer abstraction.
 *
 * Two implementations live behind this interface:
 *   - PhantomSigner   — wraps @solana/wallet-adapter-react (used in the PoC)
 *   - PrivyStubSigner — placeholder for the production Privy + paymaster impl
 *
 * Call sites (Imperial connect, deposit/withdraw) only know SignerProvider.
 * Swapping the impl is a one-line change in useSigner().
 */

/** Unsigned tx shapes the signer must be able to sign+submit. */
export type UnsignedTx =
  // Imperial's /deposit/build-tx returns a base64 partially-signed
  // VersionedTransaction (Imperial signs the fee-payer half; the wallet
  // adds the user's signature).
  | { kind: "solana-versioned"; base64: string };

export interface SignerProvider {
  /** Base58 wallet pubkey. Null until the user connects. */
  readonly publicKey: string | null;

  /** True when a wallet is connected and ready to sign. */
  readonly isReady: boolean;

  /** Human-readable name for the active wallet ("Phantom", "Privy", …). */
  readonly displayName: string;

  /**
   * Sign an arbitrary UTF-8 message.
   *
   * Used by the Imperial /mobile/connect flow:
   *   message = `imperial:mobile-connect:{wallet}:{nonce}`
   * Returns base58-encoded signature, matching Imperial's request shape.
   */
  signMessage(message: string): Promise<{ signatureBase58: string }>;

  /**
   * Sign and submit a transaction. Returns the resulting on-chain signature.
   *
   * For solana-versioned: the wallet adds its signature to a partially-signed
   * VersionedTransaction and submits.
   * For solana-instructions: the wallet builds a legacy tx from the
   * instructions, signs, and submits.
   *
   * In the production Privy impl, this method wraps the tx through the
   * paymaster before submission. Call sites don't need to know.
   */
  signAndSendTransaction(unsigned: UnsignedTx): Promise<{ signature: string }>;
}

export class SignerNotReadyError extends Error {
  constructor() {
    super("Signer not ready — connect a wallet first.");
    this.name = "SignerNotReadyError";
  }
}

export class SignerNotImplementedError extends Error {
  constructor(impl: string, op: string) {
    super(`${impl} signer: ${op} not implemented in this build.`);
    this.name = "SignerNotImplementedError";
  }
}
