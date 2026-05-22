/** T1: auth handshake + read endpoints. No chain writes, no money. */
export const meta = {
  id: "auth-reads",
  kind: "safe",
  cost: "free (reads only)",
  summary: "JWT handshake + balances / positions / trades / mark-prices",
};

export default async function run(ctx) {
  const { r, http, ensureJwt, getBalances, getPositions, WALLET } = ctx;

  const jwt = await ensureJwt();
  r.ok("auth handshake", `jwt ${jwt.length} chars`);

  const profiles = await getBalances(jwt);
  r.assert(profiles.length === 6, "balances: 6 isolated profiles", `got ${profiles.length}`);
  profiles.forEach((p) => r.info(`profile ${p.profileIndex}: $${(p.usdc / 1e6).toFixed(6)}  pda ${p.profilePda.slice(0, 8)}…`));

  const pos = await getPositions();
  r.ok("GET /positions", `open=${pos.length}`);

  const tr = await http("GET", `/trades?walletAddress=${WALLET}&limit=5`);
  r.assert(tr.status === 200, "GET /trades", `status ${tr.status}`);

  const mk = await http("GET", "/mark-prices");
  r.assert(mk.status === 200 && mk.body?.rows?.length > 0, "GET /mark-prices", `rows ${mk.body?.rows?.length ?? 0}`);
}
