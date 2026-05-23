/**
 * Regression for the marketPrice-scale bug: a MARKET order on Phoenix (the venue
 * Imperial's router favors at low leverage) must fill. The bug was sending
 * marketPrice at 1e9 (oracle scale) when Phoenix wants 1e6 (USD 6-dec) — "1000×
 * off" per the Imperial dev. buildOrder now scales per venue (marketPriceFixed),
 * so this opens, closes, and withdraws cleanly on Phoenix specifically.
 */
export const meta = {
  id: "phoenix-market",
  kind: "onchain",
  cost: "open + close fees + spread (~cents); funds returned",
  summary: "Phoenix MARKET open → close → withdraw (proves the venue-scale fix)",
};

export default async function run(ctx) {
  const {
    r, http, ensureJwt, getRpc, walletSol, profileFreeUsd, ensureFunded, withdrawAll,
    sweepProfile, findOpenPosition, solMark, buildOrder, buildClose, pollUntil, PROFILE,
  } = ctx;
  const COL = 10;
  const SIZE = 20;
  const VENUE = "phoenix";

  const jwt = await ensureJwt();
  const rpc = getRpc();
  if ((await walletSol(rpc)) < 0.01) throw new Error("need ≥0.01 SOL for gas");

  await ensureFunded(rpc, jwt, PROFILE, COL);
  const mark = await solMark();

  // open — buildOrder applies the Phoenix 1e6 marketPrice scale internally
  const open = await http("POST", "/mobile/orders", {
    body: buildOrder({ profileIndex: PROFILE, venue: VENUE, side: "long", type: "market", sizeUsd: SIZE, collateralUsd: COL, markPrice: mark, slippageBps: 200, symbol: "SOL" }),
    jwt,
  });
  if (!r.assert(open.status === 200 && open.body?.success, "Phoenix MARKET open filled", open.body?.error ?? open.body?.signature?.slice(0, 12))) {
    await withdrawAll(rpc, jwt, PROFILE);
    return;
  }

  const opened = await pollUntil(async () => !!(await findOpenPosition("SOL", PROFILE)), { timeoutMs: 30_000 });
  if (!r.assert(opened, "position open on Phoenix")) {
    await withdrawAll(rpc, jwt, PROFILE);
    return;
  }
  const pos = await findOpenPosition("SOL", PROFILE);
  r.info(`position size=$${Number(pos.sizeUsd).toFixed(2)} venue=${pos.underwriter} lev=${pos.leverageX ?? "?"}`);

  const preCloseFree = await profileFreeUsd(jwt, PROFILE);
  const close = await http("POST", "/mobile/orders", {
    body: buildClose({ profileIndex: PROFILE, venue: VENUE, positionSide: "long", sizeUsd: Math.max(Number(pos.sizeUsd), SIZE), markPrice: mark, slippageBps: 200, symbol: "SOL" }),
    jwt,
  });
  r.assert(close.status === 200 && close.body?.success, "Phoenix MARKET close filled", close.body?.error ?? "");

  await pollUntil(async () => (await profileFreeUsd(jwt, PROFILE)) > preCloseFree, { timeoutMs: 60_000 });
  await sweepProfile(PROFILE);
  r.assert(await pollUntil(async () => !(await findOpenPosition("SOL", PROFILE)), { timeoutMs: 30_000 }), "position closed");

  const { withdrawn } = await withdrawAll(rpc, jwt, PROFILE);
  r.assert(withdrawn > 0, "withdrew back to wallet", `$${withdrawn.toFixed(2)}`);
  r.assert((await profileFreeUsd(jwt, PROFILE)) < 0.01, "profile drained");
}
