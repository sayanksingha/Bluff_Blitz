// Local development only. Vercel does not execute this file as the production server.
import server from './api/ws.js';

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`Bluff Blitz local server: http://localhost:${port}`);
});
