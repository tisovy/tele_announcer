const buildIntervalConfig = (key, sampleIntervalMs) => ({
  key,
  sampleIntervalMs,
  windowMs: sampleIntervalMs * 60,
  maxSamples: 60,
});

const DEFAULT_INTERVALS = [
  buildIntervalConfig("1s", 1 * 1000),
  buildIntervalConfig("1m", 60 * 1000),
  buildIntervalConfig("5m", 5 * 60 * 1000),
  buildIntervalConfig("15m", 15 * 60 * 1000),
];

const DEFAULT_ALLOWED_QUOTES = ["USDT"];

class ActivityTracker {
  constructor(options = {}) {
    this.intervals = options.intervals || DEFAULT_INTERVALS;
    this.allowedQuotes = options.allowedQuotes || DEFAULT_ALLOWED_QUOTES;
    this.volumeThreshold = Number(options.volumeThreshold) || 10_000_000;
    this.maxSymbolsPerInterval = Number(options.maxSymbolsPerInterval) || 1000;

    this.intervalData = new Map(); // intervalKey -> Map(symbol -> [{ price, timestamp }])
    this.symbolMeta = new Map(); // symbol -> { volume, lastPrice, updatedAt }
  }

  shouldTrack(symbol) {
    if (!symbol) return false;
    const normalized = symbol.toUpperCase(); 
    return this.allowedQuotes.some((quote) => normalized.endsWith(quote));
  }

  ingest({ symbol, price, volume = 0, timestamp = Date.now() }) {
    if (!symbol || !Number.isFinite(price)) return;
    if (!this.shouldTrack(symbol)) return;

    const normalizedSymbol = symbol.toUpperCase();
    const meta = this.symbolMeta.get(normalizedSymbol) || {};
    meta.volume = Number(volume) || 0;
    meta.lastPrice = price;
    meta.updatedAt = timestamp;
    this.symbolMeta.set(normalizedSymbol, meta);

    this.intervals.forEach((intervalConfig) => {
      const store =
        this.intervalData.get(intervalConfig.key) || new Map();
      const series = store.get(normalizedSymbol) || [];

      const lastPoint = series[series.length - 1];
      const sampleInterval = Number(intervalConfig.sampleIntervalMs);
      const canAppend =
        !Number.isFinite(sampleInterval) ||
        !lastPoint ||
        timestamp - lastPoint.timestamp >= sampleInterval;

      if (canAppend) {
        series.push({ price, timestamp });
      } else if (lastPoint) {
        // Update price within the bucket, but keep original timestamp
        // so the next sample can be appended after sampleInterval passes
        lastPoint.price = price;
        // DO NOT update timestamp - it should stay as the bucket start time
      }

      const cutoff = timestamp - intervalConfig.windowMs;
      while (series.length && series[0].timestamp < cutoff) {
        series.shift();
      }
      while (series.length > intervalConfig.maxSamples) {
        series.shift();
      }
      if (store.size > this.maxSymbolsPerInterval && !store.has(normalizedSymbol)) {
        // Optional eviction of oldest symbol to keep memory bounded
        const [oldestSymbol] = store.keys();
        if (oldestSymbol && oldestSymbol !== normalizedSymbol) {
          store.delete(oldestSymbol);
        }
      }
      store.set(normalizedSymbol, series);
      this.intervalData.set(intervalConfig.key, store);
    });
  }

  computeScore(series) {
    if (!series || series.length < 2) {
      return 0;
    }
    let total = 0;
    let prevPrice = null;

    // Sum of absolute percentage changes between consecutive samples
    // For 1s interval with 60 samples: sum of 59 price changes over 60 seconds
    // For 5m interval with 60 samples: sum of 59 price changes over 300 minutes
    for (const point of series) {
      const currentPrice = point.price;
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        continue;
      }
      
      if (prevPrice !== null && prevPrice > 0) {
        // Calculate absolute percentage change: |current/prev - 1|
        const pctChange = Math.abs(currentPrice / prevPrice - 1);
        total += pctChange;
      }
      
      prevPrice = currentPrice;
    }

    return Number((total * 100).toFixed(3));
  }

  getMetricsForInterval(intervalKey, { limit, volumeThreshold } = {}) {
    const store = this.intervalData.get(intervalKey);
    if (!store) return [];
    const rows = [];
    const volumeFloor =
      Number(volumeThreshold) || this.volumeThreshold;

    store.forEach((series, symbol) => {
      const meta = this.symbolMeta.get(symbol);
      if (!meta) return;
      if (meta.volume && meta.volume < volumeFloor) return;
      const score = this.computeScore(series);
      rows.push({
        symbol,
        score,
        lastPrice: meta.lastPrice,
        volume: meta.volume,
        samples: series.length,
        updatedAt: meta.updatedAt,
      });
    });

    rows.sort((a, b) => b.score - a.score);

    if (Number.isFinite(limit) && limit > 0) {
      return rows.slice(0, limit);
    }
    return rows;
  }

  getSnapshot({ interval, limit, volumeThreshold } = {}) {
    const targetIntervals = interval
      ? this.intervals.filter((item) => item.key === interval)
      : this.intervals;

    const intervals = {};
    targetIntervals.forEach((config) => {
      const store = this.intervalData.get(config.key);
      const totalSymbols = store ? store.size : 0;
      // Get sample count from first symbol as representative
      let sampleCount = 0;
      if (store && store.size > 0) {
        const firstSeries = store.values().next().value;
        sampleCount = firstSeries ? firstSeries.length : 0;
      }
      
      intervals[config.key] = {
        metrics: this.getMetricsForInterval(config.key, {
          limit,
          volumeThreshold,
        }),
        sampleCount,
        totalSymbols,
        windowMs: config.windowMs,
        sampleIntervalMs: config.sampleIntervalMs,
      };
    });

    return {
      generatedAt: Date.now(),
      intervals,
    };
  }
}

module.exports = { ActivityTracker };

