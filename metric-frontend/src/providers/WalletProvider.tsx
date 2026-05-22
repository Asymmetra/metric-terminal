"use client";

import { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import "@solana/wallet-adapter-react-ui/styles.css";
import { SOLANA_RPC_URL } from "@/lib/solana-rpc";

export function WalletProviderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  // Use the configured endpoint directly. We deliberately do NOT probe/race
  // RPCs at boot — the ConnectionProvider only hits the endpoint when a request
  // is actually made (deposit/withdraw), so probing just spammed the console
  // with errors from rate-limited/forbidden public endpoints on every load.
  // The trading UI (chart, orders, positions) runs entirely off Imperial and
  // needs no RPC.
  return (
    <ConnectionProvider endpoint={SOLANA_RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
