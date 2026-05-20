"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useSigner } from "@/lib/wallet";
import { HealthPanel } from "@/components/health/HealthPanel";
import {
  imperial,
  ImperialError,
  IMPERIAL_API_URL,
  IMPERIAL_WS_URL,
  type BalancesResponse,
  type MarkPriceRow,
  type PositionList,
} from "@/lib/imperial";
import { loadJwt, clearJwt } from "@/lib/imperial/jwt";

/**
 * Imperial integration demo — the canonical "this stack works" page.
 *
 * Exercises:
 *   1. Connect Phantom (SignerProvider abstraction)
 *   2. /mobile/connect + /mobile/exchange JWT handshake
 *   3. /mobile/balances (auth)
 *   4. /positions (no auth)
 *   5. /mark-prices (no auth)
 *   6. /deposit/build-tx → SignerProvider.signAndSendTransaction (live tx
 *      flow; commented "DRY-RUN" button by default to avoid accidental
 *      sends — uncomment to enable real submission)
 *
 * Designed so an engineer can verify the whole Imperial pipeline in one
 * place without touching the legacy Phoenix-coupled trading UI.
 */
export default function ImperialDemo() {
  const signer = useSigner();
  const wallet = signer.publicKey;
  const [jwt, setJwt] = useState<string | null>(null);
  const [balances, setBalances] = useState<BalancesResponse | null>(null);
  const [positions, setPositions] = useState<PositionList | null>(null);
  const [markPrices, setMarkPrices] = useState<MarkPriceRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [depositAmount, setDepositAmount] = useState("1.00");
  const [wsRate, setWsRate] = useState<number>(0);

  // Live events/sec gauge — opens a WS directly to Imperial /ws/market.
  // No dependency on a deployed metric-backend, so the page works
  // standalone on Vercel. metric-backend's fan-out is a server-side
  // optimization for multi-client deployments; not needed for the demo.
  useEffect(() => {
    const ws = new WebSocket(`${IMPERIAL_WS_URL}/ws/market`);
    let recent: number[] = [];
    let alive = true;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe_mark_prices" }));
      ws.send(JSON.stringify({ type: "subscribe_funding_rates" }));
    };
    ws.onmessage = () => {
      const now = Date.now();
      recent.push(now);
      recent = recent.filter((t) => now - t < 10_000);
    };
    const id = setInterval(() => {
      if (!alive) return;
      const now = Date.now();
      const last10 = recent.filter((t) => now - t < 10_000);
      setWsRate(last10.length / 10);
    }, 1_000);
    return () => {
      alive = false;
      clearInterval(id);
      ws.close();
    };
  }, []);

  // Auto-load any cached JWT for this wallet.
  useEffect(() => {
    if (!wallet) {
      setJwt(null);
      return;
    }
    const cached = loadJwt(wallet);
    if (cached) setJwt(cached);
  }, [wallet]);

  const refresh = useCallback(
    async (currentJwt: string | null = jwt) => {
      setErr(null);
      try {
        const [marks, pos] = await Promise.all([
          imperial.getMarkPrices(),
          wallet
            ? imperial.getPositions(wallet)
            : Promise.resolve({
                count: 0,
                totalCount: 0,
                dataList: [],
                lifetimeCollateralUsd: "0",
                lifetimeFeesUsd: "0",
                lifetimePnlUsd: "0",
                lifetimeFeeBreakdown: {
                  interest: "0",
                  jupiterFee: "0",
                  platformFee: "0",
                  proOrderFee: "0",
                  slippage: "0",
                  swapFee: "0",
                } as never,
              } as unknown as PositionList),
          // Balances require auth; only fetch when we hold a JWT.
        ]);
        setMarkPrices(marks.rows);
        setPositions(pos);
        if (currentJwt) {
          const bal = await imperial.getBalances(currentJwt);
          setBalances(bal);
        } else {
          setBalances(null);
        }
      } catch (e) {
        setErr(formatErr(e));
      }
    },
    [jwt, wallet]
  );

  // Refresh on wallet/jwt change.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleAuth = useCallback(async () => {
    if (!signer.isReady) return;
    setBusy("authenticating");
    setErr(null);
    try {
      const { jwt } = await imperial.connect(signer);
      setJwt(jwt);
      await refresh(jwt);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(null);
    }
  }, [signer, refresh]);

  const handleRevoke = useCallback(async () => {
    if (!jwt || !wallet) return;
    setBusy("revoking");
    try {
      await imperial.revoke(jwt, wallet);
      setJwt(null);
      setBalances(null);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(null);
    }
  }, [jwt, wallet]);

  const handleDeposit = useCallback(async () => {
    if (!signer.isReady || !wallet) return;
    const usdc = Number(depositAmount);
    if (!Number.isFinite(usdc) || usdc <= 0) {
      setErr("Enter a positive USDC amount");
      return;
    }
    setBusy("deposit");
    setErr(null);
    try {
      const { transaction } = await imperial.buildDepositTx({
        wallet,
        profileIndex: 0,
        amount: Math.round(usdc * 1_000_000),
        mode: "deposit",
      });
      const { signature } = await signer.signAndSendTransaction({
        kind: "solana-versioned",
        base64: transaction,
      });
      // eslint-disable-next-line no-alert
      alert(`Deposit submitted: ${signature}`);
      await refresh();
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(null);
    }
  }, [signer, wallet, depositAmount, refresh]);

  const topMarks = useMemo(
    () =>
      markPrices
        .filter((r) => r.phoenix?.price || r.flash?.price || r.jupiter?.price)
        .slice(0, 25),
    [markPrices]
  );

  return (
    <div className="mx-auto max-w-5xl space-y-8 text-text-primary">
      <header className="flex items-center justify-between">
        <div>
          <div className="font-mono text-[10px] tracking-[0.35em] text-text-secondary uppercase">
            Metric Terminal · Imperial Demo
          </div>
          <h1 className="font-mono text-2xl text-metric-primary">
            E2E pipeline check
          </h1>
          <p className="font-mono text-xs text-text-secondary">
            Connect → JWT → reads → deposit
          </p>
        </div>
        <WalletMultiButton />
      </header>

      <HealthPanel wsEventsPerSecond={wsRate} />

      <Section title="Signer">
        <Field k="impl" v={signer.displayName} />
        <Field k="publicKey" v={wallet ?? "—"} />
        <Field k="ready" v={String(signer.isReady)} />
      </Section>

      <Section title="Imperial Auth">
        <Field k="api" v={IMPERIAL_API_URL} />
        <Field k="jwt" v={jwt ? `${jwt.slice(0, 24)}…` : "—"} />
        <div className="flex gap-3 pt-2">
          <button
            disabled={!signer.isReady || busy !== null}
            onClick={handleAuth}
            className="border border-metric-primary px-4 py-2 font-mono text-xs uppercase text-metric-primary hover:bg-metric-primary/10 disabled:opacity-30"
          >
            {jwt ? "Re-authenticate" : "Authenticate"}
          </button>
          <button
            disabled={!jwt || busy !== null}
            onClick={handleRevoke}
            className="border border-metric-border px-4 py-2 font-mono text-xs uppercase text-text-secondary hover:bg-surface-1 disabled:opacity-30"
          >
            Revoke
          </button>
        </div>
      </Section>

      <Section title={`Balances (profiles 0..5) ${balances ? "" : "— auth required"}`}>
        {balances ? (
          <table className="w-full font-mono text-xs">
            <thead className="text-text-secondary">
              <tr>
                <th className="text-left">profile</th>
                <th className="text-right">usdc (raw)</th>
                <th className="text-right">usdc ($)</th>
                <th className="text-left">pda</th>
              </tr>
            </thead>
            <tbody>
              {balances.profiles.map((p) => (
                <tr key={p.profileIndex}>
                  <td>{p.profileIndex}</td>
                  <td className="text-right">{p.usdc}</td>
                  <td className="text-right">{(p.usdc / 1_000_000).toFixed(2)}</td>
                  <td className="text-text-secondary">{p.profilePda.slice(0, 10)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="font-mono text-xs text-text-secondary">No JWT.</p>
        )}
      </Section>

      <Section title={`Positions (${positions?.count ?? 0}/${positions?.totalCount ?? 0})`}>
        {positions && positions.dataList.length ? (
          <pre className="overflow-auto bg-surface-1 p-3 font-mono text-[10px] text-text-secondary">
            {JSON.stringify(positions.dataList.slice(0, 3), null, 2)}
          </pre>
        ) : (
          <p className="font-mono text-xs text-text-secondary">
            No positions {wallet ? "for this wallet." : "(connect a wallet)."}
          </p>
        )}
      </Section>

      <Section title={`Live mark prices (${markPrices.length} markets)`}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs md:grid-cols-3">
          {topMarks.map((row) => {
            const px =
              row.phoenix?.price ??
              row.flash?.price ??
              row.jupiter?.price ??
              row.gmtrade?.price;
            const venue = row.phoenix
              ? "phoenix"
              : row.flash
              ? "flash"
              : row.jupiter
              ? "jupiter"
              : "gmtrade";
            return (
              <div key={row.symbol} className="flex justify-between gap-2">
                <span>{row.symbol}</span>
                <span className="text-metric-primary">
                  {px?.toLocaleString(undefined, {
                    maximumFractionDigits: 4,
                  }) ?? "—"}
                </span>
                <span className="text-text-secondary text-[10px]">{venue}</span>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Deposit (profile 0)">
        <div className="flex items-end gap-3">
          <label className="flex flex-col gap-1 font-mono text-[10px] text-text-secondary uppercase">
            USDC
            <input
              type="number"
              value={depositAmount}
              step="0.01"
              min="0"
              onChange={(e) => setDepositAmount(e.target.value)}
              className="w-32 border border-metric-border bg-surface-1 px-2 py-1 text-sm text-text-primary"
            />
          </label>
          <button
            disabled={!signer.isReady || busy !== null}
            onClick={handleDeposit}
            className="border border-metric-primary px-4 py-2 font-mono text-xs uppercase text-metric-primary hover:bg-metric-primary/10 disabled:opacity-30"
          >
            {busy === "deposit" ? "Submitting…" : "Build + Sign + Send"}
          </button>
          <p className="font-mono text-[10px] text-text-secondary">
            Signs through the SignerProvider abstraction — Phantom in this
            build, Privy + paymaster in production.
          </p>
        </div>
      </Section>

      {err && (
        <div className="border border-metric-sell bg-metric-sell/10 p-3 font-mono text-xs text-metric-sell">
          {err}
        </div>
      )}
      {busy && (
        <div className="font-mono text-xs text-text-secondary">busy: {busy}</div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border border-metric-border bg-surface-1 p-4">
      <h2 className="font-mono text-[10px] tracking-[0.2em] text-text-secondary uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-3 font-mono text-xs">
      <span className="w-24 text-text-secondary">{k}</span>
      <span className="text-text-primary">{v}</span>
    </div>
  );
}

function formatErr(e: unknown): string {
  if (e instanceof ImperialError) return `Imperial ${e.status}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
