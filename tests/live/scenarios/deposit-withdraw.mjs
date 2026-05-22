/** Pure money round-trip: deposit $AMT then withdraw $AMT back. No trade. */
export const meta = {
  id: "deposit-withdraw",
  kind: "onchain",
  cost: "2 base tx fees (~$0.00x); funds returned",
  summary: "deposit a small amount then withdraw it back, asserting net ≈ 0",
};

export default async function run(ctx) {
  const { r, ensureJwt, getRpc, walletSol, walletUsdc, profileFreeUsd, buildSignSubmit, pollUntil, PROFILE } = ctx;
  const AMT = Number(process.env.AMOUNT_USD ?? "0.5");

  const jwt = await ensureJwt();
  const rpc = getRpc();
  const sol = await walletSol(rpc);
  const usdc = await walletUsdc(rpc);
  r.info(`wallet: ${sol.toFixed(4)} SOL · $${usdc.toFixed(4)} USDC`);
  if (sol < 0.01) throw new Error(`need ≥0.01 SOL for gas (have ${sol.toFixed(4)})`);
  if (usdc < AMT) throw new Error(`need ≥$${AMT} wallet USDC (have $${usdc.toFixed(4)})`);

  const before = await profileFreeUsd(jwt, PROFILE);
  r.info(`profile ${PROFILE} free before: $${before.toFixed(4)}`);

  const depSig = await buildSignSubmit(rpc, { profileIndex: PROFILE, amountUsd: AMT, mode: "deposit" });
  const landed = await pollUntil(async () => (await profileFreeUsd(jwt, PROFILE)) >= before + AMT - 1e-6);
  r.assert(landed, "deposit landed", `+$${AMT}  ${depSig.slice(0, 12)}…`);

  const wSig = await buildSignSubmit(rpc, { profileIndex: PROFILE, amountUsd: AMT, mode: "withdraw" });
  const returned = await pollUntil(async () => (await profileFreeUsd(jwt, PROFILE)) <= before + 1e-6);
  r.assert(returned, "withdraw returned", `-$${AMT}  ${wSig.slice(0, 12)}…`);

  const after = await profileFreeUsd(jwt, PROFILE);
  r.assert(Math.abs(after - before) < 0.01, "net balance ≈ 0", `before $${before.toFixed(4)} → after $${after.toFixed(4)}`);
}
