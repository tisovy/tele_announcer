const express = require("express");
const { createClient } = require("redis");
const { Telegraf } = require("telegraf");
const { message } = require("telegraf/filters");
const { Console } = require("console");
const cryptoLib = require("crypto");
const https = require("https");
const WebsocketStream = require("@binance/connector").WebsocketStream;
const { AnalyticsEngine } = require("./server/analytics/metrics-engine");
const { ActivityTracker } = require("./server/activity-tracker");

const app = express();
const port = 3000;
const DB_NAME = "binance_announcer";
const TELE_ANNOUNCER = process.env.TELE_ANNOUNCER;
const MIN_PRICE_BREACH_TIMEOUT = 1;
const MIN_PRICE_BREACH_PERCENT = 0.5;
const MIN_PRICE_NOTIFICATION_PERCENT = 3;
const MIN_NOTIFICATION_TIMEOUT = 3 * 1000;
const USER_LIST = [{ username: "", id: "" }];
const USER_SU = [{ username: "", id: "" }];
const WHITELIST_IDS = new Set(
  [...USER_LIST, ...USER_SU]
    .map((entry) => Number.parseInt(entry.id, 10))
    .filter((id) => Number.isFinite(id))
);
const MARK_DAILY_PERCENT_THRESHOLD = 30;
const MARK_PERCENT_THRESHOLD = 5;
const MARK_VOLUME_THRESHOLD = 100000000;
const MIN_VOLUME_LIMIT = 500000;
const BTC_SYMBOL = "BTCUSDT";
const QUOTE_SYMBOL = "USDT";
const ANALYTICS_ENABLED = true;
const ANALYTICS_API_KEY = process.env.ANALYTICS_API_KEY || "";
const ANALYTICS_API_SECRET = process.env.ANALYTICS_API_SECRET || "";
const ANALYTICS_ALLOWED_ORIGINS = new Set(
  parseList(process.env.ANALYTICS_ALLOWED_ORIGINS)
);
const ANALYTICS_RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.ANALYTICS_RATE_WINDOW_MS || "60000",
  10
);
const ANALYTICS_RATE_LIMIT_MAX = parseInt(
  process.env.ANALYTICS_RATE_LIMIT_MAX || "120",
  10
);
const ANALYTICS_MAX_CLOCK_SKEW_MS = parseInt(
  process.env.ANALYTICS_MAX_CLOCK_SKEW_MS || "30000",
  10
);
const ANALYTICS_PERSIST_INTERVAL_MS = parseInt(
  process.env.ANALYTICS_PERSIST_INTERVAL_MS || "60000",
  10
);

if (!TELE_ANNOUNCER) {
  console.error("Telegram Token not found in your env");
  process.exit(1);
}
// Telegram bot setup — reuse TLS connections so we pay fewer connection-setup
// timeouts when talking to the Bot API.
const telegramAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 64,
});
const bot = new Telegraf(TELE_ANNOUNCER, {
  telegram: { agent: telegramAgent },
});

