import type { NextConfig } from "next";

// Build-time validation: reject localhost in any NEXT_PUBLIC_* URL during production builds
if (process.env.NODE_ENV === "production") {
  const violations: string[] = [];

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("NEXT_PUBLIC_") && value) {
      if (value.includes("localhost") || value.includes("127.0.0.1")) {
        violations.push(`  ${key}="${value}"`);
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Production build blocked — localhost detected in public env vars:\n${violations.join("\n")}\n` +
      `Fix in Vercel Dashboard → Settings → Environment Variables.`
    );
  }
}

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
