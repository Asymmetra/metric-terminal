/**
 * Reproduces the exact UI "Auto" path that failed for the user, end-to-end
 * against the real API:
 *   real /route for SOL (currently returns phoenix — the trap) → apply the
 *   market-venue rule (drop phoenix, cost-ordered fall-through) → deposit EXACTLY
 *   the collateral (no buffer) → open via fall-through until one venue fills →
 *   close → withdraw.
 *
 * This is the regression test for the bug: a Phoenix market route must not strand
 * a deposit; the order must fall through to a market-capable venue and fill.
 */
export const meta = {
  id: "roundtrip-auto",
  kind: "onchain",
  cost: "open + close fees + spread (~cents); funds returned",
  summary: "UI Auto path: /route → fall-through venues → open → close → withdraw",
};

export default async function run(ctx) {
  const {
    r, http, ensureJwt, getRpc, walletSol, profileFreeUsd, ensureFunded, withdrawAll,
    sweepProfile, findOpenPosition, solMark, buildOrder, buildClose, getRoute, marketVenues,
    pollUntil, PROFILE,
  } = ctx;
  const COL = 10;
  const SIZE = 20;

  const jwt = await ensureJwt();
  const rpc = getRpc();
  if ((await walletSol(rpc)) < 0.01) throw new Error("need ≥0.01 SOL for gas");

  // 1. real route — honor the router's pick (Phoenix included), list rest after.
  const route = await getRoute({ asset: "SOL", side: "long", notional: SIZE, desiredLeverage: SIZE / COL });
  r.info(`/route picked: ${route.venue}   candidates: ${(route.candidates || []).map((c) => c.venue).join(",")}`);
  const venues = marketVenues(route, "auto");
  r.assert(venues[0] === route.venue, "router's pick is tried first (honored, not excluded)", `venues=[${venues.join(",")}]`);
  if (!r.assert(venues.length > 0, "a market-capable venue is available")) return;

  // 2. fund EXACTLY the collateral (no buffer) — verifies $10 in == $10 deposited.
  const { deposited } = await ensureFunded(rpc, jwt, PROFILE, COL);
  if (deposited > 0) r.assert(Math.abs(deposited - COL) < 0.001, "deposited exactly the collateral (no buffer)", `$${deposited.toFixed(4)}`);
  else r.ok("deposit skipped (already funded)");

  // 3. open via fall-through across the candidate venues.
  const mark = await solMark();
  let filled = null;
  let lastErr = "";
  for (const v of venues) {
    const body = buildOrder({ profileIndex: PROFILE, venue: v, side: "long", type: "market", sizeUsd: SIZE, collateralUsd: COL, markPrice: mark, slippageBps: 200, symbol: "SOL" });
    const resp = await http("POST", "/mobile/orders", { body, jwt });
    if (resp.status === 200 && resp.body?.success) { filled = v; break; }
    lastErr = resp.body?.error ?? JSON.stringify(resp.body);
    r.info(`  ${v} rejected: ${lastErr}`);
  }
  if (!r.assert(filled, "opened via fall-through", filled ? `filled on ${filled}` : `all venues rejected: ${lastErr}`)) {
    await withdrawAll(rpc, jwt, PROFILE); // never strand the deposit
    return;
  }

  const opened = await pollUntil(async () => !!(await findOpenPosition("SOL", PROFILE)), { timeoutMs: 30_000 });
  if (!r.assert(opened, "position open in /positions")) {
    await withdrawAll(rpc, jwt, PROFILE);
    return;
  }
  const pos = await findOpenPosition("SOL", PROFILE);
  r.info(`position size=$${Number(pos.sizeUsd).toFixed(2)} side=${pos.side} lev=${pos.leverageX ?? "?"}`);

  // 4. close + settle + sweep + withdraw
  const preCloseFree = await profileFreeUsd(jwt, PROFILE);
  const closeBody = buildClose({ profileIndex: PROFILE, venue: filled, positionSide: "long", sizeUsd: Math.max(Number(pos.sizeUsd), SIZE), markPrice: mark, slippageBps: 200, symbol: "SOL" });
  const close = await http("POST", "/mobile/orders", { body: closeBody, jwt });
  if (!r.assert(close.status === 200 && close.body?.success, "market close submitted", close.body?.error ?? "")) {
    await withdrawAll(rpc, jwt, PROFILE);
    return;
  }
  await pollUntil(async () => (await profileFreeUsd(jwt, PROFILE)) > preCloseFree, { timeoutMs: 60_000 });
  await sweepProfile(PROFILE);
  r.assert(await pollUntil(async () => !(await findOpenPosition("SOL", PROFILE)), { timeoutMs: 30_000 }), "position closed");

  const { withdrawn } = await withdrawAll(rpc, jwt, PROFILE);
  r.assert(withdrawn > 0, "withdrew freed balance to wallet", `$${withdrawn.toFixed(2)}`);
  r.assert((await profileFreeUsd(jwt, PROFILE)) < 0.01, "round-trip complete — profile drained");
}
