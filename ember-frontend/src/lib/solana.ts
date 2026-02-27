import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  Connection,
  SendTransactionError,
} from "@solana/web3.js";
import bs58 from "bs58";

interface SerializedInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

export function deserializeInstructions(
  serialized: SerializedInstruction[]
): TransactionInstruction[] {
  return serialized.map((ix) => {
    return new TransactionInstruction({
      programId: new PublicKey(ix.programId),
      keys: ix.accounts.map((a) => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      })),
      data: Buffer.from(ix.data, "base64"),
    });
  });
}

export type TxStatus = "simulating" | "signing" | "submitting";

// Lighthouse assertion program (injected by Phantom for security checks)
const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

/**
 * Check if a SendTransactionError is caused by Phantom's Lighthouse assertions
 * rather than by our actual program instructions.
 */
function isLighthouseError(err: SendTransactionError): boolean {
  const msg = err.message || "";
  const logs = (err as any).logs as string[] | undefined;
  if (msg.includes(LIGHTHOUSE_PROGRAM)) return true;
  if (logs?.some((l: string) => l.includes(LIGHTHOUSE_PROGRAM))) return true;
  return false;
}

export async function buildAndSignTransaction(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  connection: Connection,
  onStatus?: (status: TxStatus) => void
): Promise<string> {
  let blockhash: string;
  let lastValidBlockHeight: number;
  try {
    const result = await connection.getLatestBlockhash();
    blockhash = result.blockhash;
    lastValidBlockHeight = result.lastValidBlockHeight;
  } catch (err: any) {
    if (err?.message?.includes("403")) {
      throw new Error(
        "Solana RPC rate limited (403). Set NEXT_PUBLIC_SOLANA_RPC to a dedicated RPC endpoint (e.g., Helius free tier)."
      );
    }
    throw new Error(`Failed to get recent blockhash: ${err?.message || err}`);
  }

  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);

  // Simulate before signing — catch failures before user hits Phantom
  onStatus?.("simulating");
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: false,
  });
  if (simulation.value.err) {
    const logs = simulation.value.logs?.join("\n") || "No logs";
    throw new Error(
      `Simulation failed: ${JSON.stringify(simulation.value.err)}\n${logs}`
    );
  }

  onStatus?.("signing");
  const signed = await signTransaction(transaction);

  // Detect if the wallet injected extra instructions (e.g. Phantom adds
  // Lighthouse assertions + ComputeBudget).  Compare instruction counts
  // between what we built and what was signed.
  const originalIxCount = transaction.message.compiledInstructions.length;
  const signedIxCount = signed.message.compiledInstructions.length;
  const walletModified = signedIxCount !== originalIxCount;
  if (walletModified) {
    console.warn(
      `[solana] Wallet modified transaction: ${originalIxCount} → ${signedIxCount} instructions`
    );
  }

  onStatus?.("submitting");
  let txid: string;
  try {
    txid = await connection.sendTransaction(signed, {
      // Skip preflight when the wallet injected extra instructions, because
      // those instructions (Lighthouse assertions) may fail in preflight even
      // though the core transaction is valid.
      skipPreflight: walletModified,
      maxRetries: 3,
    });
  } catch (err: any) {
    // If preflight failed due to Lighthouse assertions, retry with skipPreflight
    if (err instanceof SendTransactionError && isLighthouseError(err)) {
      console.warn("[solana] Lighthouse preflight error, retrying with skipPreflight");
      txid = await connection.sendTransaction(signed, {
        skipPreflight: true,
        maxRetries: 3,
      });
    } else {
      throw err;
    }
  }

  // Wait for on-chain confirmation and CHECK the result
  try {
    const confirmation = await connection.confirmTransaction(
      { signature: txid, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    if (confirmation.value.err) {
      // Transaction was included in a block but FAILED on-chain
      throw new Error(
        `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`
      );
    }
  } catch (err: any) {
    // If confirmation itself throws (timeout / RPC error), check tx status
    if (err?.message?.includes("failed on-chain")) {
      throw err; // Re-throw our own error from above
    }
    // Timeout — check signature status one more time
    try {
      const status = await connection.getSignatureStatus(txid);
      if (status?.value?.err) {
        throw new Error(
          `Transaction failed: ${JSON.stringify(status.value.err)}`
        );
      }
      if (!status?.value?.confirmationStatus) {
        throw new Error(
          "Transaction was not confirmed. It may have been dropped by the network. Please try again."
        );
      }
      // Has some confirmation status — treat as potentially successful
      console.warn("[solana] confirmTransaction timed out but tx has status:", status.value.confirmationStatus);
    } catch (statusErr: any) {
      if (statusErr?.message?.includes("Transaction failed") || statusErr?.message?.includes("not confirmed")) {
        throw statusErr;
      }
      // getSignatureStatus also failed — report the original timeout
      throw new Error(
        "Transaction confirmation timed out. It may have been dropped by the network. Please try again."
      );
    }
  }

  return txid;
}
