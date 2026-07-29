"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { MetricParticles } from "./MetricParticles";

const stagger = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.15, delayChildren: 0.3 },
  },
};

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] },
  },
};

export function HeroSection() {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden">
      <MetricParticles />

      {/* Radial vignette: draws eye to center, darkens edges */}
      <div
        className="pointer-events-none absolute inset-0 z-[1]"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 50%, transparent 0%, rgba(2,6,23,0.4) 70%, rgba(2,6,23,0.85) 100%)",
        }}
      />

      <motion.div
        className="relative z-10 flex flex-col items-center gap-6"
        variants={stagger}
        initial="hidden"
        animate="visible"
      >
        {/* Brand label */}
        <motion.div variants={fadeUp} className="flex items-center gap-3">
          <motion.div
            className="h-2 w-2 bg-metric-primary"
            animate={{
              opacity: [0.4, 1, 0.4],
              boxShadow: [
                "0 0 4px rgba(14,165,233,0.3)",
                "0 0 12px rgba(14,165,233,0.6)",
                "0 0 4px rgba(14,165,233,0.3)",
              ],
            }}
            transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
          />
          <span className="font-mono text-[11px] tracking-[0.35em] text-text-secondary/70 uppercase">
            Metric Terminal
          </span>
        </motion.div>

        {/* Headline */}
        <motion.h1
          variants={fadeUp}
          className="text-center font-mono font-bold leading-[0.9] tracking-tight text-text-primary"
        >
          <span className="block text-6xl md:text-8xl lg:text-9xl">METRIC</span>
          <span
            className="block text-6xl md:text-8xl lg:text-9xl text-metric-primary"
            style={{
              textShadow: "0 0 40px rgba(14,165,233,0.35), 0 0 80px rgba(14,165,233,0.12)",
            }}
          >
            TERMINAL
          </span>
        </motion.h1>

        {/* Tagline */}
        <motion.p
          variants={fadeUp}
          className="max-w-sm text-center text-sm leading-relaxed text-text-secondary/80"
        >
          Next-generation perpetuals trading on Solana.
          <br />
          <span className="text-text-secondary/50">Powered by Imperial.</span>
        </motion.p>

        {/* CTA */}
        <motion.div variants={fadeUp} className="mt-4 flex flex-col items-center gap-3">
          <Link
            href="/terminal"
            className="group relative inline-flex items-center border border-metric-primary/60 bg-transparent px-10 py-3.5 font-mono text-xs font-medium tracking-[0.2em] text-metric-primary transition-all duration-300 hover:border-metric-primary hover:bg-metric-primary/10 hover:text-metric-primary"
            style={{
              boxShadow: "0 0 20px rgba(14,165,233,0.10)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow = "0 0 30px rgba(14,165,233,0.25), inset 0 0 20px rgba(14,165,233,0.06)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = "0 0 20px rgba(14,165,233,0.10)";
            }}
          >
            LAUNCH TERMINAL
            <svg
              className="ml-3 h-3 w-3 transition-transform duration-300 group-hover:translate-x-0.5"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M2.5 6h7M6.5 2.5L10 6l-3.5 3.5" />
            </svg>
          </Link>
          <div className="flex items-center gap-5">
            <Link
              href="/degen"
              className="inline-flex items-center font-mono text-[10px] font-medium tracking-[0.2em] text-metric-sell/70 transition-colors hover:text-metric-sell"
            >
              DEGEN MODE · 400× · 60s ↗
            </Link>
            <Link
              href="/touch"
              className="inline-flex items-center font-mono text-[10px] font-medium tracking-[0.2em] text-metric-buy/70 transition-colors hover:text-metric-buy"
            >
              IMPERIAL TOUCH · BARRIER OPTIONS ↗
            </Link>
          </div>
        </motion.div>

        {/* Subtle version tag */}
        <motion.span
          variants={fadeUp}
          className="mt-8 font-mono text-[10px] tracking-widest text-text-secondary/30 uppercase"
        >
          v0.1 &middot; mainnet
        </motion.span>
      </motion.div>
    </div>
  );
}
