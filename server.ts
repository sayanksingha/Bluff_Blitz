import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const ROUNDS = 3;
const ANSWER_MS = 60_000;
const VOTE_MS = 30_000;
const RESULTS_MS = 8_000;

const rooms = new Map();
const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const root = process.cwd();

const code = () =>
  Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");

const id = () => crypto.randomUUID();

function roomCode() {
  let c;
  do c = code(); while (rooms.has(c));
  return c;
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function player(room, playerId) {
  return room?.players.get(playerId);
}

function active(room) {
  return [...room.players.values()].filter((p) => p.connected);
}

function host(room) {
  return player(room, room.hostId);
}

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function phaseTimer(room, ms, callback) {
  clearTimer(room);
  room.deadline = Date.now() + ms;
  room.timer = setTimeout(callback, ms);
}

function publicState(room, recipient) {
  const p = player(room, recipient);
  const base = {
    type: "STATE",
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: [...room.players.values()].map((x) => ({
      id: x.id,
      name: x.name,
      score: x.score,
      connected: x.connected,
    })),
    round: room.round,
    totalRounds: ROUNDS,
    deadline: room.deadline || null,
    self: p
      ? {
          id: p.id,
          name: p.name,
          submitted: room.answers.has(recipient),
          voted: room.votes.has(recipient),
        }
      : null,
  };

  if (["ANSWERING", "VOTING", "RESULTS"].includes(room.phase)) {
    base.prompt = room.prompt.question;
  }

  if (room.phase === "VOTING") {
    base.answers = room.options.map((a) => ({ id: a.id, text: a.text }));
  }

  if (room.phase === "RESULTS" || room.phase === "FINAL_RESULTS") {
    base.correctAnswer = room.prompt.answer;
    base.options = room.options.map((a) => ({
      id: a.id,
      text: a.text,
      owner: a.owner === "REAL" ? "REAL ANSWER" : player(room, a.owner)?.name ?? "PLAYER",
      votes: [...room.votes.values()].filter((v) => v === a.id).length,
    }));
    base.roundDeltas = room.roundDeltas;
  }

  if (room.phase === "FINAL_RESULTS") {
    const scores = [...room.players.values()].map((q) => q.score);
    const high = scores.length ? Math.max(...scores) : 0;
    base.winners = [...room.players.values()]
      .filter((x) => x.score === high)
      .map((x) => x.name);
  }

  return base;
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.ws) send(p.ws, publicState(room, p.id));
  }
}

function error(ws, message) {
  send(ws, { type: "ERROR", message });
}

function transitionToVoting(room) {
  if (room.phase !== "ANSWERING") return;

  clearTimer(room);
  room.phase = "VOTING";
  room.options = [
    { id: id(), text: room.prompt.answer, owner: "REAL" },
    ...[...room.answers.entries()].map(([owner, text]) => ({
      id: id(),
      text,
      owner,
    })),
  ].sort(() => Math.random() - 0.5);

  phaseTimer(room, VOTE_MS, () => finishRound(room));
  broadcast(room);
}

function finishRound(room) {
  if (room.phase !== "VOTING") return;

  clearTimer(room);
  room.phase = "RESULTS";
  room.roundDeltas = {};

  for (const p of room.players.values()) room.roundDeltas[p.id] = 0;

  const correct = room.options.find((a) => a.owner === "REAL");

  for (const [voter, chosen] of room.votes) {
    const option = room.options.find((a) => a.id === chosen);
    if (!option || !correct) continue;

    if (option.id === correct.id) {
      player(room, voter).score += 2;
      room.roundDeltas[voter] += 2;
    } else if (option.owner !== "REAL") {
      player(room, option.owner).score += 1;
      room.roundDeltas[option.owner] += 1;
    }
  }

  phaseTimer(room, RESULTS_MS, () =>
    room.round >= ROUNDS ? final(room) : startRound(room),
  );
  broadcast(room);
}

function startRound(room) {
  clearTimer(room);
  room.round += 1;
  room.phase = "ANSWERING";
  room.answers = new Map();
  room.votes = new Map();
  room.options = [];
  room.prompt = {
    question: "The secret number is between 1 and 100. Which number is real?",
    answer: String(Math.floor(Math.random() * 100) + 1),
  };
  room.roundDeltas = {};
  phaseTimer(room, ANSWER_MS, () => transitionToVoting(room));
  broadcast(room);
}

function final(room) {
  clearTimer(room);
  room.phase = "FINAL_RESULTS";
  room.deadline = null;
  broadcast(room);
}

function resetLobby(room) {
  clearTimer(room);
  room.phase = "LOBBY";
  room.round = 0;
  room.deadline = null;
  room.answers = new Map();
  room.votes = new Map();
  room.options = [];
  room.roundDeltas = {};
  for (const p of room.players.values()) p.score = 0;
  broadcast(room);
}

function maybeAnswersDone(room) {
  const a = active(room);
  if (a.length && a.every((p) => room.answers.has(p.id))) transitionToVoting(room);
}

