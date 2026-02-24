"use client";

import { useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { api } from "@/lib/api";
import { deserializeInstructions, buildAndSignTransaction, TxStatus } from "@/lib/solana";
import { useTraderStore } from "@/stores/traderStore";

export function useTransactionBuilder() {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();

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
    async (type: "market" | "limit", params: any, onStatus?: (status: TxStatus) => void) => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const builder = type === "market" ? api.buildMarketOrder : api.buildLimitOrder;
      const response = await builder({ ...params, authority: publicKey.toBase58() });
      const instructions = deserializeInstructions(response.instructions);
      const txid = await buildAndSignTransaction(instructions, publicKey, signTransaction, connection, onStatus);
      await refreshTraderData();
      return txid;
    },
    [publicKey, signTransaction, connection, refreshTraderData]
  );

  const cancelOrders = useCallback(
    async (symbol: string, orderIds: { price_in_ticks: number; order_sequence_number: number }[]) => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const response = await api.buildCancelOrders({
        authority: publicKey.toBase58(),
        symbol,
        order_ids: orderIds,
      });
      const instructions = deserializeInstructions(response.instructions);
      const txid = await buildAndSignTransaction(instructions, publicKey, signTransaction, connection);
      await refreshTraderData();
      return txid;
    },
    [publicKey, signTransaction, connection, refreshTraderData]
  );

  const deposit = useCallback(
    async (amountUsdc: number) => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const response = await api.buildDeposit({
        authority: publicKey.toBase58(),
        amount_usdc: amountUsdc,
      });
      const instructions = deserializeInstructions(response.instructions);
      const txid = await buildAndSignTransaction(instructions, publicKey, signTransaction, connection);
      await refreshTraderData();
      return txid;
    },
    [publicKey, signTransaction, connection, refreshTraderData]
  );

  const withdraw = useCallback(
    async (amountUsdc: number) => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

      const response = await api.buildWithdraw({
        authority: publicKey.toBase58(),
        amount_usdc: amountUsdc,
      });
      const instructions = deserializeInstructions(response.instructions);
      const txid = await buildAndSignTransaction(instructions, publicKey, signTransaction, connection);
      await refreshTraderData();
      return txid;
    },
    [publicKey, signTransaction, connection, refreshTraderData]
  );

  return { submitOrder, cancelOrders, deposit, withdraw, connected: !!publicKey };
}
