# Third-Party Notices

This project (`metric-terminal`) is licensed under the [MIT License](./LICENSE).
It depends on open-source packages under their own licenses. The full dependency
trees (frontend `package-lock.json`, backend `Cargo.lock`) were audited and are
all under permissive licenses (MIT / ISC / BSD / Apache-2.0), with a few
transitive LGPL/MPL packages that are dynamically linked or build-time only and
impose no copyleft on this project's source.

Below are the notable dependencies whose licenses require attribution when
redistributed. This list is a courtesy summary, not a substitute for each
package's own license text (installed under `node_modules/<pkg>/LICENSE` and the
respective crate sources).

## Apache-2.0 (attribution required)

| Package | Where |
|---|---|
| `lightweight-charts` (TradingView) | frontend charting |
| `@solana/wallet-adapter-base` / `-react` / `-react-ui` / `-phantom` | frontend wallet |
| `typescript` | frontend build tooling |
| `solana-pubkey` | backend (Rust) |

Each is distributed under the Apache License 2.0. See
<https://www.apache.org/licenses/LICENSE-2.0> and the `NOTICE`/`LICENSE` files
shipped inside each package.

## Transitive copyleft (no obligation on this project)

The following appear only as transitive, dynamically-linked, or build/dev-only
dependencies and do **not** cause this project's code to become copyleft:

- **LGPL-3.0** — `sharp` / libvips native binaries (Next.js optional image
  optimization; prebuilt, dynamically linked), `rpc-websockets` (pulled by
  `@solana/web3.js`, unmodified, dynamically required).
- **MPL-2.0** — `lightningcss`, `axe-core` (build/lint tooling; never shipped in
  the runtime bundle).

## Notes

- No GPL, AGPL, SSPL, CC-BY-NC, proprietary, or unlicensed packages are present
  in either dependency tree.
- `liveline` (the live-scrolling chart library) is MIT-licensed.
- If you fork or redistribute a built bundle, include this file and the LICENSE.
