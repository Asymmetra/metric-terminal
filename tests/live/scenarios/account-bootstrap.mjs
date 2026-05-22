/**
 * Exercise account/ATA creation inside a deposit: deposit a tiny amount into an
 * empty profile (its USDC ATA isn't created yet — operator sponsors the rent),
 * verify the balance appears, then withdraw it back to clean up.
 *
 * (The user-account PDA already exists for the funded test wallet; full PDA
 * creation can only be re-tested with a fresh keypair.)
 */
export const meta = {
  id: "account-bootstrap",
  kind: "onchain",
  cost: "2 base tx fees (~$0.00x); funds returned",
  summary: "deposit into an empty profile (creates the USDC ATA) then withdraw",
};

export default async function run(ctx) {
  const { r, ensureJwt, getRpc, walletSol, walletUsdc, getBalances, profileFreeUsd, buildSignSubmit, withdrawAll, pollUntil } = ctx;
  const AMT = Number(process.env.AMOUNT_USD ?? "0.2");

  const jwt = await ensureJwt();
  const rpc = getRpc();
  if ((await walletSol(rpc)) < 0.01) throw new Error("need ≥0.01 SOL for gas");
  if ((await walletUsdc(rpc)) < AMT) throw new Error(`need ≥$${AMT} wallet USDC`);

  // Prefer a high, empty profile so we don't disturb profile 0's working funds.
  const profiles = await getBalances(jwt);
  const empty = [...profiles].reverse().find((p) => p.usdc === 0);
  if (!empty) {
    r.warn("no empty profile to bootstrap (all funded) — skipping");
    return;
  }
  const target = empty.profileIndex;
  r.info(`bootstrapping empty profile ${target} (pda ${empty.profilePda.slice(0, 8)}…)`);

  const sig = await buildSignSubmit(rpc, { profileIndex: target, amountUsd: AMT, mode: "deposit" });
  const created = await pollUntil(async () => (await profileFreeUsd(jwt, target)) >= AMT - 1e-6);
  r.assert(created, "USDC ATA created + funded", `$${AMT} → profile ${target}  ${sig.slice(0, 12)}…`);

  const { withdrawn } = await withdrawAll(rpc, jwt, target);
  r.assert(withdrawn > 0, "withdrawn back to wallet", `$${withdrawn.toFixed(4)}`);
  r.assert((await profileFreeUsd(jwt, target)) < 0.01, "profile drained", `profile ${target} ≈ $0`);
}
