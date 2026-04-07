# Rise SDK - Architecture Guide

Multi-language SDK for the Phoenix perpetuals exchange on Solana. Build with Rust or TypeScript.

## Directory Structure

```
rise-sdk/
├── rust/                   # Rust implementation
│   ├── Cargo.toml         # Workspace manifest
│   ├── sdk/               # Primary SDK client and builders
│   ├── types/             # Serde types and wire formats
│   ├── math/              # Math utilities and margin calculations
│   ├── ix/                # Solana instruction builders
│   ├── cli/               # Smoke-test CLI
│   └── AGENTS.md          # Detailed Rust crate documentation
├── ts/                     # TypeScript implementation
│   ├── package.json
│   ├── src/               # SDK source
│   ├── tests/             # Test suite
│   └── AGENTS.md          # Detailed TypeScript module documentation
├── docs/                   # API documentation
│   ├── phoenix-client.mdx
│   ├── phoenix-ws-client.mdx
│   └── phoenix-tx-builder.mdx
└── README.md              # Getting started guide
```

## Language Implementations

Both Rust and TypeScript provide:
- **HTTP client** - REST API access to markets, traders, candles, and account data
- **WebSocket client** - Real-time subscriptions to orderbooks, market stats, candles, trader state, and trades
- **Transaction builder** - Construct Solana instructions for order placement, deposits, withdrawals
- **Margin math** - Calculate margin requirements and liquidation risk

See [`rust/AGENTS.md`](./rust/AGENTS.md) for Rust crate architecture and [`ts/AGENTS.md`](./ts/AGENTS.md) for TypeScript module structure.
