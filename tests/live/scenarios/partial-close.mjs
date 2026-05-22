/**
 * Partial-decrease lifecycle: open a market position, close HALF, verify the
 * size shrank, close the remainder, then withdraw. Exercises Decrease with a
 * partial sizeUsd.
 */
export const meta = {
  id: "partial-close",
  kind: "onchain",
  cost: "open + 2 partial-close fees + spread (~cents); funds returned",
  summary: "open → close half → close remainder → withdraw",
};

export default async function run(ctx) {
  const {
    r, ensureJwt, getRpc, walletSol, profileFreeUsd, ensureFunded, withdrawAll, placeOrder,
    sweepProfile, findOpenPosition, solMark, buildOrder, buildClose, pollUntil, PROFILE,
  } = ctx;
  const COL = 10;
  const SIZE = 20;
  const BUFFER = Number(process.env.BUFFER_USD ?? "0.3");
  const VENUE = process.env.MARKET_VENUE ?? "gmtrade";

  const jwt = await ensureJwt();
  const rpc = getRpc();
  if ((await walletSol(rpc)) < 0.01) throw new Error("need ≥0.01 SOL for gas");

  await ensureFunded(rpc, jwt, PROFILE, COL + BUFFER);
  const mark = await solMark();
  await placeOrder(jwt, buildOrder({ profileIndex: PROFILE, venue: VENUE, side: "long", type: "market", sizeUsd: SIZE, collateralUsd: COL, markPrice: mark, slippageBps: 200, symbol: "SOL" }), "open");
  const opened = await pollUntil(async () => !!(await findOpenPosition("SOL", PROFILE)), { timeoutMs: 30_000 });
  if (!r.assert(opened, "position open")) return;
  const pos = await findOpenPosition("SOL", PROFILE);
  const fullSize = Number(pos.sizeUsd);
  r.info(`opened size=$${fullSize.toFixed(2)}`);

  // close half
  await placeOrder(jwt, buildClose({ profileIndex: PROFILE, venue: VENUE, positionSide: "long", sizeUsd: fullSize / 2, markPrice: mark, slippageBps: 200, symbol: "SOL" }), "close-half");
  const shrank = await pollUntil(async () => {
    const p = await findOpenPosition("SOL", PROFILE);
    return !!p && Number(p.sizeUsd) < fullSize * 0.75;
  }, { timeoutMs: 45_000 });
  const mid = await findOpenPosition("SOL", PROFILE);
  r.assert(shrank, "position halved", mid ? `size=$${Number(mid.sizeUsd).toFixed(2)}` : "closed early");

  // close remainder (use a generous size; Decrease clamps to remaining)
  const remaining = mid ? Number(mid.sizeUsd) : fullSize;
  const preFree = await profileFreeUsd(jwt, PROFILE);
  await placeOrder(jwt, buildClose({ profileIndex: PROFILE, venue: VENUE, positionSide: "long", sizeUsd: remaining, markPrice: mark, slippageBps: 200, symbol: "SOL" }), "close-rest");
  const closed = await pollUntil(async () => !(await findOpenPosition("SOL", PROFILE)), { timeoutMs: 45_000 });
  r.assert(closed, "position fully closed");

  await pollUntil(async () => (await profileFreeUsd(jwt, PROFILE)) > preFree, { timeoutMs: 30_000 });
  await sweepProfile(PROFILE);
  const { withdrawn } = await withdrawAll(rpc, jwt, PROFILE);
  r.assert(withdrawn > 0, "withdrew to wallet", `$${withdrawn.toFixed(2)}`);
}
