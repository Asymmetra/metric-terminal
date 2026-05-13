"use client";

/**
 * Inline SVG sparkline. Used in the detail tray to show the raw
 * inter-arrival samples that feed the p50/p95/p99 aggregates, so the
 * user can directly see what's behind those numbers.
 */
interface Props {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  /** Draw a horizontal reference line at this y-value (e.g. p50). */
  reference?: number;
  referenceLabel?: string;
}

export function Sparkline({
  values,
  width = 480,
  height = 60,
  stroke = "#f97316", // ember-orange
  fill = "rgba(249, 115, 22, 0.12)",
  reference,
  referenceLabel,
}: Props) {
  if (values.length === 0) {
    return (
      <div
        className="flex items-center justify-center border border-dashed border-ember-border/40 font-mono text-[10px] text-text-secondary/40"
        style={{ width, height }}
      >
        no samples yet
      </div>
    );
  }
  const max = Math.max(...values, reference ?? 0, 1);
  const min = 0;
  const range = max - min || 1;
  const xStep = values.length > 1 ? width / (values.length - 1) : width;
  const points = values
    .map((v, i) => {
      const x = i * xStep;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const refY = reference != null ? height - ((reference - min) / range) * (height - 4) - 2 : null;

  return (
    <div className="relative">
      <svg width={width} height={height} className="block">
        {/* Area fill */}
        <polyline
          points={`0,${height} ${points} ${width},${height}`}
          fill={fill}
          stroke="none"
        />
        {/* Line */}
        <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.5" />
        {/* Reference line */}
        {refY != null && (
          <>
            <line x1="0" x2={width} y1={refY} y2={refY} stroke="#888" strokeDasharray="3 3" strokeWidth="0.5" />
            {referenceLabel && (
              <text x={width - 4} y={refY - 2} textAnchor="end" fontSize="9" fill="#888" fontFamily="monospace">
                {referenceLabel}
              </text>
            )}
          </>
        )}
      </svg>
      <div className="mt-1 flex items-center justify-between font-mono text-[9px] text-text-secondary/50">
        <span>oldest</span>
        <span>min {Math.min(...values).toFixed(0)}ms · max {Math.max(...values).toFixed(0)}ms · n={values.length}</span>
        <span>newest</span>
      </div>
    </div>
  );
}
