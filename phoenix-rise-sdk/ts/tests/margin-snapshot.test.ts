import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSubaccountMarginInputsFromSnapshot,
  createMarginCalculator,
  type MarginSnapshotFile,
  type MarginTraderSnapshotMessage,
} from "@/index";

const defaultSnapshotPath = fileURLToPath(
  new URL("./fixtures/margin-snapshots", import.meta.url)
);
const snapshotPath = process.env.MARGIN_SNAPSHOT_PATH ?? defaultSnapshotPath;

if (!existsSync(snapshotPath)) {
  throw new Error(
    `Margin snapshot not found at ${snapshotPath}. Set MARGIN_SNAPSHOT_PATH to override.`
  );
}

type SnapshotEntry = {
  name: string;
  path: string;
  snapshot: MarginSnapshotFile;
};

const snapshotEntries = loadSnapshotEntries(snapshotPath);

describe("margin snapshot parity", () => {
  for (const entry of snapshotEntries) {
    it(`matches rust margin outputs (${entry.name})`, () => {
      const calculator = createMarginCalculator(entry.snapshot.markets);
      for (const trader of entry.snapshot.traders) {
        const message = trader.message as MarginTraderSnapshotMessage;
        if (message.messageType !== "snapshot") {
          continue;
        }

        for (const expectedSub of trader.expected.subaccounts) {
          const subaccount = message.subaccounts?.find(
            (sub) => sub.subaccountIndex === expectedSub.traderSubaccountIndex
          );

          expect(
            subaccount,
            `missing subaccount ${expectedSub.traderSubaccountIndex} for ${trader.authority}`
          ).toBeTruthy();

          if (!subaccount) {
            continue;
          }

          const inputs = buildSubaccountMarginInputsFromSnapshot(subaccount);
          const result = calculator.computeSubaccountMargin(inputs);
          const inputsResult =
            calculator.computeSubaccountMarginFromInputs(inputs);

          expect(result.margin).toEqual(expectedSub.margin);
          expect(result.marketMargins).toEqual(expectedSub.marketMargins);
          expect(result.limitOrders).toEqual(expectedSub.limitOrders);

          expect(inputsResult.margin).toEqual(expectedSub.margin);
          expect(inputsResult.marketMargins).toEqual(expectedSub.marketMargins);
          expect(inputsResult.limitOrders).toEqual(expectedSub.limitOrders);
        }
      }
      console.log(
        `Completed verifying ${entry.snapshot.traders.length} traders for ${entry.name}`
      );
    });
  }
});

function loadSnapshotEntries(path: string): SnapshotEntry[] {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    const files = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => ({
        name: entry.name,
        path: join(path, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (files.length === 0) {
      throw new Error(`No .json snapshots found in directory ${path}`);
    }

    return files.map((file) => ({
      name: file.name,
      path: file.path,
      snapshot: readSnapshot(file.path),
    }));
  }

  return [
    {
      name: path,
      path,
      snapshot: readSnapshot(path),
    },
  ];
}

function readSnapshot(path: string): MarginSnapshotFile {
  return JSON.parse(
    readFileSync(path, { encoding: "utf-8" })
  ) as MarginSnapshotFile;
}
