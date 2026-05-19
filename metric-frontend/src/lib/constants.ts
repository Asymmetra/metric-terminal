export const COLORS = {
  emberBlack: "#020617",
  surfaceL1: "#0F172A",
  surfaceL2: "#1E293B",
  emberBorder: "#334155",
  emberOrange: "#0EA5E9",
  emberGreen: "#22D3EE",
  emberRed: "#F97316",
  textPrimary: "#FFFFFF",
  textSecondary: "#9CA3AF",
} as const;

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001/ws";
