import type { NextConfig } from "next";

// Soft-warn (don't fail) when a NEXT_PUBLIC_* URL points at localhost
// during a production build — leftover dev URLs are usually a config slip,
// but failing the build on it bricks deployments that have other valid
// runtime overrides (e.g. the metric-backend env vars are optional now).
if (process.env.NODE_ENV === "production") {
  const URL_PATTERN = /^(https?|wss?):\/\//;
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("NEXT_PUBLIC_") &&
      value &&
      URL_PATTERN.test(value) &&
      (value.includes("localhost") || value.includes("127.0.0.1"))
    ) {
      // eslint-disable-next-line no-console
      console.warn(`[metric] WARN: ${key}="${value}" points at localhost.`);
    }
  }
}

const nextConfig: NextConfig = {
  // Next 16 no longer runs ESLint during `next build`, so there's nothing
  // to configure here — lint findings are tracked separately and run via
  // `npm run lint` locally / in CI.
};

export default nextConfig;
