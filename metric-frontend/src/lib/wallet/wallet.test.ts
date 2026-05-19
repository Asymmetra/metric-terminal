import { describe, it, expect, vi } from "vitest";
import { makePhantomSigner } from "./phantom-signer";
import { makePrivyStubSigner } from "./privy-stub";
import {
  SignerNotImplementedError,
  SignerNotReadyError,
} from "./types";

// Mock @solana/web3.js Connection — we don't need a real RPC for these unit
// tests; the signer code only forwards to wallet.sendTransaction.
function fakeConnection() {
  // The Connection type is structural enough that an empty object passes the
  // type narrowing in tests once cast.
  return {} as unknown as import("@solana/web3.js").Connection;
}

describe("makePrivyStubSigner", () => {
  it("returns a never-ready signer that throws on every call", async () => {
    const s = makePrivyStubSigner();
    expect(s.isReady).toBe(false);
    expect(s.publicKey).toBeNull();
    expect(s.displayName).toBe("Privy (stub)");
    await expect(s.signMessage("anything")).rejects.toBeInstanceOf(
      SignerNotImplementedError
    );
    await expect(
      s.signAndSendTransaction({
        kind: "solana-versioned",
        base64: "deadbeef",
      })
    ).rejects.toBeInstanceOf(SignerNotImplementedError);
  });
});

describe("makePhantomSigner", () => {
  it("reports unready when no wallet is connected", () => {
    const wallet = {
      publicKey: null,
      sendTransaction: undefined,
      signMessage: undefined,
    } as unknown as import("@solana/wallet-adapter-react").WalletContextState;
    const signer = makePhantomSigner(wallet, fakeConnection());
    expect(signer.isReady).toBe(false);
    expect(signer.publicKey).toBeNull();
    expect(signer.displayName).toBe("Phantom");
  });

  it("signMessage throws SignerNotReadyError when adapter lacks signMessage", async () => {
    const wallet = {
      publicKey: null,
      sendTransaction: undefined,
      signMessage: undefined,
    } as unknown as import("@solana/wallet-adapter-react").WalletContextState;
    const signer = makePhantomSigner(wallet, fakeConnection());
    await expect(signer.signMessage("hi")).rejects.toBeInstanceOf(
      SignerNotReadyError
    );
  });

  it("signMessage forwards to adapter and base58-encodes the result", async () => {
    // Adapter signature for "metric" → arbitrary 32 bytes.
    const sigBytes = new Uint8Array(32).fill(7);
    const signMessageMock = vi.fn().mockResolvedValue(sigBytes);

    const wallet = {
      publicKey: { toBase58: () => "Wallet1111111111111111111111111111111111111" },
      sendTransaction: () => Promise.resolve("sig"),
      signMessage: signMessageMock,
    } as unknown as import("@solana/wallet-adapter-react").WalletContextState;

    const signer = makePhantomSigner(wallet, fakeConnection());
    const result = await signer.signMessage("metric");

    expect(signMessageMock).toHaveBeenCalledOnce();
    const arg = signMessageMock.mock.calls[0]![0] as Uint8Array;
    expect(new TextDecoder().decode(arg)).toBe("metric");
    expect(typeof result.signatureBase58).toBe("string");
    expect(result.signatureBase58.length).toBeGreaterThan(0);
  });
});