function maybeVotesDone(room) {
  const a = active(room);
  if (a.length && a.every((p) => room.votes.has(p.id))) finishRound(room);
}

function assignHost(room) {
  if (!host(room)?.connected) {
    room.hostId = active(room)[0]?.id || [...room.players.keys()][0];
  }
}

function contentType(pathname) {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  return "text/plain; charset=utf-8";
}

async function serveStatic(req, res) {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const requested = pathname === "/" ? "/index.html" : pathname;

  const allowed = new Set(["/index.html", "/app.js", "/style.css"]);
  if (!allowed.has(requested)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  try {
    const file = await readFile(resolve(root, requested.slice(1)));
    res.writeHead(200, {
      "Content-Type": contentType(requested),
      "Cache-Control": "no-cache",
    });
    res.end(file);
  } catch (err) {
    console.error("Static file error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to load application" }));
  }
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "bluff-blitz" }));
    return;
  }

  serveStatic(req, res);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return error(ws, "Invalid message.");
    }

    const room = rooms.get(String(msg.code || "").toUpperCase());
    const p = room && player(room, msg.playerId);

    if (msg.type === "CREATE") {
      const name = String(msg.name || "").trim().slice(0, 20);
      if (!name) return error(ws, "Choose a display name.");

      const c = roomCode();
      const pid = id();
      const r = {
        code: c,
        phase: "LOBBY",
        players: new Map(),
        hostId: pid,
        round: 0,
        answers: new Map(),
        votes: new Map(),
        options: [],
        roundDeltas: {},
        deadline: null,
        timer: null,
      };

      r.players.set(pid, {
        id: pid,
        name,
        score: 0,
        connected: true,
        ws,
      });

      rooms.set(c, r);
      send(ws, { type: "JOINED", code: c, playerId: pid });
      broadcast(r);
      return;
    }

    if (msg.type === "JOIN") {
      const r = rooms.get(String(msg.code || "").toUpperCase());
      const name = String(msg.name || "").trim().slice(0, 20);

      if (!r) return error(ws, "Room not found.");
      if (r.phase !== "LOBBY") return error(ws, "This game has already started.");
      if (r.players.size >= 8) return error(ws, "This room is full.");
      if (!name) return error(ws, "Choose a display name.");

      const pid = id();
      r.players.set(pid, {
        id: pid,
        name,
        score: 0,
        connected: true,
        ws,
      });

      send(ws, { type: "JOINED", code: r.code, playerId: pid });
      broadcast(r);
      return;
    }

    if (msg.type === "RECONNECT" && (!room || !p)) {
      send(ws, { type: "SESSION_EXPIRED" });
      return;
    }

    if (!room || !p) return error(ws, "Session expired. Rejoin the room.");

    if (msg.type === "RECONNECT") {
      p.ws = ws;
      p.connected = true;
      send(ws, { type: "JOINED", code: room.code, playerId: p.id });
      broadcast(room);
      return;
    }

    if (msg.type === "START") {
      if (room.hostId !== p.id) return error(ws, "Only the host can start.");
      if (active(room).length < 2) return error(ws, "At least two players are needed.");
      startRound(room);
      return;
    }

    if (msg.type === "ANSWER") {
      const text = String(msg.answer || "").trim();
      const number = Number(text);

      if (room.phase !== "ANSWERING") return error(ws, "Answering is closed.");
      if (room.answers.has(p.id)) return error(ws, "Answer already submitted.");
      if (!Number.isInteger(number) || number < 1 || number > 100) {
        return error(ws, "Enter a whole number from 1 to 100.");
      }

      room.answers.set(p.id, String(number));
      maybeAnswersDone(room);
      broadcast(room);
      return;
    }

    if (msg.type === "VOTE") {
      if (room.phase !== "VOTING") return error(ws, "Voting is closed.");
      if (room.votes.has(p.id)) return error(ws, "Vote already submitted.");

      const opt = room.options.find((a) => a.id === msg.answerId);
      if (!opt) return error(ws, "Choose a valid answer.");
      if (opt.owner === p.id) return error(ws, "You cannot vote for your own answer.");

      room.votes.set(p.id, opt.id);
      maybeVotesDone(room);
      broadcast(room);
      return;
    }

    if (msg.type === "PLAY_AGAIN") {
      if (room.hostId !== p.id) return error(ws, "Only the host can restart.");
      resetLobby(room);
    }
  });

  ws.on("close", () => {
    for (const room of rooms.values()) {
      for (const p of room.players.values()) {
        if (p.ws === ws) {
          p.connected = false;
          assignHost(room);
          broadcast(room);
          if (room.phase === "ANSWERING") maybeAnswersDone(room);
          if (room.phase === "VOTING") maybeVotesDone(room);
        }
      }
    }
  });
});

wss.on("error", (err) => {
  console.error("Bluff Blitz WebSocket server error:", err);
});

server.listen(Number(process.env.PORT || 3000), () => {
  console.log("Bluff Blitz server ready");
});
