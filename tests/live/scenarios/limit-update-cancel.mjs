/**
 * Resting-limit edit lifecycle via the order bot: place a long limit, update its
 * trigger price + size (/mobile/orders/update), then cancel. No wallet signature.
 */
export const meta = {
  id: "limit-update-cancel",
  kind: "orderbot",
  cost: "order-bot txs (operator-paid); no wallet signature",
  summary: "place a resting limit → update trigger/size → cancel",
};

export default async function run(ctx) {
  const { r, http, ensureJwt, profileFreeUsd, solMark, buildOrder, oracle, usdFixed, WALLET, PROFILE } = ctx;
  const COL = 10;
  const SIZE = 20;

  const jwt = await ensureJwt();
  const free = await profileFreeUsd(jwt, PROFILE);
  if (free < COL) {
    r.warn(`profile ${PROFILE} free $${free.toFixed(2)} < $${COL} collateral — fund it first; skipping`);
    return;
  }

  const mark = await solMark();
  const place = await http("POST", "/mobile/orders", {
    body: buildOrder({
      profileIndex: PROFILE,
      venue: "phoenix",
      side: "long",
      type: "limit",
      sizeUsd: SIZE,
      collateralUsd: COL,
      markPrice: mark,
      limitPriceUsd: mark * 0.5,
      slippageBps: 100,
      symbol: "SOL",
    }),
    jwt,
  });
  if (place.status !== 200 || !place.body?.success) throw new Error(`place: ${place.body?.error ?? JSON.stringify(place.body)}`);
  const orderPda = place.body.orderPda;
  if (!r.assert(!!orderPda, "limit placed", `orderPda ${orderPda?.slice(0, 10)}…`)) return;

  const update = await http("POST", "/mobile/orders/update", {
    body: { wallet: WALLET, profileIndex: PROFILE, orderPda, triggerPrice: oracle(mark * 0.45), sizeUsd: usdFixed(25) },
    jwt,
  });
  r.assert(update.status === 200 && update.body?.success, "limit updated (trigger↓, size→$25)", update.body?.signature?.slice(0, 12));

  const cancel = await http("POST", "/mobile/orders/cancel", { body: { wallet: WALLET, profileIndex: PROFILE, orderPda }, jwt });
  r.assert(cancel.status === 200 && cancel.body?.success, "limit cancelled", cancel.body?.signature?.slice(0, 12));
}