// Logger setup
const logger = new Console({ stdout: process.stdout, stderr: process.stderr });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Send one Telegram message with a hard per-attempt timeout and retries on
// transient failures (timeouts, resets, aborts, 429, 5xx). Never throws, so a
// single bad recipient can't stall the announcement loop or leak a rejection.
const sendTelegramMessage = async (chatId, text, label = chatId) => {
  const MAX_ATTEMPTS = 3;
  const REQUEST_TIMEOUT_MS = 20000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      : null;

    try {
      await bot.telegram.callApi(
        "sendMessage",
        { chat_id: chatId, text, parse_mode: "HTML" },
        controller ? { signal: controller.signal } : {}
      );
      return true;
    } catch (error) {
      const errorCode = error?.response?.error_code;
      // Permanent errors — retrying won't help.
      if (errorCode === 403) {
        logger.error(`User ${label} has blocked the bot.`);
        return false;
      }
      if (errorCode === 400) {
        logger.error(
          `Bad request sending to ${label}:`,
          error.description || error
        );
        return false;
      }

      const reason = error?.code || error?.message || error;
      logger.error(
        `Error sending message to ${label} (attempt ${attempt}/${MAX_ATTEMPTS}): ${reason}`
      );
      if (attempt === MAX_ATTEMPTS) return false;
      await sleep(1000 * attempt);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return false;
};

const analyticsEngine = new AnalyticsEngine({
  enabled: ANALYTICS_ENABLED,
  minVolume: 0,
  trackedSymbols: [],
  quoteAsset: QUOTE_SYMBOL,
  btcSymbol: BTC_SYMBOL,
});

const analyticsAuthConfigured = Boolean(
  ANALYTICS_API_KEY && ANALYTICS_API_SECRET
);
const analyticsRateBuckets = new Map();
let analyticsPersistTimer;
let marketStreamWatchdog;
const activityTracker = new ActivityTracker({
  allowedQuotes: [QUOTE_SYMBOL],
});

app.use(
  express.json({
    limit: "256kb",
    verify: rawBodySaver,
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "256kb",
    verify: rawBodySaver,
  })
);

app.use((req, res, next) => {
  if (typeof req.rawBody !== "string") {
    req.rawBody = "";
  }
  next();
});

if (ANALYTICS_ENABLED) {
  app.use(
    "/analytics",
    analyticsCorsMiddleware,
    analyticsRateLimiter,
    analyticsAuthMiddleware,
    createAnalyticsRouter()
  );
  logger.log("Analytics API endpoint is enabled");
}

// State variables
let announcer;
let lastNotificationTime = {}; // Store the last notification time for each coin
let lastPrices = {}; // Store the last prices for each coint
let lastHighPrices = {}; //Store the last high prices for each coin
let lastLowPrices = {}; //Store the last low prices for each coin
let lastSocketData = {}; // Store all data which Socket returns
let minPriceBreachTimeout = MIN_PRICE_BREACH_TIMEOUT;
let minPriceBreachPercent = MIN_PRICE_BREACH_PERCENT;
let minNotificationTimeout = MIN_NOTIFICATION_TIMEOUT;
let minPriceNotificatoinPercent = MIN_PRICE_NOTIFICATION_PERCENT;
let minVolumeLimit = MIN_VOLUME_LIMIT;
let lastSentNotificationTime = 0;

const main = async () => {
  // Redis setup
  const redis = createClient();
  await redis.connect().catch((error) => {
    console.error("Failed to connect to Redis", error);
    process.exit(1);
  });

  if (!announcer || !announcer.lastLowPrices) {
    // Load/Init announcer state from Redis
    const savedData = await redis.get(DB_NAME);
    if (savedData) {
      announcer = JSON.parse(savedData);
      lastNotificationTime =
        announcer.lastNotificationTime || lastNotificationTime;
      lastPrices = announcer.lastPrices || lastPrices;
      lastHighPrices = announcer.lastHighPrices || lastHighPrices;
      lastLowPrices = announcer.lastLowPrices || lastLowPrices;
      lastSocketData = announcer.lastSocketData || lastSocketData;
      lastSentNotificationTime =
        announcer.lastSentNotificationTime || lastSentNotificationTime;
      minPriceBreachTimeout =
        announcer.minPriceBreachTimeout || minPriceBreachTimeout;
      minPriceBreachPercent =
        announcer.minPriceBreachPercent || minPriceBreachPercent;
      minNotificationTimeout =
        announcer.minNotificationTimeout || minNotificationTimeout;
      minPriceNotificatoinPercent =
        announcer.minPriceNotificatoinPercent || minPriceNotificatoinPercent;
      minVolumeLimit = announcer.minVolumeLimit || minVolumeLimit;
      if (announcer.analyticsState) {
        analyticsEngine.restoreState(announcer.analyticsState);
      }
    } else {
      announcer = {
        lastNotificationTime,
        lastPrices,
        lastHighPrices,
        lastLowPrices,
        lastSocketData,
        lastSentNotificationTime,
        minPriceBreachTimeout,
        minPriceBreachPercent,
        minNotificationTimeout,
        minPriceNotificatoinPercent,
        minVolumeLimit,
        analyticsState: analyticsEngine.getSerializableState(),
      };
    }
    console.log("announcer data has been initialized");
  }

  try {
    // check if user is in the Whitelist
    bot.use(async (ctx, next) => {
      const isUserAllowed =
        ctx.message?.from && WHITELIST_IDS.has(ctx.message.from.id);
      if (isUserAllowed) next();
    });

    bot.hears(/^n\s\d+/i, async (ctx) => {
      let val = parseFloat(ctx.message?.text?.split(" ")[1]);

      if (val && val > 0 && val < 1000) {
        minNotificationTimeout = val * 1000;
        await updateState();
        ctx.reply(
          `Значение min notification timeout установлено на: ${minNotificationTimeout / 1000
          }s`
        );
      } else {
        ctx.reply("Ошибка при выполении запроса");
      }
    });

    bot.hears(/^p\s\d+/i, async (ctx) => {
      let val = parseFloat(ctx.message?.text?.split(" ")[1]);

      if (val && val > 0 && val < 50) {
        minPriceNotificatoinPercent = val;
        await updateState();
        ctx.reply(
          `Значение min price notification percent установлено на: ${minPriceNotificatoinPercent}%`
        );
      } else {
        ctx.reply("Ошибка при выполении запроса");
      }
    });

    bot.hears(/^pt\s\d+/i, async (ctx) => {
      let val = parseFloat(ctx.message?.text?.split(" ")[1]);

      if (val && val > 0 && val < 50) {
        minPriceBreachTimeout = val;
        await updateState();
        ctx.reply(
          `Значение min price breach timeout установлено на: ${minPriceBreachTimeout}%`
        );
      } else {
        ctx.reply("Ошибка при выполении запроса");
      }
    });

    bot.hears(/^pp\s\d+/i, async (ctx) => {
      let val = parseFloat(ctx.message?.text?.split(" ")[1]);

      if (val && val > 0 && val < 50) {
        minPriceBreachPercent = val;
        await updateState();
        ctx.reply(
          `Значение min price breach percent установлено на: ${minPriceBreachPercent}%`
        );
      } else {
        ctx.reply("Ошибка при выполении запроса");
      }
    });

    bot.hears(/^v\s\d+/i, async (ctx) => {
      let val = parseInt(ctx.message?.text?.split(" ")[1]);

      if (val && val > 0) {
        minVolumeLimit = val;
        await updateState();
        ctx.reply(
          `Значение min volume limit установлено на: ${minVolumeLimit.toLocaleString(
            "en-GB"
          )}$`
        );
      } else {
        ctx.reply("Ошибка при выполении запроса");
      }
    });

    // Return latest prices on user message
    bot.on(message("text"), async (ctx) => {
      const msg = ctx.message;
      let socketPairs;
      let text = "";

      if (msg && msg.text && /^\w+$/.test(msg.text)) {
        socketPairs = Object.keys(lastSocketData)
          .map((e) => (e.includes(msg.text.toUpperCase()) ? e : ""))
          .filter(String);
        socketPairs.forEach((pair) => {
          const pairData = {
            pair,
            currentPrice: parseFloat(lastSocketData[pair].c),
            previousPrice: lastPrices[pair],
            openPrice: parseFloat(lastSocketData[pair].o),
            volume: parseInt(lastSocketData[pair].q),
          };
          text += formatMessage(pairData) + "\n";
        });
      }

      text.length ? ctx.replyWithHTML(text) : ctx.reply("Нет данных");
    });
  } catch (error) {
    console.error("Error with Telegram Bot message handling:", error);
  }

  bot.catch((error, ctx) => {
    logger.error(
      `Telegraf handler error (update ${ctx?.update?.update_id}):`,
      error
    );
  });

  bot.launch().catch((error) => {
    logger.error("Failed to launch Telegram bot:", error);
    process.exit(1);
  });

  // Function to send announcements
  const sendAnnouncement = async (payload) => {
    const users = USER_LIST;

    if (!users.length || !users[0].username) {
      console.log("USER_LIST is empty");
      return;
    }

    // The message body is identical for every recipient — build it once.
    let text = "";
    payload.forEach((data) => {
      text += formatMessage(data) + "\n";
    });
    text = text.trim();
    if (!text) return;

    users.forEach((user) => {
      // Fire-and-forget: sendTelegramMessage retries and never throws, so one
      // slow/blocked recipient can't stall the others or the websocket loop.
      void sendTelegramMessage(user.id, text, user.username || user.id);
    });
  };

  // WebSocket Stream setup for real-time updates
  let lastWsMessageAt = Date.now();
  const websocketCallbacks = {
    open: () => logger.debug("Connected with WebSocket server"),
    close: () => logger.debug("Disconnected with WebSocket server"),
    message: async (data) => {
      // Heartbeat for the watchdog: miniTicker pushes ~once per second, so a
      // longer silence means the socket is dead even if it never fired 'close'.
      lastWsMessageAt = Date.now();
      const messages = JSON.parse(data);
      const now = Date.now();
      let payload = [];

      // Loop through each ticker event in the array
      for (const message of messages) {
        if (message.e === "24hrMiniTicker" && /USDT/.test(message.s)) {
          const pair = message.s; // Symbol (e.g., BNBBTC)
          const currentPrice = parseFloat(message.c); // Current price
          const highPrice = parseFloat(message.h);
          const lowPrice = parseFloat(message.l);
          const openPrice = parseFloat(message.o);
          const volume = parseFloat(message.q) || 0;
          const eventTime =
            typeof message.E === "number" && !Number.isNaN(message.E)
              ? message.E
              : now;

          // collect Socket data
          lastSocketData[pair] = message;

          if (ANALYTICS_ENABLED) {
            analyticsEngine.ingest({
              symbol: pair,
              price: currentPrice,
              volume,
              timestamp: eventTime,
            });
          }

          activityTracker.ingest({
            symbol: pair,
            price: currentPrice,
            volume,
            timestamp: eventTime,
          });

          // Calculate the percentage change from the last recorded price
          const checkData =
            lastPrices[pair] &&
            lastNotificationTime[pair] &&
            lastHighPrices[pair] &&
            lastLowPrices[pair];
          if (checkData) {
            const previousPrice = lastPrices[pair];
            const priceChangePercent =
              ((currentPrice - previousPrice) / previousPrice) * 100;

            // (skip notification if:
            // variables are undefined
            // + last lastNotificationTime was > minNotificationTimeout ago
            // + percent change is > than minPriceNotificatoinPercent
            // OR
            // price has breached High and Log daily prices
            // + latest update was for [pair] was less than minNotificationTimeout
            // + min notification for price breach is > than minPriceBreachTimeout)
            // + min price breach percent is > than minPriceBreachPercent
            // AND
            // + minimum Volume is > than minVolumeLimit {
            const firstCheck =
              now - lastNotificationTime[pair] > minNotificationTimeout &&
              Math.abs(priceChangePercent) > minPriceNotificatoinPercent;

            const isPriceBreach =
              currentPrice > lastHighPrices[pair] ||
              lastLowPrices[pair] > currentPrice;

            let isPercentBreach = false;
            if (isPriceBreach) {
              let percent = Math.abs(
                currentPrice > lastHighPrices[pair]
                  ? ((currentPrice - lastHighPrices[pair]) /
                    lastHighPrices[pair]) *
                  100
                  : ((currentPrice - lastLowPrices[pair]) /
                    lastLowPrices[pair]) *
                  100
              );
              if (percent > minPriceBreachPercent) isPercentBreach = true;
            }

            const secondCheck =
              isPercentBreach &&
              now - lastNotificationTime[pair] > minPriceBreachTimeout;

            const sendNotification =
              (firstCheck || secondCheck) && volume > minVolumeLimit;
            // }

            // Ensure that the notification is sent only if at least 3 seconds have passed since the last one
            if (sendNotification) {
              const pairData = {
                pair,
                currentPrice,
                previousPrice,
                openPrice,
                volume,
              };

              // Check for price breaches and send notifications
              payload.push(pairData);
              // Update the last notification timestamp and price
              lastNotificationTime[pair] = now;
              lastPrices[pair] = currentPrice;
              lastHighPrices[pair] = highPrice;
              lastLowPrices[pair] = lowPrice;
            }
          } else {
            // init latestPrice and lastNotificationTime for a pair
            lastPrices[pair] = currentPrice;
            lastHighPrices[pair] = highPrice;
            lastLowPrices[pair] = lowPrice;
            lastNotificationTime[pair] = now - minNotificationTimeout;
          }
        }
      }
      // send payload with actual Socket data
      if (payload.length) {
        await sendAnnouncement(payload);
        lastSentNotificationTime = now;
        // Update and save state
        await updateState();
      }
    },
  };

  const formatPrice = (p, fixLen = 2) => {
    var str = p.toString();
    // parse floats like '7e-7'
    if (/\d+[e]-\d+/.test(str)) {
      fixLen = parseInt(str[str.length - 1]);
      //parse regular floats, check if incoming value is a float
    } else if (str.split(".")[1]) {
      fixLen = str.split(".")[1].length;
    }
    p = p.toFixed(fixLen);
    return p;
  };

  const formatVolume = (v) => {
    const formatter = Intl.NumberFormat("en", { notation: "compact" });
    return v > MARK_VOLUME_THRESHOLD
      ? `<u><b>${formatter.format(parseInt(v))}</b></u>`
      : formatter.format(parseInt(v));
  };

  const formatMessage = (data) => {
    // remove USDT from the message
    let coin = data.pair.replace("USDT", "");
    // get percent of coin change
    let percent =
      ((data.currentPrice - data.previousPrice) / data.previousPrice) * 100;
    const directionLocal = percent > 0 ? "🟢" : "🔴";
    percent =
      Math.abs(percent) > MARK_PERCENT_THRESHOLD
        ? `<u><b>${percent.toFixed(1)}</b></u>`
        : percent.toFixed(1);
    // price up or down
    const directionGlobal = (data.currentPrice > data.openPrice)
      ? "🟩"
      : "🟥";
    // calculate daily price change
    let dailyPercent =
      (data.currentPrice > data.openPrice
        ? (data.currentPrice - data.openPrice) / data.openPrice
        : (data.openPrice / data.currentPrice - 1) * -1) * 100;
    dailyPercent =
      Math.abs(dailyPercent) > MARK_DAILY_PERCENT_THRESHOLD
        ? `<u><b>${dailyPercent.toFixed(1)}</b></u>`
        : dailyPercent.toFixed(1);

    const volume = formatVolume(data.volume);

    return `${directionGlobal}${directionLocal}${coin} ${formatPrice(
      data.currentPrice
    )} ${percent}% (${dailyPercent}%) ${volume}`;
  };

  let websocketStreamClient;

  // (Re)create the market-data stream. The connector auto-reconnects when the
  // socket fires 'close', but a half-open/zombie TCP can silently stop
  // delivering data without ever closing — the watchdog below covers that case.
  const startMarketStream = () => {
    websocketStreamClient = new WebsocketStream({
      logger,
      callbacks: websocketCallbacks,
    });
    websocketStreamClient.miniTicker();
    lastWsMessageAt = Date.now();
  };

  const updateState = async () => {
    // Update and save state
    announcer = {
      lastPrices,
      lastHighPrices,
      lastLowPrices,
      lastNotificationTime,
      lastSocketData,
      lastSentNotificationTime,
      minPriceBreachTimeout,
      minPriceBreachPercent,
      minNotificationTimeout,
      minPriceNotificatoinPercent,
      minVolumeLimit,
      analyticsState: analyticsEngine.getSerializableState(),
    };
    await redis.set(DB_NAME, JSON.stringify(announcer));
  };

  // Subscribe to all pairs miniTicker and start watching the data flow.
  startMarketStream();

  // Watchdog: if no market data arrives for a while the socket is dead. Force
  // it closed so the connector reconnects (re-subscribing via the stream URL).
  const WS_STALE_TIMEOUT_MS = 60 * 1000;
  const WS_WATCHDOG_INTERVAL_MS = 15 * 1000;
  marketStreamWatchdog = setInterval(() => {
    const silenceMs = Date.now() - lastWsMessageAt;
    if (silenceMs <= WS_STALE_TIMEOUT_MS) return;

    logger.error(
      `No market data for ${Math.round(
        silenceMs / 1000
      )}s — forcing Binance websocket reconnect`
    );
    // Give the reconnect a full window to land before tripping again.
    lastWsMessageAt = Date.now();

    const ws = websocketStreamClient?.wsConnection?.ws;
    if (ws && typeof ws.terminate === "function") {
      // terminate() emits 'close' even on a half-open socket; the connector's
      // close handler (closeInitiated === false) then reconnects on its own.
      try {
        ws.terminate();
      } catch (error) {
        logger.error("Failed to terminate stale websocket, recreating:", error);
        startMarketStream();
      }
    } else {
      startMarketStream();
    }
  }, WS_WATCHDOG_INTERVAL_MS);

  if (ANALYTICS_ENABLED) {
    analyticsPersistTimer = setInterval(async () => {
      try {
        await updateState();
      } catch (error) {
        logger.error("Failed to persist analytics state", error);
      }
    }, ANALYTICS_PERSIST_INTERVAL_MS);
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on 0.0.0.0:${port}`);
  });
};

function createAnalyticsRouter() {
  const router = express.Router();

  router.get("/health", (req, res) => {
    const strengthSummary = analyticsEngine.getSnapshot("strength", {
      limit: parseLimit(req.query.limit),
    });
    const enduranceSummary = analyticsEngine.getSnapshot("endurance", {
      limit: parseLimit(req.query.limit),
    });
    res.json({
      ok: true,
      enabled: ANALYTICS_ENABLED,
      generatedAt: strengthSummary.generatedAt,
      trackers: {
        strength: strengthSummary.total,
        endurance: enduranceSummary.total,
      },
      lastSentNotificationTime,
    });
  });

  router.get("/strength", (req, res) => {
    const limit = parseLimit(req.query.limit);
    const snapshot = analyticsEngine.getSnapshot("strength", { limit });
    res.json(snapshot);
  });

  router.get("/strength/:symbol", (req, res) => {
    const metric = analyticsEngine.getMetric("strength", req.params.symbol);
    if (!metric) {
      return res.status(404).json({ error: "Symbol not tracked" });
    }
    return res.json(metric);
  });

  router.get("/endurance", (req, res) => {
    const limit = parseLimit(req.query.limit);
    const snapshot = analyticsEngine.getSnapshot("endurance", { limit });
    res.json(snapshot);
  });

  router.get("/endurance/:symbol", (req, res) => {
    const metric = analyticsEngine.getMetric("endurance", req.params.symbol);
    if (!metric) {
      return res.status(404).json({ error: "Symbol not tracked" });
    }
    return res.json(metric);
  });

  router.get("/combined", (req, res) => {
    const limit = parseLimit(req.query.limit);
    const strength = analyticsEngine.getSnapshot("strength", { limit });
    const endurance = analyticsEngine.getSnapshot("endurance", { limit });
    res.json({
      generatedAt: Date.now(),
      strength,
      endurance,
    });
  });

  router.get("/activity", (req, res) => {
    const limit = parseLimit(req.query.limit);
    const interval =
      typeof req.query.interval === "string" ? req.query.interval : undefined;
    const volumeThreshold = Number(req.query.volumeThreshold);

    const snapshot = activityTracker.getSnapshot({
      interval,
      limit,
      volumeThreshold:
        Number.isFinite(volumeThreshold) && volumeThreshold > 0
          ? volumeThreshold
          : undefined,
    });

    res.json({
      generatedAt: snapshot.generatedAt,
      intervals: snapshot.intervals,
    });
  });

  return router;
}

function rawBodySaver(req, res, buf) {
  if (buf && buf.length) {
    req.rawBody = buf.toString("utf8");
  }
}

function parseList(value) {
  if (!value || typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length);
}

function parseLimit(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(Math.floor(parsed), 200);
}

function getClientIp(req) {
  const header = req.headers["x-forwarded-for"];
  if (header) {
    return header.split(",")[0].trim();
  }
  return (
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    req.ip ||
    "unknown"
  );
}

function analyticsCorsMiddleware(req, res, next) {
  if (!ANALYTICS_ENABLED) return next();
  const origin = req.get("origin");
  if (origin) {
    if (ANALYTICS_ALLOWED_ORIGINS.size && !ANALYTICS_ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: "Origin not allowed" });
    }
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  } else if (!ANALYTICS_ALLOWED_ORIGINS.size) {
    res.header("Access-Control-Allow-Origin", "*");
  }

  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type,X-Analytics-Key,X-Analytics-Ts,X-Analytics-Signature"
  );
  res.header("Access-Control-Allow-Methods", "GET,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  return next();
}

function analyticsRateLimiter(req, res, next) {
  if (
    !ANALYTICS_ENABLED ||
    req.method === "OPTIONS" ||
    ANALYTICS_RATE_LIMIT_MAX <= 0 ||
    ANALYTICS_RATE_LIMIT_WINDOW_MS <= 0
  ) {
    return next();
  }

  const key = getClientIp(req);
  const now = Date.now();
  const bucket = analyticsRateBuckets.get(key) || {
    count: 0,
    resetAt: now + ANALYTICS_RATE_LIMIT_WINDOW_MS,
  };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + ANALYTICS_RATE_LIMIT_WINDOW_MS;
  }

  bucket.count += 1;
  analyticsRateBuckets.set(key, bucket);

  if (bucket.count > ANALYTICS_RATE_LIMIT_MAX) {
    res.set("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
    return res.status(429).json({ error: "Rate limit exceeded" });
  }

  return next();
}

function analyticsAuthMiddleware(req, res, next) {
  if (
    !ANALYTICS_ENABLED ||
    !analyticsAuthConfigured ||
    req.method === "OPTIONS"
  ) {
    return next();
  }

  const providedKey = req.get("x-analytics-key");
  const timestampHeader = req.get("x-analytics-ts");
  const signature = req.get("x-analytics-signature");

  if (!providedKey || !timestampHeader || !signature) {
    return res.status(401).json({ error: "Missing analytics auth headers" });
  }

  if (providedKey !== ANALYTICS_API_KEY) {
    return res.status(401).json({ error: "Invalid analytics key" });
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return res.status(401).json({ error: "Invalid analytics timestamp" });
  }

  const delta = Math.abs(Date.now() - timestamp);
  if (delta > ANALYTICS_MAX_CLOCK_SKEW_MS) {
    return res.status(401).json({ error: "Stale analytics request" });
  }

  const payload = [
    providedKey,
    timestamp,
    req.method.toUpperCase(),
    req.originalUrl,
    req.rawBody || "",
  ].join(":");

  const expectedSignature = cryptoLib
    .createHmac("sha256", ANALYTICS_API_SECRET)
    .update(payload)
    .digest("hex");

  if (!safeCompare(signature.toLowerCase(), expectedSignature)) {
    return res.status(401).json({ error: "Invalid analytics signature" });
  }

  return next();
}

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const normalizedA = a.trim().toLowerCase();
  const normalizedB = b.trim().toLowerCase();
  if (normalizedA.length !== normalizedB.length) return false;
  try {
    const aBuffer = Buffer.from(normalizedA, "hex");
    const bBuffer = Buffer.from(normalizedB, "hex");
    if (aBuffer.length !== bBuffer.length) return false;
    return cryptoLib.timingSafeEqual(aBuffer, bBuffer);
  } catch {
    return false;
  }
}

// Enable graceful stop
const shutdownBot = (signal) => {
  if (analyticsPersistTimer) {
    clearInterval(analyticsPersistTimer);
  }
  if (marketStreamWatchdog) {
    clearInterval(marketStreamWatchdog);
  }
  bot.stop(signal);
};

// Last-resort safety nets so a stray error surfaces in the logs instead of
// silently wedging the process. Uncaught exceptions exit so pm2 can restart.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception, exiting so pm2 can restart:", error);
  process.exit(1);
});

process.once("SIGINT", () => shutdownBot("SIGINT"));
process.once("SIGTERM", () => shutdownBot("SIGTERM"));

main();
