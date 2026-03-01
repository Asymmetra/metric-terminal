"use client";

import { useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { api } from "@/lib/api";
import { deserializeInstructions, buildAndSignTransaction, TxStatus, TxResult } from "@/lib/solana";
import { useTraderStore } from "@/stores/traderStore";
import { useToastStore } from "@/stores/toastStore";

const STATUS_LABELS: Record<TxStatus, string> = {
  simulating: "Simulating...",
  signing: "Waiting for Signature...",
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
        useTraderStore.getState().setAccounts(data.accounts);
      }
    } catch (e) {
      console.debug("Post-tx trader refresh failed:", e);
    }
  }, [publicKey]);

  const submitOrder = useCallback(
    async (type: "market" | "limit", params: any, onStatus?: (status: TxStatus) => void): Promise<TxResult> => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const label = type === "market" ? "Market Order" : "Limit Order";
      const toastId = addToast("loading", `Building ${label}`);

      try {
        const builder = type === "market" ? api.buildMarketOrder : api.buildLimitOrder;
        const response = await builder({ ...params, authority: publicKey.toBase58() });
        const instructions = deserializeInstructions(response.instructions);

        const result = await buildAndSignTransaction(
          instructions, publicKey, signTransaction, connection,
          (status) => {
            onStatus?.(status);
            updateToast(toastId, { title: STATUS_LABELS[status] });
          }
        );

        if (result.confirmed) {
          updateToast(toastId, { type: "success", title: `${label} Confirmed` });
        } else {
          updateToast(toastId, { type: "info", title: `${label} Sent`, detail: "Awaiting confirmation" });
        }

        await refreshTraderData();
        return result;
      } catch (e: any) {
        updateToast(toastId, { type: "error", title: `${label} Failed`, detail: e?.message });
        throw e;
      }
    },
    [publicKey, signTransaction, connection, refreshTraderData, addToast, updateToast]
  );

  const cancelOrders = useCallback(
    async (symbol: string, orderIds: { price_in_ticks: number; order_sequence_number: number }[]): Promise<TxResult> => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const toastId = addToast("loading", "Building Cancel");

      try {
        const response = await api.buildCancelOrders({
          authority: publicKey.toBase58(),
          symbol,
          order_ids: orderIds,
        });
        const instructions = deserializeInstructions(response.instructions);

        const result = await buildAndSignTransaction(
          instructions, publicKey, signTransaction, connection,
          (status) => updateToast(toastId, { title: STATUS_LABELS[status] })
        );

        if (result.confirmed) {
          updateToast(toastId, { type: "success", title: "Order Cancelled" });
        } else {
          updateToast(toastId, { type: "info", title: "Cancel Sent", detail: "Awaiting confirmation" });
        }

        await refreshTraderData();
        return result;
      } catch (e: any) {
        updateToast(toastId, { type: "error", title: "Cancel Failed", detail: e?.message });
        throw e;
      }
    },
    [publicKey, signTransaction, connection, refreshTraderData, addToast, updateToast]
  );

  const deposit = useCallback(
    async (amountUsdc: number): Promise<TxResult> => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const toastId = addToast("loading", "Building Deposit");

      try {
        const response = await api.buildDeposit({
          authority: publicKey.toBase58(),
          amount_usdc: amountUsdc,
        });
        const instructions = deserializeInstructions(response.instructions);

        const result = await buildAndSignTransaction(
          instructions, publicKey, signTransaction, connection,
          (status) => updateToast(toastId, { title: STATUS_LABELS[status] })
        );

        if (result.confirmed) {
          updateToast(toastId, { type: "success", title: "Deposit Confirmed" });
        } else {
          updateToast(toastId, { type: "info", title: "Deposit Sent", detail: "Awaiting confirmation" });
        }

        await refreshTraderData();
        return result;
      } catch (e: any) {
        updateToast(toastId, { type: "error", title: "Deposit Failed", detail: e?.message });
        throw e;
      }
    },
    [publicKey, signTransaction, connection, refreshTraderData, addToast, updateToast]
  );

  const withdraw = useCallback(
    async (amountUsdc: number): Promise<TxResult> => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const toastId = addToast("loading", "Building Withdrawal");

      try {
        const response = await api.buildWithdraw({
          authority: publicKey.toBase58(),
          amount_usdc: amountUsdc,
        });
        const instructions = deserializeInstructions(response.instructions);

        const result = await buildAndSignTransaction(
          instructions, publicKey, signTransaction, connection,
          (status) => updateToast(toastId, { title: STATUS_LABELS[status] })
        );

        if (result.confirmed) {
          updateToast(toastId, { type: "success", title: "Withdrawal Confirmed" });
        } else {
          updateToast(toastId, { type: "info", title: "Withdrawal Sent", detail: "Awaiting confirmation" });
        }

        await refreshTraderData();
        return result;
      } catch (e: any) {
        updateToast(toastId, { type: "error", title: "Withdrawal Failed", detail: e?.message });
        throw e;
      }
    },
    [publicKey, signTransaction, connection, refreshTraderData, addToast, updateToast]
  );

  const submitIsolatedOrder = useCallback(
    async (type: "market" | "limit", params: any, onStatus?: (status: TxStatus) => void): Promise<TxResult> => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const label = type === "market" ? "Isolated Market Order" : "Isolated Limit Order";
      const toastId = addToast("loading", `Building ${label}`);

      try {
        const builder = type === "market" ? api.buildIsolatedMarketOrder : api.buildIsolatedLimitOrder;
        const response = await builder({ ...params, authority: publicKey.toBase58() });
        const instructions = deserializeInstructions(response.instructions);

        const result = await buildAndSignTransaction(
          instructions, publicKey, signTransaction, connection,
          (status) => {
            onStatus?.(status);
            updateToast(toastId, { title: STATUS_LABELS[status] });
          }
        );

        if (result.confirmed) {
          updateToast(toastId, { type: "success", title: `${label} Confirmed` });
        } else {
          updateToast(toastId, { type: "info", title: `${label} Sent`, detail: "Awaiting confirmation" });
        }

        await refreshTraderData();
        return result;
      } catch (e: any) {
        updateToast(toastId, { type: "error", title: `${label} Failed`, detail: e?.message });
        throw e;
      }
    },
    [publicKey, signTransaction, connection, refreshTraderData, addToast, updateToast]
  );

  const transferCollateral = useCallback(
    async (fromSubaccountIndex: number, toSubaccountIndex: number, amountUsdc: number): Promise<TxResult> => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const toastId = addToast("loading", "Building Transfer");

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
          (status) => updateToast(toastId, { title: STATUS_LABELS[status] })
        );

        if (result.confirmed) {
          updateToast(toastId, { type: "success", title: "Transfer Confirmed" });
        } else {
          updateToast(toastId, { type: "info", title: "Transfer Sent", detail: "Awaiting confirmation" });
        }

        await refreshTraderData();
        return result;
      } catch (e: any) {
        updateToast(toastId, { type: "error", title: "Transfer Failed", detail: e?.message });
        throw e;
      }
    },
    [publicKey, signTransaction, connection, refreshTraderData, addToast, updateToast]
  );

  return { submitOrder, submitIsolatedOrder, cancelOrders, deposit, withdraw, transferCollateral, connected: !!publicKey };
}
