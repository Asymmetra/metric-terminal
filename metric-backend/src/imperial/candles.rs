//! Client-side OHLCV aggregation from Imperial mark-price ticks.
//!
//! Imperial has no candles endpoint; we synthesize one by bucketing the
//! mark-price stream into 1m/5m/15m/1h bars. Bars live in memory only —
//! cold start = empty. Acceptable for the PoC; production will persist.
//!
//! Bars are keyed by (venue, symbol). Each venue gets its own series;
//! the chart picks whichever venue the user selected.

use dashmap::DashMap;
use serde::Serialize;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Timeframe {
    M1,
    M5,
    M15,
    H1,
}

impl Timeframe {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "1m" | "M1" | "m1" => Some(Self::M1),
            "5m" | "M5" | "m5" => Some(Self::M5),
            "15m" | "M15" | "m15" => Some(Self::M15),
            "1h" | "H1" | "h1" => Some(Self::H1),
            _ => None,
        }
    }

    pub fn seconds(self) -> i64 {
        match self {
            Self::M1 => 60,
            Self::M5 => 300,
            Self::M15 => 900,
            Self::H1 => 3600,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Candle {
    /// Bar open time in unix seconds.
    pub time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    /// Mark-price aggregations have no real "volume"; we count ticks.
    pub volume: u32,
}

/// Per-venue, per-symbol, per-timeframe OHLCV series.
/// Map key is "{venue}|{symbol}|{tf}"; value is the recent-bars vec.
#[derive(Default)]
pub struct CandleAggregator {
    series: DashMap<String, Vec<Candle>>,
}

impl CandleAggregator {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Bucket key. We track all four timeframes off the same mark stream.
    fn key(venue: &str, symbol: &str, tf: Timeframe) -> String {
        format!(
            "{}|{}|{}",
            venue,
            symbol,
            match tf {
                Timeframe::M1 => "1m",
                Timeframe::M5 => "5m",
                Timeframe::M15 => "15m",
                Timeframe::H1 => "1h",
            }
        )
    }

    /// Feed in a price tick. Updates all four timeframe series for
    /// (venue, symbol). `at_unix_ms` is the upstream-reported timestamp.
    pub fn record(&self, venue: &str, symbol: &str, price: f64, at_unix_ms: i64) {
        for tf in [Timeframe::M1, Timeframe::M5, Timeframe::M15, Timeframe::H1] {
            let bucket_secs = (at_unix_ms / 1000 / tf.seconds()) * tf.seconds();
            let k = Self::key(venue, symbol, tf);
            let mut entry = self.series.entry(k).or_default();
            let series = entry.value_mut();
            match series.last_mut() {
                Some(last) if last.time == bucket_secs => {
                    last.close = price;
                    if price > last.high {
                        last.high = price;
                    }
                    if price < last.low {
                        last.low = price;
                    }
                    last.volume = last.volume.saturating_add(1);
                }
                _ => {
                    series.push(Candle {
                        time: bucket_secs,
                        open: price,
                        high: price,
                        low: price,
                        close: price,
                        volume: 1,
                    });
                    // Cap retained history at a reasonable size per series.
                    // 1m * 1000 bars ≈ 16h of history; 1h * 1000 ≈ 41 days.
                    if series.len() > 1000 {
                        let excess = series.len() - 1000;
                        series.drain(0..excess);
                    }
                }
            }
        }
    }

    /// Read the last `limit` bars for (venue, symbol, tf), oldest → newest.
    pub fn get(&self, venue: &str, symbol: &str, tf: Timeframe, limit: usize) -> Vec<Candle> {
        let k = Self::key(venue, symbol, tf);
        match self.series.get(&k) {
            Some(s) => {
                let len = s.len();
                let start = len.saturating_sub(limit);
                s[start..].to_vec()
            }
            None => Vec::new(),
        }
    }

    pub fn series_count(&self) -> usize {
        self.series.len()
    }
}

#[allow(dead_code)]
pub fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregates_within_a_bucket() {
        let agg = CandleAggregator::new();
        // Three ticks inside the same minute. The bucket boundary for
        // /60 truncation is at 1_700_000_040s — anchor all three after
        // that and stay below the next boundary at 1_700_000_100s.
        agg.record("phoenix", "SOL", 100.0, 1_700_000_041_000);
        agg.record("phoenix", "SOL", 105.0, 1_700_000_060_000);
        agg.record("phoenix", "SOL", 95.0, 1_700_000_099_000);
        let bars = agg.get("phoenix", "SOL", Timeframe::M1, 10);
        assert_eq!(bars.len(), 1);
        let b = &bars[0];
        assert_eq!(b.open, 100.0);
        assert_eq!(b.close, 95.0);
        assert_eq!(b.high, 105.0);
        assert_eq!(b.low, 95.0);
        assert_eq!(b.volume, 3);
    }

    #[test]
    fn rolls_into_next_bucket() {
        let agg = CandleAggregator::new();
        agg.record("phoenix", "SOL", 100.0, 1_700_000_000_000);
        // Next minute.
        agg.record("phoenix", "SOL", 110.0, 1_700_000_060_000);
        let bars = agg.get("phoenix", "SOL", Timeframe::M1, 10);
        assert_eq!(bars.len(), 2);
        assert_eq!(bars[0].close, 100.0);
        assert_eq!(bars[1].open, 110.0);
        assert_eq!(bars[1].close, 110.0);
    }
}
