/**
 * Resting-limit lifecycle via the order bot (no wallet signature, no SOLANA_RPC):
 * place a long limit well below market so it rests, confirm the orderPda, cancel.
 * Requires the profile to already hold the collateral (funded-at-creation).
 */
export const meta = {
  id: "limit-cancel",
  kind: "orderbot",
  cost: "order-bot txs (operator-paid); no wallet signature",
  summary: "place a resting limit off-market → cancel",
};

export default async function run(ctx) {
  const { r, http, ensureJwt, profileFreeUsd, solMark, buildOrder, WALLET, PROFILE } = ctx;
  const COL = 10;
  const SIZE = 20;

  const jwt = await ensureJwt();
  const free = await profileFreeUsd(jwt, PROFILE);
  if (free < COL) {
    r.warn(`profile ${PROFILE} free $${free.toFixed(2)} < $${COL} collateral — fund it first; skipping`);
    return;
  }

  const mark = await solMark();
  const body = buildOrder({
    profileIndex: PROFILE,
    venue: "phoenix",
    side: "long",
    type: "limit",
    sizeUsd: SIZE,
    collateralUsd: COL,
    markPrice: mark,
    limitPriceUsd: mark * 0.5, // 50% below — will rest, not fill
    slippageBps: 100,
    symbol: "SOL",
  });
  const place = await http("POST", "/mobile/orders", { body, jwt });
  if (place.status !== 200 || !place.body?.success) throw new Error(`place: ${place.body?.error ?? JSON.stringify(place.body)}`);
  const orderPda = place.body.orderPda;
  if (!r.assert(!!orderPda, "limit placed (rests)", `orderPda ${orderPda?.slice(0, 10)}…`)) return;

  const cancel = await http("POST", "/mobile/orders/cancel", { body: { wallet: WALLET, profileIndex: PROFILE, orderPda }, jwt });
  r.assert(cancel.status === 200 && cancel.body?.success, "limit cancelled", cancel.body?.signature?.slice(0, 12));
}
