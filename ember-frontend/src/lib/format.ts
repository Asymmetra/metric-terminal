export function formatPrice(price: number, decimals = 2): string {
  if (price == null || isNaN(price)) return "0.00";
  return price.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatSize(size: number, decimals = 4): string {
  if (size == null || isNaN(size)) return "0.0000";
  return size.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatUsd(amount: number): string {
  return `$${formatPrice(amount)}`;
}

export function formatPercent(pct: number): string {
  if (pct == null || isNaN(pct)) return "0.0000%";
  return `${(pct * 100).toFixed(4)}%`;
}

export function abbreviateNumber(num: number): string {
  if (num == null || isNaN(num)) return "0.00";
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
  return num.toFixed(2);
}
