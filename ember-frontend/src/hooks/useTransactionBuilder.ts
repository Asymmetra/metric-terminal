"use client";

import { useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { api } from "@/lib/api";
import { deserializeInstructions, buildAndSignTransaction, TxStatus, TxResult } from "@/lib/solana";
import { useTraderStore } from "@/stores/traderStore";
import { useToastStore } from "@/stores/toastStore";

const STATUS_LABELS: Record<TxStatus, string> = {
  simulating: "Simulating transaction...",
  signing: "Waiting for wallet signature...",
  submitting: "Submitting to Solana...",
};

export function useTransactionBuilder() {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const addToast = useToastStore((s) => s.addToast);
  const updateToast = useToastStore((s) => s.updateToast);

  // Refresh trader data from REST after a confirmed transaction
  const refreshTraderData = useCallback(async () => {
    if (!publicKey) return;
    try {
      const data = await api.getTrader(publicKey.toBase58());
      if (data?.accounts?.length > 0) {
        const primary = data.accounts.find(
          (a: any) => a.traderSubaccountIndex === 0
        ) || data.accounts[0];
        useTraderStore.getState().setAccount(primary);
      }
    } catch (e) {
      console.debug("Post-tx trader refresh failed:", e);
    }
  }, [publicKey]);

  const submitOrder = useCallback(
    async (type: "market" | "limit", params: any, onStatus?: (status: TxStatus) => void): Promise<TxResult> => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const toastId = addToast("loading", "Building transaction...");

      try {
        const builder = type === "market" ? api.buildMarketOrder : api.buildLimitOrder;
        const response = await builder({ ...params, authority: publicKey.toBase58() });
        const instructions = deserializeInstructions(response.instructions);

        const result = await buildAndSignTransaction(
          instructions, publicKey, signTransaction, connection,
          (status) => {
            onStatus?.(status);
            updateToast(toastId, { message: STATUS_LABELS[status] });
          }
        );

        if (result.confirmed) {
          updateToast(toastId, { type: "success", message: "Transaction confirmed" });
        } else {
          updateToast(toastId, { type: "info", message: "Transaction sent — awaiting confirmation" });
        }

        await refreshTraderData();
        return result;
      } catch (e: any) {
        updateToast(toastId, { type: "error", message: e?.message || "Transaction failed" });
        throw e;
      }
    },
    [publicKey, signTransaction, connection, refreshTraderData, addToast, updateToast]
  );

  const cancelOrders = useCallback(
    async (symbol: string, orderIds: { price_in_ticks: number; order_sequence_number: number }[]): Promise<TxResult> => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const toastId = addToast("loading", "Building cancel transaction...");

      try {
        const response = await api.buildCancelOrders({
          authority: publicKey.toBase58(),
          symbol,
          order_ids: orderIds,
        });
        const instructions = deserializeInstructions(response.instructions);

        const result = await buildAndSignTransaction(
          instructions, publicKey, signTransaction, connection,
          (status) => updateToast(toastId, { message: STATUS_LABELS[status] })
        );

        if (result.confirmed) {
          updateToast(toastId, { type: "success", message: "Order cancelled" });
        } else {
          updateToast(toastId, { type: "info", message: "Cancel sent — awaiting confirmation" });
        }

        await refreshTraderData();
        return result;
      } catch (e: any) {
        updateToast(toastId, { type: "error", message: e?.message || "Cancel failed" });
        throw e;
      }
    },
    [publicKey, signTransaction, connection, refreshTraderData, addToast, updateToast]
  );

  const deposit = useCallback(
    async (amountUsdc: number): Promise<TxResult> => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const toastId = addToast("loading", "Building deposit transaction...");

      try {
        const response = await api.buildDeposit({
          authority: publicKey.toBase58(),
          amount_usdc: amountUsdc,
        });
        const instructions = deserializeInstructions(response.instructions);

        const result = await buildAndSignTransaction(
          instructions, publicKey, signTransaction, connection,
          (status) => updateToast(toastId, { message: STATUS_LABELS[status] })
        );

        if (result.confirmed) {
          updateToast(toastId, { type: "success", message: "Deposit confirmed" });
        } else {
          updateToast(toastId, { type: "info", message: "Deposit sent — awaiting confirmation" });
        }

        await refreshTraderData();
        return result;
      } catch (e: any) {
        updateToast(toastId, { type: "error", message: e?.message || "Deposit failed" });
        throw e;
      }
    },
    [publicKey, signTransaction, connection, refreshTraderData, addToast, updateToast]
  );

  const withdraw = useCallback(
    async (amountUsdc: number): Promise<TxResult> => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const toastId = addToast("loading", "Building withdraw transaction...");

      try {
        const response = await api.buildWithdraw({
          authority: publicKey.toBase58(),
          amount_usdc: amountUsdc,
        });
        const instructions = deserializeInstructions(response.instructions);

        const result = await buildAndSignTransaction(
          instructions, publicKey, signTransaction, connection,
          (status) => updateToast(toastId, { message: STATUS_LABELS[status] })
        );

        if (result.confirmed) {
          updateToast(toastId, { type: "success", message: "Withdrawal confirmed" });
        } else {
          updateToast(toastId, { type: "info", message: "Withdrawal sent — awaiting confirmation" });
        }

        await refreshTraderData();
        return result;
      } catch (e: any) {
        updateToast(toastId, { type: "error", message: e?.message || "Withdrawal failed" });
        throw e;
      }
    },
    [publicKey, signTransaction, connection, refreshTraderData, addToast, updateToast]
  );

  const submitIsolatedOrder = useCallback(
    async (type: "market" | "limit", params: any, onStatus?: (status: TxStatus) => void): Promise<TxResult> => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const toastId = addToast("loading", "Building isolated order...");

      try {
        const builder = type === "market" ? api.buildIsolatedMarketOrder : api.buildIsolatedLimitOrder;
        const response = await builder({ ...params, authority: publicKey.toBase58() });
        const instructions = deserializeInstructions(response.instructions);

        const result = await buildAndSignTransaction(
          instructions, publicKey, signTransaction, connection,
          (status) => {
            onStatus?.(status);
            updateToast(toastId, { message: STATUS_LABELS[status] });
          }
        );

        if (result.confirmed) {
          updateToast(toastId, { type: "success", message: "Isolated order confirmed" });
        } else {
          updateToast(toastId, { type: "info", message: "Isolated order sent — awaiting confirmation" });
        }

        await refreshTraderData();
        return result;
      } catch (e: any) {
        updateToast(toastId, { type: "error", message: e?.message || "Isolated order failed" });
        throw e;
      }
    },
    [publicKey, signTransaction, connection, refreshTraderData, addToast, updateToast]
  );

  const transferCollateral = useCallback(
    async (fromSubaccountIndex: number, toSubaccountIndex: number, amountUsdc: number): Promise<TxResult> => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const toastId = addToast("loading", "Building collateral transfer...");

      try {
        const response = await api.buildTransferCollateral({
          authority: publicKey.toBase58(),
          from_subaccount_index: fromSubaccountIndex,
          to_subaccount_index: toSubaccountIndex,
          amount_usdc: amountUsdc,
        });
        const instructions = deserializeInstructions(response.instructions);

        const result = await buildAndSignTransaction(
          instructions, publicKey, signTransaction, connection,
          (status) => updateToast(toastId, { message: STATUS_LABELS[status] })
        );

        if (result.confirmed) {
          updateToast(toastId, { type: "success", message: "Collateral transfer confirmed" });
        } else {
          updateToast(toastId, { type: "info", message: "Transfer sent — awaiting confirmation" });
        }

        await refreshTraderData();
        return result;
      } catch (e: any) {
        updateToast(toastId, { type: "error", message: e?.message || "Transfer failed" });
        throw e;
      }
    },
    [publicKey, signTransaction, connection, refreshTraderData, addToast, updateToast]
  );

  return { submitOrder, submitIsolatedOrder, cancelOrders, deposit, withdraw, transferCollateral, connected: !!publicKey };
}
