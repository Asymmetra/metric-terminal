/** Imperial REST + WS base URLs. */
export const IMPERIAL_API_URL =
  process.env.NEXT_PUBLIC_IMPERIAL_API_URL ?? "https://api.imperial.space";

export const IMPERIAL_WS_URL =
  process.env.NEXT_PUBLIC_IMPERIAL_WS_URL ?? "wss://api.imperial.space";

/** Path prefix for the versioned API surface. */
export const API_V1 = "/api/v1";
