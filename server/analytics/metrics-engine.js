const DEFAULT_PRICE_BUCKET_MS = 60 * 1000; // 1 minute buckets
const DEFAULT_MAX_HISTORY_MS = 26 * 60 * 60 * 1000; // keep a bit more than 24h

const DEFAULT_STRENGTH_WINDOWS = [
  { label: "3m", ms: 3 * 60 * 1000, minMove: 0.25, weight: 4 },
  { label: "5m", ms: 5 * 60 * 1000, minMove: 0.35, weight: 3 },
  { label: "15m", ms: 15 * 60 * 1000, minMove: 0.5, weight: 2 },
  { label: "1h", ms: 60 * 60 * 1000, minMove: 0.75, weight: 1 },
];

const DEFAULT_ENDURANCE_WINDOWS = [
  { label: "1h", ms: 60 * 60 * 1000, minMove: 0.35, weight: 1 },
  { label: "4h", ms: 4 * 60 * 60 * 1000, minMove: 0.6, weight: 2 },
  { label: "1d", ms: 24 * 60 * 60 * 1000, minMove: 0.9, weight: 3 },
];

const roundNumber = (value, decimals = 2) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

class AnalyticsEngine {
  constructor(options = {}) {
    this.enabled = options.enabled ?? true;
    this.priceBucketMs = options.priceBucketMs || DEFAULT_PRICE_BUCKET_MS;
    this.maxHistoryMs = options.maxHistoryMs || DEFAULT_MAX_HISTORY_MS;
    this.strengthWindows = options.strengthWindows || DEFAULT_STRENGTH_WINDOWS;
    this.enduranceWindows = options.enduranceWindows || DEFAULT_ENDURANCE_WINDOWS;
    this.strengthRatioClamp = options.strengthRatioClamp || 2.5;
    this.enduranceRatioClamp = options.enduranceRatioClamp || 3;
    this.strengthAlpha = options.strengthAlpha ?? 0.4;
    this.enduranceAlpha = options.enduranceAlpha ?? 0.2;
    this.minVolume = options.minVolume || 1_000_000;
    this.quoteAsset = (options.quoteAsset || "USDT").toUpperCase();
    this.btcSymbol = (options.btcSymbol || "BTCUSDT").toUpperCase();
    this.trackedSymbols = new Set(
      (options.trackedSymbols || []).map((symbol) => symbol.toUpperCase())
    );

    this.priceHistory = new Map(); // symbol -> [{ ts, price }]
    this.strengthMetrics = new Map(); // symbol -> { score, updatedAt, components }
    this.enduranceMetrics = new Map();
    this.startedAt = Date.now();
  }

  restoreState(state = {}) {
    if (state.strength && typeof state.strength === "object") {
      this.strengthMetrics = this.objectToMap(state.strength);
    }
    if (state.endurance && typeof state.endurance === "object") {
      this.enduranceMetrics = this.objectToMap(state.endurance);
    }
    if (state.startedAt) {
      this.startedAt = state.startedAt;
    }
  }

  getSerializableState() {
    return {
      strength: this.mapToObject(this.strengthMetrics),
      endurance: this.mapToObject(this.enduranceMetrics),
      startedAt: this.startedAt,
      generatedAt: Date.now(),
    };
  }

  shouldTrack(symbol, volume = 0) {
    if (symbol === this.btcSymbol) return true;
    if (!symbol.endsWith(this.quoteAsset)) return false;
    if (this.trackedSymbols.size && !this.trackedSymbols.has(symbol)) {
      return false;
    }
    if (volume < this.minVolume) return false;
    return true;
  }

  ingest({ symbol, price, volume = 0, timestamp = Date.now() }) {
    if (!this.enabled) return;
    if (!symbol || !Number.isFinite(price)) return;

    const normalizedSymbol = symbol.toUpperCase();
    if (!this.shouldTrack(normalizedSymbol, volume)) return;

    this.recordPricePoint(normalizedSymbol, timestamp, price);
    if (normalizedSymbol === this.btcSymbol) {
      return;
    }

    if (!this.priceHistory.has(this.btcSymbol)) return;

    this.computeMetric({
      symbol: normalizedSymbol,
      timestamp,
      windows: this.strengthWindows,
      metricsMap: this.strengthMetrics,
      alpha: this.strengthAlpha,
      ratioClamp: this.strengthRatioClamp,
    });

    this.computeMetric({
      symbol: normalizedSymbol,
      timestamp,
      windows: this.enduranceWindows,
      metricsMap: this.enduranceMetrics,
      alpha: this.enduranceAlpha,
      ratioClamp: this.enduranceRatioClamp,
    });
  }

