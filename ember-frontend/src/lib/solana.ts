import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  Connection,
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
  if (!Array.isArray(serialized) || serialized.length === 0) {
    throw new Error("Backend returned no instructions");
  }
  return serialized.map((ix, i) => {
    if (!ix.programId || !ix.accounts || !ix.data) {
      throw new Error(`Instruction ${i} missing required fields`);
    }
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

export interface TxResult {
  txid: string;
  confirmed: boolean;
}

async function getBlockhash(connection: Connection): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  try {
    return await connection.getLatestBlockhash();
  } catch (err: any) {
    if (err?.message?.includes("403")) {
      throw new Error(
        "Solana RPC rate limited (403). Set NEXT_PUBLIC_SOLANA_RPC to a dedicated RPC endpoint (e.g., Helius free tier)."
      );
    }
    throw new Error(`Failed to get recent blockhash: ${err?.message || err}`);
  }
}

export async function buildAndSignTransaction(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  connection: Connection,
  onStatus?: (status: TxStatus) => void
): Promise<TxResult> {
  // Step 1: Simulate with replaceRecentBlockhash so the RPC uses its own latest
  // blockhash. This avoids wasting any of the ~150-slot validity window before
  // the user has even seen the Phantom dialog.
  onStatus?.("simulating");
  const simMsg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: "11111111111111111111111111111111", // placeholder — replaced by RPC
    instructions,
  }).compileToV0Message();
  const simTx = new VersionedTransaction(simMsg);
  const simulation = await connection.simulateTransaction(simTx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  if (simulation.value.err) {
    const logs = simulation.value.logs?.join("\n") || "No logs";
    throw new Error(
      `Transaction simulation failed: ${JSON.stringify(simulation.value.err)}\n${logs}`
    );
  }

  // Step 2: Get a FRESH blockhash right before signing so the user has the
  // maximum possible window (~150 slots ≈ 60 s) to approve in Phantom.
  // Previously the blockhash was fetched before simulation, eating into the
  // validity window before the user even saw the dialog.
  const { blockhash, lastValidBlockHeight } = await getBlockhash(connection);

  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(messageV0);

  onStatus?.("signing");
  const signed = await signTransaction(transaction);

  onStatus?.("submitting");
  // skipPreflight: true — Phantom injects Lighthouse assertions during signing
  // that cause preflight simulation to fail on the RPC node.
  // maxRetries: 5 — ask the RPC to re-broadcast if validators don't respond.
  const txid = await connection.sendTransaction(signed, {
    skipPreflight: true,
    maxRetries: 5,
  });

  // Wait for on-chain confirmation and verify success
  let confirmed = false;
  try {
    const confirmation = await connection.confirmTransaction(
      { signature: txid, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    if (confirmation.value.err) {
      throw new Error(
        `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`
      );
    }
    confirmed = true;
  } catch (err: any) {
    if (err?.message?.includes("failed on-chain")) {
      throw err; // Re-throw on-chain failures — these are real errors
    }
    // Timeout: TX was sent but didn't confirm within the validity window.
    // The transaction has expired — funds were NOT moved. The user should retry.
    console.warn("[solana] confirmTransaction timed out for", txid);
  }

  return { txid, confirmed };
}
