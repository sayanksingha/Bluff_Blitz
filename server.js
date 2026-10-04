import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, WebSocket } from "ws";

let port = Number(process.env.PORT || 3000);
const ROUNDS = 3;
const ANSWER_MS = 60_000;
const VOTE_MS = 30_000;
const RESULTS_MS = 8_000;
const rooms = new Map();
const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
const id = () => crypto.randomUUID();

function roomCode() { let c; do c = code(); while (rooms.has(c)); return c; }
function send(ws, payload) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }
function player(room, playerId) { return room.players.get(playerId); }
function active(room) { return [...room.players.values()].filter(p => p.connected); }
function host(room) { return player(room, room.hostId); }
function clearTimer(room) { if (room.timer) clearTimeout(room.timer); room.timer = null; }
function phaseTimer(room, ms, callback) { clearTimer(room); room.deadline = Date.now() + ms; room.timer = setTimeout(callback, ms); }
function publicState(room, recipient) {
  const p = player(room, recipient);
  const base = {
    type: "STATE", code: room.code, phase: room.phase, hostId: room.hostId,
    players: [...room.players.values()].map(x => ({ id: x.id, name: x.name, score: x.score, connected: x.connected })),
    round: room.round, totalRounds: ROUNDS, deadline: room.deadline || null,
    self: p && { id: p.id, name: p.name, submitted: room.answers?.has(recipient) || false, voted: room.votes?.has(recipient) || false }
  };
  if (["ANSWERING", "VOTING", "RESULTS"].includes(room.phase)) base.prompt = room.prompt.question;
  if (room.phase === "VOTING") base.answers = room.options.map(a => ({ id: a.id, text: a.text }));
  if (room.phase === "RESULTS" || room.phase === "FINAL_RESULTS") {
    base.correctAnswer = room.prompt.answer;
    base.options = room.options.map(a => ({ id: a.id, text: a.text, owner: a.owner === "REAL" ? "REAL ANSWER" : player(room, a.owner)?.name, votes: [...room.votes.values()].filter(v => v === a.id).length }));
    base.roundDeltas = room.roundDeltas;
  }
  if (room.phase === "FINAL_RESULTS") base.winners = [...room.players.values()].filter(x => x.score === Math.max(...[...room.players.values()].map(q => q.score))).map(x => x.name);
  return base;
}
function broadcast(room) { for (const p of room.players.values()) if (p.ws) send(p.ws, publicState(room, p.id)); }
function error(ws, message) { send(ws, { type: "ERROR", message }); }
function transitionToVoting(room) {
  if (room.phase !== "ANSWERING") return;
  clearTimer(room); room.phase = "VOTING";
  room.options = [{ id: id(), text: room.prompt.answer, owner: "REAL" }, ...[...room.answers.entries()].map(([owner, text]) => ({ id: id(), text, owner }))]
    .sort(() => Math.random() - .5);
  phaseTimer(room, VOTE_MS, () => finishRound(room)); broadcast(room);
}
function finishRound(room) {
  if (room.phase !== "VOTING") return;
  clearTimer(room); room.phase = "RESULTS"; room.roundDeltas = {};
  for (const p of room.players.values()) room.roundDeltas[p.id] = 0;
  const correct = room.options.find(a => a.owner === "REAL");
  for (const [voter, chosen] of room.votes) {
    const option = room.options.find(a => a.id === chosen);
    if (option?.id === correct.id) { player(room, voter).score += 2; room.roundDeltas[voter] += 2; }
    else if (option && option.owner !== "REAL") { player(room, option.owner).score += 1; room.roundDeltas[option.owner] += 1; }
  }
  phaseTimer(room, RESULTS_MS, () => room.round >= ROUNDS ? final(room) : startRound(room)); broadcast(room);
}
function startRound(room) {
  clearTimer(room); room.round += 1; room.phase = "ANSWERING"; room.answers = new Map(); room.votes = new Map(); room.options = [];
  room.prompt = { question: "The secret number is between 1 and 100. Which number is real?", answer: String(Math.floor(Math.random() * 100) + 1) };
  room.roundDeltas = {}; phaseTimer(room, ANSWER_MS, () => transitionToVoting(room)); broadcast(room);
}
function final(room) { clearTimer(room); room.phase = "FINAL_RESULTS"; room.deadline = null; broadcast(room); }
function resetLobby(room) { clearTimer(room); room.phase = "LOBBY"; room.round = 0; room.deadline = null; for (const p of room.players.values()) p.score = 0; broadcast(room); }
function maybeAnswersDone(room) { const a = active(room); if (a.length && a.every(p => room.answers.has(p.id))) transitionToVoting(room); }
function maybeVotesDone(room) { const a = active(room); if (a.length && a.every(p => room.votes.has(p.id))) finishRound(room); }
function assignHost(room) { if (!host(room)?.connected) room.hostId = active(room)[0]?.id || [...room.players.keys()][0]; }

