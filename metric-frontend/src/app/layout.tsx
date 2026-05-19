import type { Metadata, Viewport } from "next";
import "./globals.css";
import { WalletProviderWrapper } from "@/providers/WalletProvider";
import { OnboardingGate } from "@/components/onboarding/OnboardingGate";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  title: "Metric Terminal — Perpetuals Trading on Solana",
  description: "Next-generation perpetuals trading terminal powered by Imperial on Solana. Multi-venue routing across Phoenix, Jupiter, Flash Trade, and GMTrade with isolated-margin profiles.",
  applicationName: "Metric Terminal",
  openGraph: {
    title: "Metric Terminal",
    description: "Next-generation perpetuals trading on Solana",
    siteName: "Metric Terminal",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Metric Terminal",
    description: "Next-generation perpetuals trading on Solana",
  },
  other: {
    "theme-color": "#020617",
    "color-scheme": "dark",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-metric-bg text-text-primary antialiased">
        <WalletProviderWrapper>
          <OnboardingGate />
          {children}
        </WalletProviderWrapper>
      </body>
    </html>
  );
}
