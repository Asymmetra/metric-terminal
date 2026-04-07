import {
  AccountFetchers,
  fetchGlobalConfiguration,
  fetchMint,
  getMintEncoder,
  type AccountFetcherClientWithAddresses,
  type Mint,
} from "@/index";
import { getAddressDecoder, type Address } from "@solana/kit";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const MOCKS_DIR = resolve(TESTS_DIR, "mocks");

type FixtureFile = {
  account: {
    data: [string, string];
  };
};

const addressFromFill = (fill: number): Address =>
  getAddressDecoder().decode(new Uint8Array(32).fill(fill));

const loadMockBytes = (fileName: string): Uint8Array => {
  const fixture = JSON.parse(
    readFileSync(resolve(MOCKS_DIR, fileName), "utf8")
  ) as FixtureFile;

  return Buffer.from(fixture.account.data[0], "base64");
};

describe("account fetchers", () => {
  it("caches mint fetches and respects skipCache", async () => {
    const mint: Mint = {
      mintAuthorityOption: 1,
      mintAuthority: addressFromFill(1),
      supply: 123n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 1,
      freezeAuthority: addressFromFill(2),
    };
    const mintBytes = getMintEncoder().encode(mint);
    const address = addressFromFill(3);
    const client = {
      fetchAccount: vi.fn(async () => ({ data: mintBytes })),
      _accountCache: new Map<string, unknown>(),
      _cacheEnabled: true,
    };

    const first = await fetchMint({ client, address });
    const second = await fetchMint({ client, address });
    const third = await fetchMint({ client, address, skipCache: true });

    expect(first).toEqual(mint);
    expect(second).toBe(first);
    expect(third).toEqual(mint);
    expect(client.fetchAccount).toHaveBeenCalledTimes(2);
    expect(AccountFetchers.Mint).toBe(fetchMint);
  });

  it("uses the client's default global configuration address", async () => {
    const globalConfigurationAddress = addressFromFill(9);
    const client: AccountFetcherClientWithAddresses = {
      fetchAccount: vi.fn(async () => ({
        data: loadMockBytes("global_config.json"),
      })),
      _accountCache: new Map<string, unknown>(),
      _cacheEnabled: true,
      addresses: {
        globalConfigurationAddress,
      },
    };

    const configuration = await fetchGlobalConfiguration({ client });

    expect(client.fetchAccount).toHaveBeenCalledWith(
      globalConfigurationAddress
    );
    expect(configuration.accountKey).toBeTypeOf("string");
    expect(AccountFetchers.GlobalConfiguration).toBe(fetchGlobalConfiguration);
  });
});