const server = createServer(async (req, res) => {
  const requested = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const file = normalize(join(process.cwd(), "public", requested));
  if (!file.startsWith(join(process.cwd(), "public"))) { res.writeHead(403).end(); return; }
  try { const data = await readFile(file); const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }; res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(data); }
  catch { res.writeHead(404).end("Not found"); }
});
const wss = new WebSocketServer({ server });
let activeBrowsers = 0;
let hadBrowserConnection = false;
let shutdownTimer = null;
function scheduleShutdownWhenUnused() {
  if (shutdownTimer || !hadBrowserConnection || activeBrowsers > 0) return;
  shutdownTimer = setTimeout(() => {
    shutdownTimer = null;
    if (activeBrowsers > 0) return;
    console.log("No game browsers are connected. Releasing the local port.");
    server.close();
  }, 5_000);
}
wss.on("error", err => {
  // The HTTP server retries an automatically selected port below. The WebSocket
  // server reports the same temporary EADDRINUSE error, so consume only that case.
  if (err.code !== "EADDRINUSE" || process.env.PORT) throw err;
});
wss.on("connection", ws => {
  hadBrowserConnection = true;
  activeBrowsers += 1;
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
  ws.on("message", raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return error(ws, "Invalid message."); }
    const room = rooms.get(msg.code); const p = room && player(room, msg.playerId);
    if (msg.type === "CREATE") {
      const name = String(msg.name || "").trim().slice(0, 20); if (!name) return error(ws, "Choose a display name.");
      const c = roomCode(), pid = id(), r = { code: c, phase: "LOBBY", players: new Map(), hostId: pid, round: 0 };
      r.players.set(pid, { id: pid, name, score: 0, connected: true, ws }); rooms.set(c, r); send(ws, { type: "JOINED", code: c, playerId: pid }); broadcast(r); return;
    }
    if (msg.type === "JOIN") {
      const r = rooms.get(String(msg.code || "").toUpperCase()), name = String(msg.name || "").trim().slice(0, 20);
      if (!r) return error(ws, "Room not found."); if (r.phase !== "LOBBY") return error(ws, "This game has already started."); if (r.players.size >= 8) return error(ws, "This room is full."); if (!name) return error(ws, "Choose a display name.");
      const pid = id(); r.players.set(pid, { id: pid, name, score: 0, connected: true, ws }); send(ws, { type: "JOINED", code: r.code, playerId: pid }); broadcast(r); return;
    }
    if (msg.type === "RECONNECT" && (!room || !p)) { send(ws, { type: "SESSION_EXPIRED" }); return; }
    if (!room || !p) return error(ws, "Session expired. Rejoin the room.");
    if (msg.type === "RECONNECT") { p.ws = ws; p.connected = true; send(ws, { type: "JOINED", code: room.code, playerId: p.id }); broadcast(room); return; }
    if (msg.type === "START") { if (room.hostId !== p.id) return error(ws, "Only the host can start."); if (active(room).length < 2) return error(ws, "At least two players are needed."); startRound(room); return; }
    if (msg.type === "ANSWER") { const text = String(msg.answer || "").trim(); const number = Number(text); if (room.phase !== "ANSWERING") return error(ws, "Answering is closed."); if (room.answers.has(p.id)) return error(ws, "Answer already submitted."); if (!Number.isInteger(number) || number < 1 || number > 100) return error(ws, "Enter a whole number from 1 to 100."); room.answers.set(p.id, String(number)); maybeAnswersDone(room); broadcast(room); return; }
    if (msg.type === "VOTE") { if (room.phase !== "VOTING") return error(ws, "Voting is closed."); if (room.votes.has(p.id)) return error(ws, "Vote already submitted."); const opt = room.options.find(a => a.id === msg.answerId); if (!opt) return error(ws, "Choose a valid answer."); if (opt.owner === p.id) return error(ws, "You cannot vote for your own answer."); room.votes.set(p.id, opt.id); maybeVotesDone(room); broadcast(room); return; }
    if (msg.type === "PLAY_AGAIN") { if (room.hostId !== p.id) return error(ws, "Only the host can restart."); resetLobby(room); }
  });
  ws.on("close", () => { activeBrowsers = Math.max(0, activeBrowsers - 1); for (const room of rooms.values()) for (const p of room.players.values()) if (p.ws === ws) { p.connected = false; assignHost(room); broadcast(room); if (room.phase === "ANSWERING") maybeAnswersDone(room); if (room.phase === "VOTING") maybeVotesDone(room); } scheduleShutdownWhenUnused(); });
});
server.on("error", err => {
  if (err.code === "EADDRINUSE" && !process.env.PORT) {
    port += 1;
    console.log(`Port ${port - 1} is already in use; trying http://localhost:${port}`);
    server.listen(port);
    return;
  }
  throw err;
});
server.on("listening", () => console.log(`Bluff Blitz is ready at http://localhost:${port}`));
server.listen(port);