  recordPricePoint(symbol, timestamp, price) {
    const bucketTs =
      Math.floor(timestamp / this.priceBucketMs) * this.priceBucketMs;
    const history = this.priceHistory.get(symbol) || [];
    const lastEntry = history[history.length - 1];

    if (!lastEntry || lastEntry.ts !== bucketTs) {
      history.push({ ts: bucketTs, price });
    } else {
      lastEntry.price = price;
    }

    const minTs = bucketTs - this.maxHistoryMs;
    while (history.length && history[0].ts < minTs) {
      history.shift();
    }

    this.priceHistory.set(symbol, history);
  }

  getReturn(symbol, windowMs, timestamp) {
    const history = this.priceHistory.get(symbol);
    if (!history || !history.length) return null;
    const targetTs = timestamp - windowMs;
    let referencePrice = null;

    for (let i = history.length - 1; i >= 0; i -= 1) {
      const point = history[i];
      if (point.ts <= targetTs) {
        referencePrice = point.price;
        break;
      }
    }

    if (!Number.isFinite(referencePrice)) return null;
    const latestPrice = history[history.length - 1]?.price;
    if (!Number.isFinite(latestPrice) || referencePrice === 0) return null;

    return ((latestPrice - referencePrice) / referencePrice) * 100;
  }

  computeMetric({ symbol, timestamp, windows, metricsMap, alpha, ratioClamp }) {
    if (!windows || !windows.length) return null;

    let weightedScore = 0;
    let totalWeight = 0;
    const components = [];

    for (const window of windows) {
      const btcMove = this.getReturn(this.btcSymbol, window.ms, timestamp);
      const coinMove = this.getReturn(symbol, window.ms, timestamp);
      if (btcMove === null || coinMove === null) continue;
      if (Math.abs(btcMove) < window.minMove) continue;

      const ratio = coinMove / btcMove;
      const contribution = this.ratioToScore(ratio, ratioClamp);

      components.push({
        window: window.label,
        windowMs: window.ms,
        weight: window.weight,
        btcMovePct: roundNumber(btcMove, 3),
        coinMovePct: roundNumber(coinMove, 3),
        ratio: roundNumber(ratio, 3),
        contribution: roundNumber(contribution, 2),
      });

      weightedScore += contribution * window.weight;
      totalWeight += window.weight;
    }

    if (!components.length || !totalWeight) return null;

    const rawScore = weightedScore / totalWeight;
    const previous = metricsMap.get(symbol);
    const smoothedScore = previous
      ? this.applyEma(previous.score, rawScore, alpha)
      : rawScore;

    const entry = {
      score: roundNumber(smoothedScore, 2),
      updatedAt: timestamp,
      components,
      samples: components.length,
    };

    metricsMap.set(symbol, entry);
    return entry;
  }

  applyEma(previous, nextValue, alpha) {
    if (!Number.isFinite(previous)) return nextValue;
    if (!Number.isFinite(nextValue)) return previous;
    if (alpha <= 0) return previous;
    if (alpha >= 1) return nextValue;
    return previous + alpha * (nextValue - previous);
  }

  ratioToScore(ratio, clampValue) {
    if (!Number.isFinite(ratio) || clampValue <= 0) return 0;
    const normalized = Math.min(Math.abs(ratio), clampValue) / clampValue;
    return Math.max(0, (1 - normalized) * 100);
  }

  getSnapshot(type, { limit } = {}) {
    const targetMap =
      type === "strength" ? this.strengthMetrics : this.enduranceMetrics;
    const rows = [];

    targetMap.forEach((value, symbol) => {
      rows.push({ symbol, ...value });
    });

    rows.sort((a, b) => b.score - a.score);
    const payload = limit ? rows.slice(0, limit) : rows;

    return {
      type,
      generatedAt: Date.now(),
      since: this.startedAt,
      metrics: payload,
      total: rows.length,
    };
  }

  getMetric(type, symbol) {
    if (!symbol) return null;
    const targetMap =
      type === "strength" ? this.strengthMetrics : this.enduranceMetrics;
    const entry = targetMap.get(symbol.toUpperCase());
    if (!entry) return null;
    return {
      symbol: symbol.toUpperCase(),
      ...entry,
      type,
      generatedAt: Date.now(),
    };
  }

  mapToObject(map) {
    const result = {};
    map.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  objectToMap(obj) {
    const map = new Map();
    Object.entries(obj || {}).forEach(([key, value]) => {
      if (value && typeof value === "object") {
        map.set(key, value);
      }
    });
    return map;
  }
}

module.exports = { AnalyticsEngine };

