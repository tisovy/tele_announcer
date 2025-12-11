# Tele Announcer

Telegram-based notifier that watches Binance USDT markets, tracks activity, and exposes a lightweight analytics API.

## Quick start
1. Install dependencies: `npm install`
2. Provision a Redis instance reachable from the host (defaults to `localhost:6379`)
3. Export the required Telegram bot token: `export TELE_ANNOUNCER="YOUR_BOT_TOKEN"`
4. Optionally configure analytics (see below)
5. Run lint to surface issues: `npm run lint`
6. Start the server: `npm start`

## Environment variables

| Key | Required | Description |
| --- | --- | --- |
| `TELE_ANNOUNCER` | ✅ | Telegram bot token used to send notifications |
| `ANALYTICS_API_KEY` | 🚧 | Enables the analytics endpoint when paired with the secret |
| `ANALYTICS_API_SECRET` | 🚧 | Used to sign analytics requests; required when `ANALYTICS_API_KEY` is set |
| `ANALYTICS_ALLOWED_ORIGINS` | | Comma-separated list of allowed origins for analytics |
| `ANALYTICS_RATE_WINDOW_MS` | | Sliding window for rate limiting (default `60000`) |
| `ANALYTICS_RATE_LIMIT_MAX` | | Max requests per window (default `120`) |
| `ANALYTICS_MAX_CLOCK_SKEW_MS` | | Max clock skew allowed for signed requests (default `30000`) |
| `ANALYTICS_PERSIST_INTERVAL_MS` | | Interval between analytics state flushes (default `60000`) |

## Analytics API

The Express `/analytics` router exposes health, strength, endurance, combined, and activity data. Requests require matching auth headers when analytics are enabled:

```
X-Analytics-Key: <ANALYTICS_API_KEY>
X-Analytics-Ts: <unix milliseconds timestamp>
X-Analytics-Signature: HMAC_SHA256(secret, key:timestamp:method:url:rawBody)
```

See `docs/api.md` for endpoint details and `docs/architecture.md` for a system overview.

## Linting

ESLint is configured for the Node environment. Run `npm run lint` to validate changes before shipping.

## License

This project is released under the terms of [GPL-3.0](LICENSE).

