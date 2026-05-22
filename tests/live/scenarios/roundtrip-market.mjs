/**
 * Flagship: the full "Deposit & Trade" → "Close & Withdraw" round-trip that the
 * UI orchestrates. deposit shortfall → market open → verify position → market
 * close → settle → sweep → withdraw the full free balance. Funds return to the
 * wallet, so it's repeatable.
 */
export const meta = {
  id: "roundtrip-market",
  kind: "onchain",
  cost: "open+close fees + spread on $20 notional + 2 base fees (~cents)",
  summary: "deposit → market open → close → sweep → withdraw (full lifecycle)",
};

export default async function run(ctx) {
  const {
    r, ensureJwt, getRpc, walletSol, profileFreeUsd, ensureFunded, withdrawAll, placeOrder,
    sweepProfile, findOpenPosition, solMark, buildOrder, buildClose, pollUntil, PROFILE,
  } = ctx;
  const COL = 10;
  const SIZE = 20;
  const BUFFER = Number(process.env.BUFFER_USD ?? "0.3");
  // GMTrade reliably accepts market opens; Phoenix is CLOB (limit-only via this
  // path) and Flash/Jupiter have size/collateral constraints. Override per env.
  const VENUE = process.env.MARKET_VENUE ?? "gmtrade";

  const jwt = await ensureJwt();
  const rpc = getRpc();
  const sol = await walletSol(rpc);
  r.info(`wallet gas: ${sol.toFixed(4)} SOL`);
  if (sol < 0.01) throw new Error(`need ≥0.01 SOL for gas (have ${sol.toFixed(4)})`);

  // 1. fund profile to collateral + fee buffer (deposits only the shortfall)
  const { deposited } = await ensureFunded(rpc, jwt, PROFILE, COL + BUFFER);
  r.ok(deposited > 0 ? "deposit funded profile" : "deposit skipped (already funded)", deposited > 0 ? `+$${deposited.toFixed(2)}` : undefined);

  // 2. open market long SOL
  const mark = await solMark();
  await placeOrder(jwt, buildOrder({ profileIndex: PROFILE, venue: VENUE, side: "long", type: "market", sizeUsd: SIZE, collateralUsd: COL, markPrice: mark, slippageBps: 200, symbol: "SOL" }), "open");
  r.ok("market open submitted", `long SOL $${SIZE} @ ~$${mark.toFixed(2)} (col $${COL})`);

  // 3. verify the position opened
  const opened = await pollUntil(async () => !!(await findOpenPosition("SOL", PROFILE)), { timeoutMs: 30_000 });
  if (!r.assert(opened, "position open in /positions")) return;
  const pos = await findOpenPosition("SOL", PROFILE);
  r.info(`position size=$${Number(pos.sizeUsd).toFixed(2)} side=${pos.side} lev=${pos.leverageX ?? "?"}`);

  // 4. close (full size, market Decrease)
  const preCloseFree = await profileFreeUsd(jwt, PROFILE);
  await placeOrder(jwt, buildClose({ profileIndex: PROFILE, venue: VENUE, positionSide: "long", sizeUsd: Math.max(Number(pos.sizeUsd), SIZE), markPrice: mark, slippageBps: 200, symbol: "SOL" }), "close");
  r.ok("market close submitted");

  // 5. settle + sweep
  await pollUntil(async () => (await profileFreeUsd(jwt, PROFILE)) > preCloseFree, { timeoutMs: 60_000 });
  const sweep = await sweepProfile(PROFILE);
  r.ok("sweep", `status=${sweep?.status}`);
  if (sweep?.status === "swept") await pollUntil(async () => (await profileFreeUsd(jwt, PROFILE)) > preCloseFree, { timeoutMs: 30_000 });

  // 6. verify the position is closed
  const closed = await pollUntil(async () => !(await findOpenPosition("SOL", PROFILE)), { timeoutMs: 30_000 });
  r.assert(closed, "position closed");

  // 7. withdraw the full free balance back to the wallet
  const { withdrawn } = await withdrawAll(rpc, jwt, PROFILE);
  r.assert(withdrawn > 0, "withdrew freed balance to wallet", `$${withdrawn.toFixed(2)}`);
  r.assert((await profileFreeUsd(jwt, PROFILE)) < 0.01, "round-trip complete — profile drained");
}
