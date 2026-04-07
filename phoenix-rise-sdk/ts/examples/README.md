# Phoenix SDK Examples

This directory contains example scripts demonstrating the Phoenix SDK functionality.

## Examples

### phoenix-client-example.ts

Demonstrates all basic `PhoenixHttpClient` operations from the documentation:

- Creating a client
- Fetching exchange metadata
- Listing markets
- Getting market data
- Fetching trader state
- Getting order history
- Getting trade history
- Getting collateral history
- Getting funding history
- Getting candle data
- Getting market fills
- Getting trader PnL

**Run with:**
```bash
# Without a trader pubkey (trader queries will show 404 errors)
bun examples/phoenix-client-example.ts

# With a specific trader pubkey (to test trader-specific queries)
bun examples/phoenix-client-example.ts YOUR_SOLANA_PUBKEY
```

**Arguments:**
- `pubkey` (optional) - Solana public key to use for trader-specific queries. If not provided, a dummy pubkey is used and trader queries will return 404 errors (expected behavior).

This example connects to the actual Phoenix API and demonstrates error handling for missing data.

## Running Tests

Unit tests for the client interface are in `tests/phoenix-client-interface.test.ts`:

```bash
bun run test phoenix-client-interface
```

These tests verify:
- Client initialization with various configurations
- Presence of all expected API methods
- Client dispose/cleanup
- Multiple client instances
