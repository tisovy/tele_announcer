# Analytics API

The `/analytics` router is only mounted when `ANALYTICS_ENABLED` is `true`. When analytics are enabled, requests must include the HMAC-backed headers described in `README.md`.

Security is enforced both on the bot side and the API side. The Telegram bot checks `USER_LIST`/`USER_SU` inside `server.js` (see lines 19‑20) before allowing interactions, and the analytics routes require HMAC-signed `X-Analytics-*` headers to proceed.

## Endpoints

- `GET /analytics/health`
  - Returns `ok`, whether analytics is enabled, a summary of open tracker buckets, and the timestamp of the last notification.

- `GET /analytics/strength`
  - Returns the strength metric snapshots for all tracked symbols (or the `limit` most recent.
  - Query parameters:
    - `limit` (optional): number of rows to return (e.g., `limit=20`).

- `GET /analytics/strength/:symbol`
  - Returns the latest strength details (score, components, samples) for a specific symbol.
  - Returns `404` when the symbol is not tracked.

- `GET /analytics/endurance`
  - Same as `strength` but using endurance windows.

- `GET /analytics/endurance/:symbol`
  - Same as above for a specific symbol.

- `GET /analytics/combined`
  - Returns both `strength` and `endurance` snapshots with `generatedAt` metadata.

- `GET /analytics/activity`
  - Returns activity tracker intervals plus metadata for sample counts and symbol coverage.
  - Query parameters:
    - `limit` (optional): caps the number of symbols returned per interval.
    - `interval` (optional): filters to one of the configured interval keys (e.g., `1m`, `5m`).
    - `volumeThreshold` (optional): minimum daily volume filter (defaults to the engine's internal threshold).

## Rate limiting & CORS

- Requests are rate limited per client IP via `ANALYTICS_RATE_LIMIT_MAX` per `ANALYTICS_RATE_WINDOW_MS`.
- When `ANALYTICS_ALLOWED_ORIGINS` is provided, only those origins receive CORS headers; otherwise the endpoint is wide open for any origin.

