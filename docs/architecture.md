# Architecture overview

Tele Announcer orchestrates Binance websocket data, Redis-backed state, and Telegram notifications in a single Node.js process.

## Primary loop (`server.js`)

- Reads the required `TELE_ANNOUNCER` token, configures Telegraf, and wires up Express at `/analytics`.
- Connects to Redis to persist the announcer's state (last prices, notifications, analytics snapshots) under `binance_announcer`.
- Launches a Binance `WebsocketStream` that streams `24hrMiniTicker` events for every pair. Each update feeds the activity tracker, analytics engine, and notification logic.
- Tracks per-symbol timing, percentage thresholds, and volume requirements before updating subscribers or persisting the refreshed state.

## Telegram bot

- The bot is protected by a whitelist (`USER_LIST`). Only matching chat IDs can send configuration commands or consume statistics.
- Supported commands mutate thresholds: `n` (notification timeout), `p` (price notification percent), `pt` (price breach timeout), `pp` (price breach percent), and `v` (volume limit).
- Users can also send a symbol to receive the most recent formatted data with HTML markup.

## Analytics and activity tracking

- `AnalyticsEngine` collects price returns for configured windows and maintains strength/endurance scores relative to BTC. It exposes the metrics via Express when an API key/secret pair is configured.
- `ActivityTracker` captures price snapshots across multiple intervals to surface volume/volatility snapshots (`/analytics/activity`).
- Both engines contribute to the `/analytics` router exported by `createAnalyticsRouter`.

## Telemetry, persistence, and shutdown

- The Express middleware stack validates raw body buffers to re-use them for signed requests.
- Rate limiting, CORS, and HMAC authentication guard the analytics API when enabled.
- State is periodically flushed (`ANALYTICS_PERSIST_INTERVAL_MS`) and immediately saved after notifications.
- Signal handlers ensure the bot and persistence timer stop cleanly on `SIGINT`/`SIGTERM`.

