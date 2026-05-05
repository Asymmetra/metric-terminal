// Diagnostic dump for a single wallet's trader state.
// Surfaces the exact Phoenix data behind every position — useful when the UI
// shows something surprising (size 0.00, weird PnL, "should be liquidated").
//
// Usage:
//   node tests/inspect-trader.mjs <pubkey>
//   BACKEND_URL=https://ember-backend-q4nf.onrender.com node tests/inspect-trader.mjs GKYP...CvYm

const BACKEND = process.env.BACKEND_URL ?? "https://ember-backend-q4nf.onrender.com";
const pubkey = process.argv[2];

if (!pubkey) {
  console.error("Usage: node inspect-trader.mjs <pubkey>");
  process.exit(1);
}

function num(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v) || 0;
  if (typeof v === "object" && v.ui != null) return parseFloat(v.ui) || 0;
  return 0;
}
const fmt = (v) => `$${num(v).toFixed(4)}`;
const fmtPct = (v) => `${(v * 100).toFixed(2)}%`;

const r = await fetch(`${BACKEND}/api/trader/${pubkey}`);
if (!r.ok) {
  console.error(`HTTP ${r.status}: ${await r.text()}`);
  process.exit(1);
}
const data = await r.json();
const accounts = data.accounts ?? [];

console.log(`\nWallet: ${pubkey}`);
console.log(`Subaccounts: ${accounts.length}`);

for (const a of accounts) {
  const idx = a.traderSubaccountIndex;
  const label = idx === 0 ? "CROSS" : `ISOLATED #${idx}`;
  const positions = a.positions ?? [];
  const limitOrders = a.limitOrders ?? {};
  const totalOrders = Object.values(limitOrders).reduce((s, o) => s + o.length, 0);

  if (positions.length === 0 && totalOrders === 0 && num(a.collateralBalance) === 0) continue;

  console.log("\n" + "─".repeat(72));
  console.log(`▼ Subaccount ${idx} — ${label}    state=${a.state}  flags=${a.flags}`);
  console.log("─".repeat(72));
  console.log(`  collateralBalance:                  ${fmt(a.collateralBalance)}  (raw deposit)`);
  console.log(`  effectiveCollateral:                ${fmt(a.effectiveCollateral)}  (post-PnL, current)`);
  console.log(`  effectiveCollateralForWithdrawals:  ${fmt(a.effectiveCollateralForWithdrawals)}`);
  console.log(`  unrealizedPnl:                      ${fmt(a.unrealizedPnl)}`);
  console.log(`  initialMargin:                      ${fmt(a.initialMargin)}`);
  console.log(`  maintenanceMargin:                  ${fmt(a.maintenanceMargin)}`);
  console.log(`  portfolioValue:                     ${fmt(a.portfolioValue)}`);
  console.log(`  riskState/riskTier:                 ${a.riskState} / ${a.riskTier}`);

  if (positions.length > 0) {
    console.log("\n  Open positions:");
    for (const p of positions) {
      const size = num(p.positionSize);
      const sizeAbs = Math.abs(size);
      const entry = num(p.entryPrice);
      const liq = num(p.liquidationPrice);
      const pnl = num(p.unrealizedPnl);
      const posValue = num(p.positionValue);
      const initMargin = num(p.initialMargin) || num(p.positionInitialMargin);
      const maintMargin = num(p.maintenanceMargin);

      // Re-derive the implied mark price from PnL math so we can sanity-check:
      // for a short, pnl = (entry - mark) * size  →  mark = entry - pnl/size
      // for a long,  pnl = (mark - entry) * size  →  mark = entry + pnl/size
      const isShort = size < 0;
      const impliedMark = sizeAbs > 0
        ? (isShort ? entry - pnl / sizeAbs : entry + pnl / sizeAbs)
        : null;

      // Effective margin remaining on this isolated subaccount, then how far
      // mark needs to drift for that to fall to maintMargin (roughly: liq).
      const effCollateral = num(a.effectiveCollateral);
      const distToLiq = liq > 0 && impliedMark != null
        ? Math.abs((liq - impliedMark) / impliedMark)
        : null;

      const roiVsBalance = num(a.collateralBalance) > 0
        ? pnl / num(a.collateralBalance)
        : 0;

      console.log(`    ${p.symbol}  ${isShort ? "SHORT" : "LONG"}  size=${sizeAbs.toFixed(6)}  notional=${fmt(posValue)}`);
      console.log(`      entry=${fmt(entry)}  impliedMark=${impliedMark != null ? fmt(impliedMark) : "?"}  liq=${fmt(liq)}`);
      console.log(`      unrealizedPnl=${fmt(pnl)}  ROI(vs balance)=${fmtPct(roiVsBalance)}  distToLiq=${distToLiq != null ? fmtPct(distToLiq) : "?"}`);
      console.log(`      initialMargin=${fmt(initMargin)}  maintenanceMargin=${fmt(maintMargin)}`);
      // Diagnose: is this position "should be liquidated but isn't"?
      if (effCollateral < num(p.maintenanceMargin) || num(p.maintenanceMargin) === 0) {
        // effective_collateral below maintenance → keeper should liquidate.
      }
      if (effCollateral > 0 && pnl < -num(a.collateralBalance) * 0.5) {
        console.log(`      ⚠  position is deeply underwater (pnl > 50% of collateralBalance)`);
      }
      if (sizeAbs > 0 && sizeAbs < 0.01) {
        console.log(`      ℹ  size rounds to 0.00 at 2dp — UI used to display "0.00" before the per-market precision fix`);
      }
    }
  }

  if (totalOrders > 0) {
    console.log(`\n  Open limit orders: ${totalOrders}`);
    for (const [symbol, orders] of Object.entries(limitOrders)) {
      for (const o of orders) {
        console.log(`    ${symbol}  ${o.side}  size=${num(o.size).toFixed(6)}  price=${fmt(o.price ?? o.limitPrice)}`);
      }
    }
  }
}
console.log();
