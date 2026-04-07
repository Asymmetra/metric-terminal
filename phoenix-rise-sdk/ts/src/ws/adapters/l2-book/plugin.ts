import type { Subscription } from "@/ws/types";
import type { MessageHandlerPlugin } from "@/ws/plugins/types";
import { getStringField } from "../_utils/messageUtils";

export const createL2BookPlugin = (): MessageHandlerPlugin => ({
  channel: "l2Book",
  validate: (message: unknown): boolean => {
    return getStringField(message, "coin") !== null;
  },
  getKey: (message: unknown): string => {
    const coin = getStringField(message, "coin");
    if (!coin) {
      throw new Error("Invalid L2Book message: missing coin");
    }
    return `l2Book:${coin}`;
  },
  handle: async (
    message: unknown,
    registry: Map<string, Subscription>
  ): Promise<void> => {
    const coin = getStringField(message, "coin");
    if (!coin) {
      throw new Error("Invalid L2Book message: missing coin");
    }

    registry.get(`l2Book:${coin}`)?.onMsg(message);
  },
});
