export const COLORS = {
  emberBlack: "#0C0C0E",
  surfaceL1: "#16171B",
  surfaceL2: "#1E1F25",
  emberBorder: "#2A2B33",
  emberOrange: "#FF5500",
  emberGreen: "#2EE29B",
  emberRed: "#F23B4E",
  textPrimary: "#FFFFFF",
  textSecondary: "#9CA3AF",
} as const;

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001/ws";
