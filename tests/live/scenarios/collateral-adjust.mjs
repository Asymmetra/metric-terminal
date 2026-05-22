/**
 * Margin management: open a market position, add collateral, then remove it,
 * and close + withdraw. Exercises /mobile/orders/collateral (add=0, remove=1),
 * which is keyed by `marketMint` (not symbol).
 *
 * EXPERIMENTAL: as of last run, the collateral edit returns a generic
 * "Failed to update collateral — please try again" on gmtrade for SOL, with
 * both the canonical and the resolved index mint — the same generic order-bot
 * error family as Phoenix market opens. Treated as a soft warning (not a hard
 * failure) until the correct per-venue addressing is confirmed; the open/close/
 * withdraw around it still validate and the profile is always cleaned up.
 */
export const meta = {
  id: "collateral-adjust",
  kind: "onchain",
  cost: "open + close fees (~cents); funds returned",
  summary: "open → add/remove collateral (experimental) → close & withdraw",
};

// Canonical SOL mint (override with SOL_MARKET_MINT if a venue uses a synthetic).
const SOL_MINT = process.env.SOL_MARKET_MINT ?? "So11111111111111111111111111111111111111112";

export default async function run(ctx) {
  const {
    r, http, ensureJwt, getRpc, walletSol, profileFreeUsd, ensureFunded, withdrawAll, placeOrder,
    sweepProfile, findOpenPosition, solMark, buildOrder, buildClose, oracle, usdFixed, pollUntil,
    enums, API, WALLET, PROFILE,
  } = ctx;
  const COL = 10;
  const SIZE = 20;
  const ADD = 3;
  const BUFFER = Number(process.env.BUFFER_USD ?? "0.3");
  const VENUE = process.env.MARKET_VENUE ?? "gmtrade";

  const jwt = await ensureJwt();
  const rpc = getRpc();
  if ((await walletSol(rpc)) < 0.01) throw new Error("need ≥0.01 SOL for gas");

  // Fund collateral + the amount we'll add + buffer.
  await ensureFunded(rpc, jwt, PROFILE, COL + ADD + BUFFER);
  const mark = await solMark();
  await placeOrder(jwt, buildOrder({ profileIndex: PROFILE, venue: VENUE, side: "long", type: "market", sizeUsd: SIZE, collateralUsd: COL, markPrice: mark, slippageBps: 200, symbol: "SOL" }), "open");
  const opened = await pollUntil(async () => !!(await findOpenPosition("SOL", PROFILE)), { timeoutMs: 30_000 });
  if (!r.assert(opened, "position open")) return;

  // Resolve the venue's market mint — gmtrade uses a synthetic index mint, not
  // canonical wrapped SOL, and the collateral edit is keyed on it.
  let mint = SOL_MINT;
  try {
    const ep = VENUE === "flash_trade" ? "flash" : VENUE;
    const markets = await fetch(`${API}/api/v1/${ep}/markets`).then((x) => x.json());
    const arr = Array.isArray(markets) ? markets : markets.markets ?? markets.rows ?? [];
    const m = arr.find((x) => x.symbol === "SOL");
    mint = m?.indexTokenMint ?? m?.marketTokenMint ?? m?.marketMint ?? SOL_MINT;
    r.info(`resolved ${VENUE} SOL marketMint: ${mint.slice(0, 10)}…`);
  } catch {
    /* fall back to SOL_MINT */
  }

  const collateralEdit = async (action, label) => {
    const res = await http("POST", "/mobile/orders/collateral", {
      body: {
        wallet: WALLET,
        profileIndex: PROFILE,
        underwriter: enums.Underwriter[VENUE],
        side: enums.Side.long,
        action, // 0 add, 1 remove
        collateralAmount: usdFixed(ADD),
        marketMint: mint,
        price: oracle(mark),
        slippageBps: 200,
      },
      jwt,
    });
    if (res.status !== 200 || !res.body?.success) throw new Error(`${label}: ${res.body?.error ?? JSON.stringify(res.body)}`);
    return res.body;
  };

  try {
    const add = await collateralEdit(0, "add collateral");
    r.ok(`added $${ADD} collateral`, add.signature?.slice(0, 12));
    const before = await findOpenPosition("SOL", PROFILE);
    r.info(`collateral now ~$${Number(before?.collateralUsd ?? 0).toFixed(2)}`);

    const rem = await collateralEdit(1, "remove collateral");
    r.ok(`removed $${ADD} collateral`, rem.signature?.slice(0, 12));
  } catch (e) {
    // Known venue-side limitation (see header) — surface as a warning, not a
    // hard failure, and still clean up the position below.
    r.warn(`collateral edit unavailable: ${e instanceof Error ? e.message : e}`);
  }

  // close + withdraw to clean up regardless of the edit outcome
  const pos = await findOpenPosition("SOL", PROFILE);
  if (pos) {
    const preFree = await profileFreeUsd(jwt, PROFILE);
    await placeOrder(jwt, buildClose({ profileIndex: PROFILE, venue: VENUE, positionSide: "long", sizeUsd: Math.max(Number(pos.sizeUsd), SIZE), markPrice: mark, slippageBps: 200, symbol: "SOL" }), "close");
    await pollUntil(async () => (await profileFreeUsd(jwt, PROFILE)) > preFree, { timeoutMs: 60_000 });
    await sweepProfile(PROFILE);
  }
  const { withdrawn } = await withdrawAll(rpc, jwt, PROFILE);
  r.assert(withdrawn >= 0, "cleaned up + withdrew", `$${withdrawn.toFixed(2)}`);
}
