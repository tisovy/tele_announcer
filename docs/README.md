# Documentation

This directory captures the context you need to operate, deploy, and extend Tele Announcer.

- `architecture.md`: Explains how the Telegram bot, Binance websocket, Redis state, analytics, and activity tracker collaborate.
- `api.md`: Describes the `/analytics` routes and how to interact with them securely.

## Security

- `server.js` (lines 19-20) defines `USER_LIST`/`USER_SU`, so only whitelisted chats can configure the bot.
- The analytics router additionally requires HMAC-signed `X-Analytics-*` headers when `ANALYTICS_API_KEY`/`ANALYTICS_API_SECRET` are set; see `README.md` for the header format.
