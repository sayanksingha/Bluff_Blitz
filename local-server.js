// Local development server only. Vercel uses api/ws.js directly.
import server from './api/ws.js';

const port = Number(process.env.PORT || 3000);

server.listen(port, () => {
  console.log(`Bluff Blitz local server: http://localhost:${port}`);
});
