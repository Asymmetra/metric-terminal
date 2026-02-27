"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useTraderStore } from "@/stores/traderStore";
import { wsClient } from "@/lib/ws";
import { api } from "@/lib/api";

/**
 * Syncs trader state with wallet connection.
 * On connect: fetches trader data from backend + subscribes to trader_margin WS.
 * On disconnect: resets trader store + unsubscribes.
 */
export function useTraderSync() {
  const { publicKey, connected } = useWallet();
  const setAccounts = useTraderStore((s) => s.setAccounts);
  const setConnected = useTraderStore((s) => s.setConnected);
  const reset = useTraderStore((s) => s.reset);
  const prevPubkey = useRef<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const pubkeyStr = publicKey?.toBase58() || null;

    // Wallet disconnected
    if (!connected || !pubkeyStr) {
      if (prevPubkey.current) {
        unsubRef.current?.();
        unsubRef.current = null;
        reset();
        prevPubkey.current = null;
      }
      return;
    }

    // Same wallet, already synced
    if (pubkeyStr === prevPubkey.current) return;

    prevPubkey.current = pubkeyStr;
    setConnected(true, pubkeyStr);

    // Fetch initial trader state from REST
    async function fetchTraderData() {
      try {
        const data = await api.getTrader(pubkeyStr!);
        if (data?.accounts?.length > 0) {
          setAccounts(data.accounts);
        }
      } catch (e) {
        // If trader has no account, that's fine — just log it
        console.debug("Trader data fetch:", e);
      }
    }

    fetchTraderData();

    // Subscribe to real-time trader_margin WS updates
    // SDK uses #[serde(flatten)] + #[serde(tag = "messageType")], producing flat JSON:
    // { "authority": "...", "messageType": "snapshot", "subaccounts": [...] }
    // WS snapshots use raw SDK format (flat strings like collateral: '23673164'),
    // NOT the REST Decimal format ({decimals, ui, value}) that setAccount() expects.
    // Use WS messages as a trigger to re-fetch via REST for correct data shapes.
    unsubRef.current = wsClient.subscribeTrader(pubkeyStr, (data: any) => {
      if (data?.messageType === "snapshot" || data?.messageType === "delta") {
        fetchTraderData();
      }
    });

    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, [connected, publicKey, setAccounts, setConnected, reset]);
}
