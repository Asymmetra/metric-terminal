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

export async function buildAndSignTransaction(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  connection: Connection,
  onStatus?: (status: TxStatus) => void
): Promise<TxResult> {
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
      `Transaction simulation failed: ${JSON.stringify(simulation.value.err)}\n${logs}`
    );
  }

  onStatus?.("signing");
  const signed = await signTransaction(transaction);

  onStatus?.("submitting");
  // skipPreflight: true — Phantom injects Lighthouse assertions during signing
  // that cause preflight simulation to fail on the RPC node
  const txid = await connection.sendTransaction(signed, { skipPreflight: true });

  // Wait for on-chain confirmation
  let confirmed = false;
  try {
    await connection.confirmTransaction(
      { signature: txid, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    confirmed = true;
  } catch {
    // TX was already sent — it may still land on-chain
    console.warn("[solana] confirmTransaction timed out for", txid);
  }

  return { txid, confirmed };
}
