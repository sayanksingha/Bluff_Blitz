# Bluff Blitz — Vercel WebSocket version

This version is structured for Vercel Functions with WebSocket support.

## Folder structure

```text
Bluff-Blitz/
├── api/
│   └── ws.js
├── public/
│   ├── app.js
│   ├── index.html
│   └── style.css
├── package.json
├── package-lock.json
├── server.js
├── vercel.json
└── README.md
```

## Deploy

1. Import the GitHub repository into Vercel.
2. Keep the project as a Node.js project; no build command is required.
3. Vercel serves files from `public/**` as static assets.
4. Deploy with Fluid Compute enabled.

The browser connects to:

```text
wss://YOUR-DOMAIN/api/ws
```

## Local development

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

For Vercel-like local testing:

```bash
npx vercel dev
```

## Important limitation

Room state is currently stored in memory in `api/ws.js`. This is suitable for testing and small demos, but it is not durable shared state across multiple Function instances. For a larger public game, move room state and cross-instance messaging to Redis or another shared realtime store.

## Why this fixes the previous 500

The old project started a standalone Node server and later called `server.close()` when browsers disconnected. This version:

- exposes the WebSocket endpoint at `/api/ws`;
- does not call `server.close()` when clients disconnect;
- serves the frontend from `public/**`;
- reconnects the browser to `/api/ws` after a dropped connection;
- keeps the existing 2–8 player game flow.
