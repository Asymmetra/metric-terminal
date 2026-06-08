"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import "@solana/wallet-adapter-react-ui/styles.css";
import { SOLANA_RPC_CANDIDATES, selectBestRpc } from "@/lib/solana-rpc";

// Browser-safe default: the public fallback is always the LAST candidate and is
// known to answer browser-origin requests. We start the Connection here so it is
// never pointed at a browser-hostile primary, even for the brief window before the
// boot probe resolves.
const SAFE_DEFAULT_RPC = SOLANA_RPC_CANDIDATES[SOLANA_RPC_CANDIDATES.length - 1];

export function WalletProviderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  // Pick a browser-working RPC at boot. The configured primary (NEXT_PUBLIC_
  // SOLANA_RPC) can be a Triton bare host that 403s browser HTTP and fails the
  // auto-derived wss:// handshake — every confirm/balance read then floods the
  // console with errors. selectBestRpc() races the candidates with a getSlot
  // probe and returns the first that actually answers (the env primary when it's
  // browser-CORS-friendly, else the public fallback), so the Connection only ever
  // talks to a live endpoint. Starting from the safe public default means there's
  // no broken-endpoint window before the probe resolves.
  const [endpoint, setEndpoint] = useState<string>(SAFE_DEFAULT_RPC);
  useEffect(() => {
    let alive = true;
    selectBestRpc()
      .then((url) => { if (alive && url) setEndpoint(url); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
