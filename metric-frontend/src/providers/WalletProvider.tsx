"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import "@solana/wallet-adapter-react-ui/styles.css";
import {
  SOLANA_RPC_URL,
  selectBestRpc,
} from "@/lib/solana-rpc";

export function WalletProviderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  // Start with the synchronous primary (env var if set, else first public
  // fallback). At mount, race the candidates and swap to whichever
  // responds first — so a stale env var or a degraded primary doesn't
  // brick deposits.
  const [endpoint, setEndpoint] = useState<string>(SOLANA_RPC_URL);
  useEffect(() => {
    let cancelled = false;
    selectBestRpc().then((url) => {
      if (!cancelled && url !== endpoint) {
        setEndpoint(url);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
