# Bluff Blitz

Vercel deployment layout:

- `index.html`, `app.js`, `style.css`: static frontend
- `api/ws.js`: Vercel WebSocket Function
- `local-server.js`: local development only

The production deployment must not start a standalone Node server with `listen()`. Vercel owns the HTTP server lifecycle for `api/ws.js`.

## Local

```bash
npm install
npm start
```

## Vercel

Import the repository into Vercel and deploy. WebSocket clients connect to:

```text
wss://YOUR-DOMAIN/api/ws
```

Room state is process-local in this prototype. For multi-instance production scaling, move room state/pub-sub to Redis.
