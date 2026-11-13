"use strict";

/* =========================================================
   HAMMER HALL — ONE FILE, NO NPM PACKAGES (rectified)

   Requirements: Node.js 18+
   Run:          node server.js
   Open:         http://localhost:3000

   Environment variables (all optional):
     PORT            default 3000
     ALLOWED_ORIGIN  e.g. https://yoursite.com
                     (only needed if your web page is hosted on a
                      DIFFERENT domain from this Node server)
     API_BASE        e.g. https://auction.yoursite.com
                     (same situation: tells the page where the
                      server lives. Leave empty if Node serves the page)

   Host behind a reverse proxy? Turn buffering off for SSE
   (see nginx notes in the chat reply).
   ========================================================= */

const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const API_BASE = (process.env.API_BASE || "").replace(/\/+$/, "");

const MAX_OWNERS = 8;
const SQUAD_SIZE = 15;
const START_PURSE = 120;
const MIN_PRICE = 0.5;

const rooms = new Map();

const COLOURS = [
  "#ff754d", "#38caff", "#ffd54c", "#82f48c",
  "#bf86ff", "#ff77b7", "#52e8c5", "#ffae45"
];

const BOT_NAMES = [
  "Royal Cobras", "Silver Falcons", "Thunder Wolves", "Desert Storm",
  "Neon Titans", "Coastal Kings", "Iron Panthers", "Golden Hawks"
];

const roundMoney = value => Math.round(value * 100) / 100;

const slotsNeeded = team => Math.max(0, SQUAD_SIZE - team.squad.length);

const money = value =>
  Number(value || 0).toFixed(2).replace(/\.?0+$/, "") + " Cr";

function safeMaximum(team) {
  if (!slotsNeeded(team)) return 0;
  return Math.max(
    0,
    roundMoney(team.budget - (slotsNeeded(team) - 1) * MIN_PRICE)
  );
}

function qualified(team) {
  return team.squad.length === SQUAD_SIZE && team.budget >= -0.00001;
}

function increment(value) {
  return value < 5 ? 0.25 : value < 10 ? 0.5 : value < 20 ? 1 : 2;
}

function nextBid(room) {
  return room.leader
    ? roundMoney(room.price + increment(room.price))
    : room.price;
}

function canBid(team, value) {
  return slotsNeeded(team) > 0 && value <= safeMaximum(team) + 0.00001;
}

function franchiseName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 22 || /[\u0000-\u001f\u007f]/.test(name)) {
    return null;
  }
  return name;
}

/* ================= TEAMS AND ROOMS ================= */

function createTeam(name, seat, bot) {
  return {
    id: crypto.randomBytes(10).toString("hex"),
    token: bot ? null : crypto.randomBytes(24).toString("hex"),

    name,
    seat,
    playerLabel: "Player " + (seat + 1),
    colour: COLOURS[seat],

    bot,
    ready: bot,
    connected: bot,
    stream: null,

    lastBidAt: 0,
    lastReviewAt: 0,

    budget: START_PURSE,
    squad: []
  };
}

function createRoom(solo) {
  let code;
  do {
    code = String(crypto.randomInt(100000, 1000000));
  } while (rooms.has(code));

  const room = {
    code,
    solo,
    hostId: null,
    teams: [],

    phase: "lobby",
    round: 1,

    queue: [],
    index: 0,
    current: null,

    price: 0,
    leader: null,

    deadline: 0,
    nextAt: 0,
    lastBotAt: 0,

    completed: 0,
    soldCount: 0,
    unsold: [],
    log: [],

    reviewIndex: 0,
    reviewAt: 0,
    finalReview: false,

    speechSequence: 0,
    lastSpeech: "",

    notice: "Waiting for the creator to start.",
    lastActive: Date.now()
  };

  rooms.set(code, room);
  return room;
}

function publicState(room) {
  const humanOwners = room.teams.filter(team => !team.bot);

  return {
    code: room.code,
    solo: room.solo,
    hostId: room.hostId,

    phase: room.phase,
    round: room.round,

    current: room.current,
    leader: room.leader,
    price: room.price,
    nextBid: nextBid(room),

    deadline: room.deadline,
    serverNow: Date.now(),

    completed: room.completed,
    soldCount: room.soldCount,
    unsold: room.unsold,
    log: room.log.slice(0, 12),

    position: room.current ? room.index + 1 : room.index,
    total: room.queue.length,

    reviewIndex: room.reviewIndex,
    finalReview: room.finalReview,

    speechSequence: room.speechSequence,
    lastSpeech: room.lastSpeech,

    notice: room.notice,

    allReady: humanOwners.every(
      team => team.connected && (team.id === room.hostId || team.ready)
    ),

    teams: room.teams.map(team => ({
      id: team.id,
      name: team.name,
      seat: team.seat,
      playerLabel: team.playerLabel,
      colour: team.colour,

      bot: team.bot,
      ready: team.ready,
      connected: team.connected,

      budget: team.budget,
      squad: team.squad,

      needed: slotsNeeded(team),
      maxBid: safeMaximum(team),
      qualified: qualified(team)
    }))
  };
}

/* ================= REAL-TIME STREAMS ================= */

function sendEvent(response, event, data) {
  if (!response || response.destroyed || response.writableEnded) return;
  response.write(
    "event: " + event + "\n" + "data: " + JSON.stringify(data) + "\n\n"
  );
}

function broadcast(room) {
  const state = publicState(room);
  for (const team of room.teams) {
    if (!team.bot && team.stream) sendEvent(team.stream, "state", state);
  }
}

function narrate(room, text) {
  room.speechSequence++;
  room.lastSpeech = text;
}

function ownerSession(code, token) {
  const room = rooms.get(String(code || ""));
  if (!room) return null;
  if (typeof token !== "string" || token.length > 100) return null;

  const team = room.teams.find(item => !item.bot && item.token === token);
  return team ? { room, team } : null;
}

/* ================= FICTIONAL PLAYER POOL ================= */

function generatePlayers() {
  const firstNames = [
    "Arjun", "Kabir", "Ishaan", "Rohan", "Zane", "Dev",
    "Tariq", "Leo", "Nikhil", "Sameer", "Ayaan", "Kian",
    "Aditya", "Vihaan", "Noah", "Omar", "Ethan", "Rehan",
    "Lucas", "Aryan", "Neel", "Finn", "Yusuf", "Dylan",
    "Harsh", "Ryan", "Imran", "Aarav", "Theo", "Sahil"
  ];

  const surnames = ["Veer", "Rao", "Mehta", "Das"];

  const roles = [
    "Batter", "Fast bowler", "All-rounder",
    "Wicketkeeper", "Spinner", "Opener"
  ];

  const players = Array.from({ length: MAX_OWNERS * SQUAD_SIZE }, (_, i) => ({
    id: "P" + (i + 1),

    name:
      firstNames[i % firstNames.length] + " " +
      surnames[Math.floor(i / firstNames.length)],

    role: roles[i % roles.length],
    base: MIN_PRICE,

    age: 20 + Math.floor(Math.random() * 14),
    rating: 65 + Math.floor(Math.random() * 34),

    matches: 20 + Math.floor(Math.random() * 160),
    runs: 300 + Math.floor(Math.random() * 4000),
    wickets: 5 + Math.floor(Math.random() * 150),

    strikeRate: roundMoney(115 + Math.random() * 45),
    economy: roundMoney(6 + Math.random() * 3),

    value: roundMoney(3 + Math.random() * 11),
    colour: COLOURS[i % COLOURS.length]
  }));

  for (let i = players.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [players[i], players[j]] = [players[j], players[i]];
  }

  return players;
}

/* ================= AUCTION ENGINE ================= */

function launchAuction(room) {
  if (room.phase !== "lobby") return;

  while (room.teams.length < MAX_OWNERS) {
    const seat = room.teams.length;
    room.teams.push(createTeam(BOT_NAMES[seat], seat, true));
  }

  room.queue = generatePlayers();
  room.index = 0;

  beginLot(room);
}

function startProblem(room, fillBots) {
  if (room.phase !== "lobby") return "This auction has already started.";

  const humans = room.teams.filter(team => !team.bot);

  if (humans.some(team => !team.connected)) {
    return "A joined owner is disconnected. Wait for them to reconnect.";
  }

  if (humans.some(team => team.id !== room.hostId && !team.ready)) {
    return "Wait until every guest presses Ready.";
  }

  if (!fillBots && humans.length !== MAX_OWNERS) {
    return "You need eight human owners, or enable bots for empty seats.";
  }

  return null;
}

function beginLot(room) {
  if (room.index >= room.queue.length) {
    finishRound(room);
    return;
  }

  room.phase = "live";
  room.current = room.queue[room.index];

  room.leader = null;
  room.price = room.current.base;

  room.deadline = Date.now() + 10000;
  room.lastBotAt = Date.now();

  room.notice = room.round === 1 ? "Main auction" : "Unsold-player round";

  narrate(
    room,
    "Next player, " + room.current.name + ". " +
    room.current.role + ". Base price, half a crore."
  );

  broadcast(room);
}

function acceptBid(room, team) {
  if (
    room.phase !== "live" ||
    !room.current ||
    Date.now() >= room.deadline ||
    room.leader === team.id
  ) {
    return false;
  }

  const value = nextBid(room);
  if (!canBid(team, value)) return false;

  room.price = value;
  room.leader = team.id;
  room.deadline = Date.now() + 6500;

  broadcast(room);
  return true;
}

function closeLot(room) {
  const player = room.current;
  if (!player || room.phase !== "live") return;

  const winner = room.teams.find(team => team.id === room.leader);

  if (winner) {
    winner.budget = roundMoney(winner.budget - room.price);
    winner.squad.push({ ...player, price: room.price });

    room.unsold = room.unsold.filter(item => item.id !== player.id);
    room.soldCount++;

    room.notice =
      player.name + " sold to " + winner.name + " for " + money(room.price) + ".";
  } else {
    if (!room.unsold.some(item => item.id === player.id)) {
      room.unsold.push(player);
    }
    room.notice = player.name + " is unsold.";
  }

  room.log.unshift(room.notice);
  room.log = room.log.slice(0, 25);

  room.completed++;
  room.phase = "result";
  room.nextAt = Date.now() + 2100;

  narrate(room, room.notice);
  broadcast(room);
}

function afterLot(room) {
  room.index++;

  room.current = null;
  room.leader = null;
  room.price = 0;

  if (room.index >= room.queue.length) {
    finishRound(room);
  } else if (room.completed % 2 === 0) {
    startReview(room, false);
  } else {
    beginLot(room);
  }
}

function finishRound(room) {
  room.current = null;
  room.leader = null;

  if (
    room.round === 1 &&
    room.unsold.length > 0 &&
    room.teams.some(team => slotsNeeded(team) > 0)
  ) {
    room.phase = "roundbreak";
    room.notice = "Main round complete. Unsold players return in round two.";
    room.nextAt = Date.now() + 6500;

    narrate(room, room.notice);
    broadcast(room);
  } else {
    startReview(room, true);
  }
}

/* ================= TEAM REVIEWS ================= */

function announceReview(room) {
  const team = room.teams[room.reviewIndex];
  if (!team) return;

  narrate(
    room,
    team.playerLabel + ". " +
    team.name + ". " +
    team.squad.length + " players bought. " +
    team.budget + " crore remaining. " +
    slotsNeeded(team) + " players required." +
    (room.finalReview ? (qualified(team) ? " Qualified." : " Disqualified.") : "")
  );
}

function startReview(room, final) {
  room.phase = final ? "finalreview" : "review";
  room.finalReview = final;
  room.reviewIndex = 0;
  room.reviewAt = Date.now() + 4200;

  room.notice = final
    ? "Final qualification review"
    : "Two players completed — team review";

  announceReview(room);
  broadcast(room);
}

function advanceReview(room, finishAll) {
  if (!["review", "finalreview"].includes(room.phase)) return;

  room.reviewIndex = finishAll ? room.teams.length : room.reviewIndex + 1;

  if (room.reviewIndex >= room.teams.length) {
    if (room.finalReview) {
      room.phase = "finished";
      room.current = null;
      room.notice = "Auction complete.";

      narrate(
        room,
        "The auction is complete. Please review the final qualification table."
      );

      broadcast(room);
    } else {
      beginLot(room);
    }
    return;
  }

  room.reviewAt = Date.now() + 4200;

  announceReview(room);
  broadcast(room);
}

/* ================= HTTP HELPERS ================= */

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let failed = false;

    request.on("data", chunk => {
      if (failed) return;
      bytes += chunk.length;

      if (bytes > 12000) {
        failed = true;
        reject(new Error("Request is too large."));
        return;
      }

      body += chunk.toString("utf8");
    });

    request.on("end", () => {
      if (failed) return;
      try {
        const data = JSON.parse(body || "{}");
        resolve(
          data && typeof data === "object" && !Array.isArray(data) ? data : {}
        );
      } catch (_) {
        reject(new Error("Invalid request data."));
      }
    });

    request.on("error", reject);
  });
}

function detachOwner(room, team, explicit) {
  const stream = team.stream;

  team.stream = null;
  team.connected = false;
  team.ready = false;

  if (stream && !stream.writableEnded) stream.end();

  room.lastActive = Date.now();

  if (explicit && room.phase === "lobby") {
    if (room.hostId === team.id) {
      for (const owner of room.teams) {
        if (owner.stream) {
          sendEvent(owner.stream, "roomClosed", {
            message: "The creator closed the lobby."
          });
          owner.stream.end();
          owner.stream = null;
          owner.connected = false;
        }
      }

      rooms.delete(room.code);
      return;
    }

    room.teams = room.teams.filter(owner => owner.id !== team.id);

    room.teams.forEach((owner, index) => {
      owner.seat = index;
      owner.playerLabel = "Player " + (index + 1);
      owner.colour = COLOURS[index];
    });
  }

  broadcast(room);
}

/* ================= API ================= */

async function handleApi(request, response, pathname) {
  let data;

  try {
    data = await readBody(request);
  } catch (error) {
    json(response, 400, { error: error.message });
    return;
  }

  if (pathname === "/api/create" || pathname === "/api/solo") {
    const name = franchiseName(data.name);

    if (!name) {
      json(response, 400, {
        error: "Enter a franchise name containing 2 to 22 characters."
      });
      return;
    }

    if (rooms.size >= 200) {
      json(response, 503, {
        error: "Server room limit reached. Try again later."
      });
      return;
    }

    const solo = pathname === "/api/solo";

    const room = createRoom(solo);
    const team = createTeam(name, 0, false);

    team.ready = true;

    room.teams.push(team);
    room.hostId = team.id;

    json(response, 200, {
      code: room.code,
      token: team.token,
      teamId: team.id,
      solo,
      created: !solo
    });

    if (solo) launchAuction(room);
    return;
  }

  if (pathname === "/api/join") {
    const name = franchiseName(data.name);
    const code = String(data.code || "").trim();

    if (!name) {
      json(response, 400, {
        error: "Enter your franchise name first, using 2 to 22 characters."
      });
      return;
    }

    if (!/^\d{6}$/.test(code)) {
      json(response, 400, {
        error: "Enter the six-digit numeric room code."
      });
      return;
    }

    const existing = ownerSession(code, data.token);

    if (existing) {
      json(response, 200, {
        code,
        token: existing.team.token,
        teamId: existing.team.id,
        solo: existing.room.solo,
        created: false
      });
      return;
    }

    const room = rooms.get(code);

    if (!room) {
      json(response, 404, { error: "No room has that code." });
      return;
    }

    if (room.solo) {
      json(response, 403, { error: "This is a private solo game." });
      return;
    }

    if (room.phase !== "lobby") {
      json(response, 409, {
        error: "The auction has started. New owners cannot join."
      });
      return;
    }

    if (room.teams.length >= MAX_OWNERS) {
      json(response, 409, { error: "Room full: maximum eight owners." });
      return;
    }

    if (room.teams.some(t => t.name.toLowerCase() === name.toLowerCase())) {
      json(response, 409, {
        error: "That franchise name is already used in this room."
      });
      return;
    }

    const team = createTeam(name, room.teams.length, false);

    room.teams.push(team);
    room.lastActive = Date.now();

    json(response, 200, {
      code,
      token: team.token,
      teamId: team.id,
      solo: false,
      created: false
    });

    broadcast(room);
    return;
  }

  const session = ownerSession(data.code, data.token);

  if (!session) {
    json(response, 401, {
      error: "Your owner session is invalid or the room has expired."
    });
    return;
  }

  const { room, team } = session;
  room.lastActive = Date.now();

  if (pathname === "/api/ready") {
    if (room.phase !== "lobby") {
      json(response, 409, {
        error: "Readiness can only change in the lobby."
      });
      return;
    }

    if (team.id !== room.hostId) team.ready = Boolean(data.ready);

    json(response, 200, { ok: true });
    broadcast(room);
    return;
  }

  if (pathname === "/api/start") {
    if (room.hostId !== team.id) {
      json(response, 403, {
        error: "Only the room creator can start the auction."
      });
      return;
    }

    const problem = startProblem(room, Boolean(data.fillBots));

    if (problem) {
      json(response, 409, { error: problem });
      return;
    }

    json(response, 200, { ok: true });
    launchAuction(room);
    return;
  }

  if (pathname === "/api/bid") {
    if (!team.connected) {
      json(response, 409, {
        error: "Reconnect to the room before bidding."
      });
      return;
    }

    const now = Date.now();

    if (now - team.lastBidAt < 180) {
      json(response, 429, { error: "Please wait before bidding again." });
      return;
    }

    team.lastBidAt = now;

    const accepted = acceptBid(room, team);

    json(
      response,
      accepted ? 200 : 409,
      accepted
        ? { ok: true }
        : {
            error:
              "Bid rejected. Check timer, safe maximum bid, and squad limit."
          }
    );
    return;
  }

  if (pathname === "/api/review") {
    if (room.hostId !== team.id) {
      json(response, 403, {
        error: "Only the creator controls the shared review."
      });
      return;
    }

    if (Date.now() - team.lastReviewAt < 350) {
      json(response, 429, { error: "Please wait a moment." });
      return;
    }

    team.lastReviewAt = Date.now();

    advanceReview(room, Boolean(data.finish));

    json(response, 200, { ok: true });
    return;
  }

  if (pathname === "/api/leave") {
    detachOwner(room, team, true);
    json(response, 200, { ok: true });
    return;
  }

  json(response, 404, { error: "Unknown action." });
}

/* ================= SERVER CLOCK ================= */

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    const online = room.teams.some(team => !team.bot && team.connected);

    if (online) {
      room.lastActive = now;
    } else if (now - room.lastActive > 2 * 60 * 60 * 1000) {
      rooms.delete(room.code);
      continue;
    }

    // Waiting lobbies never auto-start.
    if (room.phase === "live") {
      if (now >= room.deadline) {
        closeLot(room);
        continue;
      }

      if (now - room.lastBotAt > 1400) {
        room.lastBotAt = now;

        const amount = nextBid(room);

        const candidates = room.teams.filter(
          team =>
            team.bot &&
            room.leader !== team.id &&
            canBid(team, amount) &&
            amount <=
              Math.min(
                room.current.value,
                (team.budget / Math.max(1, slotsNeeded(team))) * 1.4
              )
        );

        if (candidates.length && Math.random() < 0.4) {
          const team =
            candidates[Math.floor(Math.random() * candidates.length)];
          acceptBid(room, team);
        }
      }
    } else if (room.phase === "result" && now >= room.nextAt) {
      afterLot(room);
    } else if (room.phase === "roundbreak" && now >= room.nextAt) {
      room.round = 2;
      room.queue = room.unsold.slice();
      room.index = 0;

      if (room.completed % 2 === 0) {
        startReview(room, false);
      } else {
        beginLot(room);
      }
    } else if (
      ["review", "finalreview"].includes(room.phase) &&
      now >= room.reviewAt
    ) {
      advanceReview(room, false);
    }
  }
}, 200);

/* ================= STREAM KEEP-ALIVE ================= */

setInterval(() => {
  for (const room of rooms.values()) {
    for (const team of room.teams) {
      if (
        team.stream &&
        !team.stream.destroyed &&
        !team.stream.writableEnded
      ) {
        team.stream.write(": heartbeat\n\n");
      }
    }
  }
}, 15000);

/* ================= COMPLETE BROWSER GAME ================= */

const HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>HAMMER HALL — Solo & Multiplayer</title>

<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet">

<style>
*{box-sizing:border-box}
html,body{
 margin:0;height:100%;overflow:hidden;
 background:#090e25;color:#f5f6ff;
 font-family:"DM Sans",Arial,sans-serif;
}
button,input{font:inherit}
button{
 padding:12px 16px;border:0;border-radius:9px;
 background:#ffd34c;color:#181300;
 font-weight:700;cursor:pointer;
}
button:disabled{opacity:.4;cursor:not-allowed}
.secondary{background:#26365d;color:white}
input{
 width:100%;padding:12px;
 background:#090f24;color:white;
 border:1px solid #ffffff30;
 border-radius:9px;margin:8px 0 14px;
}
input[type=checkbox]{width:auto;margin:0 8px 0 0}
.hide{display:none!important}
.overlay{
 position:fixed;inset:0;z-index:30;
 display:grid;place-items:center;
 padding:16px;
 background:radial-gradient(circle at top,#304577,#090e25);
}
.card{
 background:#0c1530;
 border:1px solid #ffffff25;
 border-radius:18px;padding:24px;
 width:min(780px,100%);
 max-height:94vh;overflow:auto;
}
h1,h2,h3{font-family:Oswald,Impact,sans-serif;margin:0 0 10px}
p,.small{color:#b9c7e6;line-height:1.5}
.small{font-size:12px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.modes{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:15px 0}
.mode{
 background:#ffffff06;padding:17px;
 border:1px solid #ffffff20;border-radius:12px;
}
.mode button{width:100%}
.error{color:#ffb5ad;min-height:22px}
.code{font:700 44px Oswald,monospace;letter-spacing:.18em;color:#ffd34c}
.listrow{padding:9px 0;border-bottom:1px solid #ffffff19;font-size:13px}
.good{color:#9affba}
.warn{color:#ffe29b}
.bad{color:#ffaaaa}
#codeModal{
 position:fixed;inset:0;z-index:50;
 background:#000a;display:grid;place-items:center;padding:20px;
}
#codeModal .card{width:min(460px,100%);text-align:center}
#gl{position:fixed;inset:0;width:100%;height:100%;touch-action:none}
#top{
 position:fixed;left:10px;right:10px;top:10px;
 z-index:8;display:flex;justify-content:space-between;
 gap:8px;flex-wrap:wrap;
}
#top>div{
 background:#081025dd;border:1px solid #ffffff22;
 padding:9px;border-radius:10px;
}
#bottom{
 position:fixed;left:0;right:0;bottom:0;z-index:8;
 padding:25px 14px calc(14px + env(safe-area-inset-bottom,0px));
 background:linear-gradient(transparent,#000e 40%);
}
.hud{
 display:flex;gap:12px;justify-content:space-between;
 align-items:center;flex-wrap:wrap;
}
.big{font:700 24px Oswald,Impact,sans-serif}
small{display:block;font-size:11px;color:#b9c7e6}
#side{
 position:fixed;right:10px;top:90px;z-index:15;
 background:#0b1430f5;border:1px solid #ffffff30;
 border-radius:12px;padding:16px;
 width:min(350px,calc(100vw - 20px));
 max-height:64vh;overflow:auto;
}
#review{
 position:fixed;left:50%;bottom:15px;
 transform:translateX(-50%);z-index:20;
 width:min(660px,calc(100vw - 20px));
}
.reviewcard{
 background:#09132df5;border:1px solid var(--team,#ffd34c);
 padding:18px;border-radius:15px;
 animation:enter .4s ease both;
}
@keyframes enter{
 from{opacity:0;transform:translateY(20px)}
 to{opacity:1;transform:translateY(0)}
}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}
.stat{padding:10px 7px;background:#ffffff08;border-radius:9px}
.stat b{font:700 23px Oswald,Impact,sans-serif}
.bar{height:6px;background:#ffffff18;border-radius:20px;overflow:hidden;margin:12px 0}
.bar span{display:block;height:100%;width:0;transition:width .8s;background:var(--team)}
.roster{max-height:130px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
td,th{text-align:left;padding:8px 5px;border-bottom:1px solid #ffffff20}
#toast{
 position:fixed;left:50%;top:90px;transform:translateX(-50%);
 z-index:70;background:#30213b;border:1px solid #ffbd80;
 padding:12px 18px;border-radius:9px;max-width:90vw;
}
@media(max-width:600px){
 .modes{grid-template-columns:1fr}
 .card{padding:18px}
 #top button{font-size:11px;padding:8px}
 .big{font-size:18px}
 .stat b{font-size:18px}
 .roster{max-height:100px}
}
@media(prefers-reduced-motion:reduce){
 .reviewcard{animation:none}
 .bar span{transition:none}
}
</style>
</head>

<body>
<canvas id="gl"></canvas>

<section id="home" class="overlay">
 <div class="card">
  <h1>HAMMER HALL</h1>
  <p>Enter your franchise name first, then choose a mode.</p>

  <form id="nameForm">
   <label for="name">FRANCHISE NAME — REQUIRED</label>
   <input id="name" required minlength="2" maxlength="22" placeholder="Kolkata Comets">
   <div id="nameError" class="error small"></div>

   <div class="modes">
    <div class="mode">
     <h2>SOLO MODE</h2>
     <p class="small">Start immediately against seven bots.</p>
     <button id="solo" type="button">PLAY SOLO</button>
    </div>

    <div class="mode">
     <h2>CUSTOM ROOM</h2>
     <p class="small">Create a waiting lobby. Only you decide when the auction starts.</p>
     <button id="create" type="button">CREATE ROOM</button>
    </div>
   </div>

   <h2>JOIN A CUSTOM ROOM</h2>
   <label for="code">SIX-DIGIT ROOM CODE</label>
   <input id="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456">
   <button id="joinBtn" type="button" class="secondary">JOIN ROOM</button>
  </form>

  <p id="connection" class="small">Choose a game mode.</p>

  <p class="small">
   Eight owners maximum · 120 Cr · Exactly 15 players ·
   Reviews after two completed players · Unsold-player resale round.
   All player statistics and portraits are fictional.
  </p>
 </div>
</section>

<section id="lobby" class="overlay hide">
 <div class="card">
  <h1>CUSTOM ROOM — WAITING LOBBY</h1>
  <p id="identity"></p>

  <small>SHARE THIS NUMERIC CODE</small>
  <div id="roomCode" class="code"></div>

  <div class="row">
   <button id="copyCode">COPY CODE</button>
   <button id="copyLink" class="secondary">COPY INVITE LINK</button>
   <button id="leaveLobby" class="secondary">LEAVE ROOM</button>
  </div>

  <h2 style="margin-top:20px">OWNERS</h2>
  <div id="owners"></div>

  <div id="guestActions" class="hide" style="margin-top:16px">
   <button id="ready">I AM READY</button>
   <p class="small">Wait here. Only the room creator can start the auction.</p>
  </div>

  <div id="hostActions" class="hide" style="margin-top:16px">
   <label class="row">
    <input id="fillBots" type="checkbox" checked>
    Fill empty seats with bots when I start
   </label>
   <p id="startReason" class="small"></p>
   <button id="start">START AUCTION</button>
  </div>

  <p class="warn small">Joining never starts the auction automatically.</p>
 </div>
</section>

<div id="codeModal" class="hide" role="dialog" aria-modal="true">
 <div class="card">
  <h2>YOUR ROOM IS CREATED</h2>
  <p>Send this six-digit code to your friends.</p>

  <div id="popupCode" class="code"></div>

  <div class="row" style="justify-content:center;margin-top:15px">
   <button id="popupCopy">COPY CODE</button>
   <button id="popupClose" class="secondary">GO TO LOBBY</button>
  </div>

  <p class="small">The auction will not start until you press Start Auction.</p>
 </div>
</div>

<section id="top" class="hide">
 <div>
  <div id="roomInfo" class="small"></div>
  <div id="viewInfo" class="small"></div>
 </div>

 <div class="row">
  <button id="centre" class="secondary">CENTRE VIEW</button>
  <button id="voice" class="secondary">VOICE: ON</button>
  <button id="unsold" class="secondary">UNSOLD LIST</button>
  <button id="mySquad" class="secondary">MY SQUAD</button>
 </div>
</section>

<section id="bottom" class="hide">
 <div class="hud">
  <div>
   <small id="lotLabel"></small>
   <div id="pname" class="big"></div>
   <small id="role"></small>
  </div>

  <div>
   <small>CURRENT BID</small>
   <div id="price" class="big"></div>
   <small id="leader"></small>
  </div>

  <div>
   <small>YOUR PURSE</small>
   <div id="budget" class="big"></div>
   <small id="squad"></small>
  </div>

  <div>
   <small>TIME LEFT</small>
   <div id="timer" class="big"></div>
  </div>

  <button id="bid">BID</button>
 </div>

 <div id="notice" class="small" style="margin-top:9px"></div>
</section>

<div id="side" class="hide"></div>
<div id="review" class="hide"></div>

<section id="results" class="overlay hide">
 <div class="card">
  <h1 id="resultTitle"></h1>
  <p id="resultText"></p>

  <div style="overflow:auto">
   <table id="finalTable"></table>
  </div>

  <h2 style="margin-top:18px">YOUR SQUAD</h2>
  <div id="finalSquad"></div>

  <h2 style="margin-top:18px">STILL UNSOLD</h2>
  <div id="finalUnsold"></div>

  <button id="back" style="margin-top:15px">BACK TO GAME MODES</button>
 </div>
</section>

<div id="toast" class="hide"></div>

<script>
"use strict";

(function(){
 const $ = id => document.getElementById(id);

 // Where the server lives. Empty = same origin as this page.
 const API_BASE = "__API_BASE__";

 let state = null;
 let myId = null;
 let session = null;
 let stream = null;
 let connected = false;
 let busy = false;

 let voiceEnabled = true;
 let serverOffset = 0;
 let sideMode = null;

 let lastReviewKey = "";
 let lastResultKey = "";

 let speechSequence = -1;
 let toastTimer;

 let renderer;
 let scene;
 let camera;
 let clock;
 let screenTexture;
 let monitorTexture;
 let anchorMouth;
 let anchorArm;
 let playerAvatar;

 let seatGroups = [];
 let seatKey = "";

 let yaw = 0;
 let pitch = 0;
 let smoothYaw = 0;
 let smoothPitch = 0;

 let lightMesh;
 let lights = [];
 let lastLightCycle = -1;
 let lightAccumulator = 0;

 const reducedMotion = window.matchMedia
  ? window.matchMedia("(prefers-reduced-motion: reduce)")
  : {matches:false};

 const invite = new URLSearchParams(location.search).get("room") || "";

 $("code").value = invite.replace(/\D/g,"").slice(0,6);

 const money = value =>
  Number(value || 0).toFixed(2).replace(/\.?0+$/, "") + " Cr";

 const me = () =>
  state && state.teams.find(team => team.id === myId);

 function element(tag,className,text){
  const node = document.createElement(tag);
  if(className) node.className = className;
  if(text !== undefined) node.textContent = text;
  return node;
 }

 function toast(text){
  $("toast").textContent = text;
  $("toast").classList.remove("hide");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(()=>{
   $("toast").classList.add("hide");
  },5000);
 }

 function savedSession(code){
  try{
   return JSON.parse(
    sessionStorage.getItem("hammer-native-"+code) || "null"
   );
  }catch(_){
   return null;
  }
 }

 function saveSession(value){
  session = value;

  try{
   sessionStorage.setItem(
    "hammer-native-"+value.code,
    JSON.stringify(value)
   );
  }catch(_){}
 }

 async function api(action,data){
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),12000);

  try{
   const response = await fetch(
    API_BASE+"/api/"+action,
    {
     method:"POST",
     headers:{"Content-Type":"application/json"},
     body:JSON.stringify({
      ...(session || {}),
      ...(data || {})
     }),
     signal:controller.signal
    }
   );

   let result;

   try{
    result = await response.json();
   }catch(_){
    throw new Error("Server returned an unexpected response.");
   }

   if(!response.ok || result.error){
    throw new Error(result.error || "Request failed.");
   }

   return result;
  }catch(error){
   if(error.name === "AbortError"){
    throw new Error("Request timed out. Check your connection.");
   }

   if(error instanceof TypeError){
    throw new Error("Cannot reach the game server. Check the server address.");
   }

   throw error;
  }finally{
   clearTimeout(timeout);
  }
 }

 function validateName(){
  const name = $("name").value.trim().replace(/\s+/g," ");
  const valid = name.length >= 2 && name.length <= 22;

  $("nameError").textContent = valid
   ? ""
   : "Please fill your franchise name using 2–22 characters.";

  if(!valid) $("name").focus();

  return valid ? name : null;
 }

 function setBusy(value){
  busy = value;

  ["solo","create","joinBtn"].forEach(id=>{
   $(id).disabled = value;
  });
 }

 function unlockSpeech(){
  if(voiceEnabled && "speechSynthesis" in window){
   try{
    speechSynthesis.speak(new SpeechSynthesisUtterance(""));
   }catch(_){}
  }
 }

 async function enter(action){
  if(busy) return;

  const name = validateName();
  if(!name) return;

  const code = $("code").value.trim();

  if(action === "join" && !/^\d{6}$/.test(code)){
   toast("Enter a six-digit numeric room code.");
   $("code").focus();
   return;
  }

  setBusy(true);

  try{
   const stored = action === "join" ? savedSession(code) : null;

   // A new entry must not reuse an older session's code/token.
   session = null;

   const result = await api(action,{
    name,
    code,
    token:stored ? stored.token : null
   });

   myId = result.teamId;
   saveSession(result);

   history.replaceState(
    null,
    "",
    result.solo ? location.pathname : "?room="+result.code
   );

   $("home").classList.add("hide");

   unlockSpeech();
   connectStream();

   if(result.created){
    $("popupCode").textContent = result.code;
    $("codeModal").classList.remove("hide");
    $("popupClose").focus();
   }
  }catch(error){
   toast(error.message);
  }finally{
   setBusy(false);
  }
 }

 function connectStream(){
  if(stream) stream.close();

  speechSequence = -1;
  connected = false;

  const query = new URLSearchParams({
   code:session.code,
   token:session.token
  });

  stream = new EventSource(API_BASE+"/events?"+query.toString());

  stream.onopen = ()=>{
   connected = true;
   $("connection").textContent = "Connected to the room.";
   if(state) renderUI();
  };

  stream.onerror = ()=>{
   connected = false;

   $("bid").disabled = true;
   $("start").disabled = true;

   $("connection").textContent = "Connection interrupted. Reconnecting...";
  };

  stream.addEventListener("state",event=>{
   connected = true;

   state = JSON.parse(event.data);
   serverOffset = state.serverNow-Date.now();

   renderUI();

   if(scene){
    buildSeats();
    drawScreens();

    if(playerAvatar){
     playerAvatar.visible = Boolean(state.current);

     if(state.current){
      playerAvatar.userData.shirt.color.set(state.current.colour);
     }
    }
   }

   if(state.speechSequence !== speechSequence){
    speechSequence = state.speechSequence;

    if(voiceEnabled && state.lastSpeech && "speechSynthesis" in window){
     try{
      speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(state.lastSpeech);
      utterance.lang = "en-IN";
      utterance.rate = 1.04;

      speechSynthesis.speak(utterance);
     }catch(_){}
    }
   }
  });

  stream.addEventListener("roomClosed",event=>{
   const data = JSON.parse(event.data);
   resetGame();
   toast(data.message);
  });

  stream.addEventListener("invalidSession",event=>{
   const data = JSON.parse(event.data);
   resetGame();
   toast(data.message);
  });
 }

 $("nameForm").onsubmit = event=>event.preventDefault();

 $("name").oninput = ()=>{
  $("nameError").textContent = "";
 };

 $("code").oninput = ()=>{
  $("code").value = $("code").value.replace(/\D/g,"").slice(0,6);
 };

 $("solo").onclick = ()=>enter("solo");
 $("create").onclick = ()=>enter("create");
 $("joinBtn").onclick = ()=>enter("join");

 async function copy(text){
  try{
   await navigator.clipboard.writeText(text);
   toast("Copied: "+text);
  }catch(_){
   window.prompt("Copy this",text);
  }
 }

 $("copyCode").onclick = ()=>{
  if(state) copy(state.code);
 };

 $("popupCopy").onclick = ()=>{
  if(session) copy(session.code);
 };

 $("copyLink").onclick = ()=>{
  if(state){
   copy(location.origin+location.pathname+"?room="+state.code);
  }
 };

 $("popupClose").onclick = ()=>{
  $("codeModal").classList.add("hide");
 };

 $("ready").onclick = async()=>{
  if(!me()) return;

  try{
   await api("ready",{ready:!me().ready});
  }catch(error){
   toast(error.message);
  }
 };

 $("fillBots").onchange = renderStartButton;

 function renderStartButton(){
  if(!state || !me()) return;

  const humans = state.teams.filter(team=>!team.bot).length;

  let reason;

  if(!connected){
   reason = "Waiting for connection.";
  }else if(!state.allReady){
   reason = "Waiting for every guest to be connected and Ready.";
  }else if(!$("fillBots").checked && humans !== 8){
   reason = "Join eight owners or enable bots for empty seats.";
  }else{
   reason = "Everyone is ready. Only you can start the auction.";
  }

  $("startReason").textContent = reason;

  $("start").disabled =
   !connected ||
   !state.allReady ||
   (!$("fillBots").checked && humans !== 8);
 }

 $("start").onclick = async()=>{
  if(!state || myId !== state.hostId) return;

  const humans = state.teams.filter(team=>!team.bot).length;

  if(
   !window.confirm(
    "Start with "+humans+" human owners and "+(8-humans)+
    " bots? New owners cannot join afterward."
   )
  ) return;

  $("start").disabled = true;

  try{
   await api("start",{fillBots:$("fillBots").checked});
  }catch(error){
   toast(error.message);
   renderStartButton();
  }
 };

 function resetGame(){
  if(stream){
   stream.close();
   stream = null;
  }

  if("speechSynthesis" in window){
   speechSynthesis.cancel();
  }

  session = null;
  myId = null;
  state = null;
  connected = false;

  sideMode = null;
  lastReviewKey = "";
  lastResultKey = "";
  seatKey = "";

  yaw = pitch = smoothYaw = smoothPitch = 0;

  [
   "lobby","codeModal","top","bottom","side","review","results"
  ].forEach(id=>{
   $(id).classList.add("hide");
  });

  $("home").classList.remove("hide");

  history.replaceState(null,"",location.pathname);

  if(playerAvatar) playerAvatar.visible = false;

  drawScreens();
 }

 async function leaveGame(){
  try{
   await api("leave");
  }catch(_){}

  resetGame();
 }

 $("leaveLobby").onclick = ()=>{
  if(
   window.confirm(
    "Leave this lobby? If you are the creator, the waiting lobby will close."
   )
  ){
   leaveGame();
  }
 };

 $("back").onclick = leaveGame;

 $("bid").onclick = async()=>{
  try{
   await api("bid");
  }catch(error){
   toast(error.message);
  }
 };

 $("centre").onclick = ()=>{
  yaw = 0;
  pitch = 0;
 };

 $("voice").onclick = ()=>{
  voiceEnabled = !voiceEnabled;

  $("voice").textContent = voiceEnabled ? "VOICE: ON" : "VOICE: OFF";

  if(!voiceEnabled && "speechSynthesis" in window){
   speechSynthesis.cancel();
  }else{
   unlockSpeech();
  }
 };

 $("unsold").onclick = ()=>{
  sideMode = sideMode === "unsold" ? null : "unsold";
  renderSidePanel();
 };

 $("mySquad").onclick = ()=>{
  sideMode = sideMode === "squad" ? null : "squad";
  renderSidePanel();
 };

 addEventListener("keydown",event=>{
  const tag = document.activeElement ? document.activeElement.tagName : "";

  if(["INPUT","TEXTAREA","BUTTON"].includes(tag)) return;

  if(event.code === "Space" && state && state.phase === "live"){
   event.preventDefault();

   if(!event.repeat && !$("bid").disabled){
    $("bid").click();
   }
  }
 });

 /* ================= UI ================= */

 function renderUI(){
  if(!state || !myId || !me()) return;

  const own = me();

  const lobby = state.phase === "lobby";
  const reviewing = ["review","finalreview"].includes(state.phase);
  const finished = state.phase === "finished";

  $("home").classList.add("hide");
  $("lobby").classList.toggle("hide",!lobby);
  $("results").classList.toggle("hide",!finished);

  $("top").classList.toggle("hide",lobby || finished);
  $("bottom").classList.toggle("hide",lobby || reviewing || finished);
  $("review").classList.toggle("hide",!reviewing);

  if(!lobby){
   $("codeModal").classList.add("hide");
  }

  $("identity").textContent =
   "You are "+own.playerLabel+" — "+own.name+
   (myId === state.hostId ? " · ROOM CREATOR" : "");

  $("roomCode").textContent = state.code;

  $("owners").replaceChildren();

  state.teams.forEach(team=>{
   $("owners").appendChild(
    element(
     "div","listrow",
     team.playerLabel+" · "+team.name+
     (team.id === myId ? " (YOU)" : "")+
     (
      team.id === state.hostId
       ? " — CREATOR"
       : team.ready
         ? " — READY"
         : " — NOT READY"
     )+
     (team.connected ? " — online" : " — disconnected")
    )
   );
  });

  $("hostActions").classList.toggle("hide",myId !== state.hostId);
  $("guestActions").classList.toggle("hide",myId === state.hostId);

  $("ready").textContent = own.ready
   ? "READY — CLICK TO UNREADY"
   : "I AM READY";

  renderStartButton();

  $("roomInfo").textContent =
   (state.solo ? "SOLO" : "ROOM "+state.code)+
   " · "+own.playerLabel+
   " · ROUND "+state.round+
   " · "+state.completed+" COMPLETED";

  $("lotLabel").textContent = "LOT "+state.position+" / "+state.total;

  $("pname").textContent = state.current ? state.current.name : state.notice;

  $("role").textContent = state.current
   ? state.current.role+" · Rating "+state.current.rating
   : "";

  $("price").textContent = money(state.price);

  const leader = state.teams.find(team=>team.id === state.leader);

  $("leader").textContent = leader
   ? "Leading: "+leader.name
   : "No opening bid";

  $("budget").textContent = money(own.budget);

  $("squad").textContent =
   own.squad.length+"/15 · "+own.needed+" required";

  $("notice").textContent =
   state.notice+" · Safe maximum bid: "+money(own.maxBid);

  $("bid").textContent =
   state.leader === myId ? "YOU LEAD" : "BID "+money(state.nextBid);

  $("bid").disabled =
   !connected ||
   state.phase !== "live" ||
   state.leader === myId ||
   own.needed === 0 ||
   state.nextBid > own.maxBid+0.00001;

  if(reviewing){
   const key = state.phase+"-"+state.completed+"-"+state.reviewIndex;

   if(key !== lastReviewKey){
    lastReviewKey = key;
    renderReview();
   }
  }else{
   lastReviewKey = "";
  }

  if(finished){
   const key = state.code+"-"+state.completed;

   if(key !== lastResultKey){
    lastResultKey = key;
    renderResults();
   }
  }

  renderSidePanel();
 }

 function renderSidePanel(){
  $("side").classList.toggle("hide",!sideMode);

  if(!state || !sideMode || !me()) return;

  $("side").replaceChildren();

  const squad = sideMode === "squad";
  const list = squad ? me().squad : state.unsold;

  $("side").append(
   element("h2","",squad ? "YOUR SQUAD" : "UNSOLD PLAYERS"),
   element(
    "p","small",
    squad
     ? me().name+" · "+money(me().budget)+" left"
     : "Unsold players return once after the main auction."
   )
  );

  if(!list.length){
   $("side").appendChild(element("p","small","None currently."));
  }

  list.forEach(player=>{
   $("side").appendChild(
    element(
     "div","listrow",
     player.name+" · "+player.role+" · "+
     money(squad ? player.price : player.base)
    )
   );
  });
 }

 function renderReview(){
  const team = state.teams[state.reviewIndex];
  if(!team) return;

  const final = state.phase === "finalreview";

  $("review").replaceChildren();

  const card = element("div","reviewcard");

  card.style.setProperty("--team",team.colour);

  card.append(
   element(
    "div","small",
    (final ? "FINAL QUALIFICATION" : "TWO-PLAYER REVIEW")+
    " · OWNER "+(state.reviewIndex+1)+"/8"
   ),
   element("h2","",team.playerLabel+" — "+team.name),
   element(
    "div",
    final ? (team.qualified ? "good" : "bad") : "warn",
    final
     ? team.qualified
       ? "QUALIFIED"
       : "DISQUALIFIED — "+team.needed+" players short"
     : team.needed
       ? "IN PROGRESS"
       : "SQUAD COMPLETE"
   )
  );

  const stats = element("div","stats");
  const items = [];

  [
   ["SPENT",120-team.budget,true],
   ["PURSE LEFT",team.budget,true],
   ["BOUGHT / 15",team.squad.length,false],
   ["REQUIRED",team.needed,false]
  ].forEach(item=>{
   const box = element("div","stat");
   const value = element("b","","0");

   box.append(element("small","",item[0]),value);
   stats.appendChild(box);

   items.push({
    node:value,
    value:item[1],
    cash:item[2]
   });
  });

  card.appendChild(stats);

  const bar = element("div","bar");
  const fill = element("span");

  bar.appendChild(fill);
  card.appendChild(bar);

  requestAnimationFrame(()=>{
   fill.style.width = team.squad.length/15*100+"%";
  });

  const started = performance.now();

  function count(now){
   if(!card.isConnected) return;

   const progress = Math.min(1,(now-started)/850);
   const eased = 1-Math.pow(1-progress,3);

   items.forEach(item=>{
    item.node.textContent = item.cash
     ? money(item.value*eased)
     : String(Math.round(item.value*eased));
   });

   if(progress < 1){
    requestAnimationFrame(count);
   }
  }

  requestAnimationFrame(count);

  const roster = element("div","roster");

  if(!team.squad.length){
   roster.appendChild(element("p","small","No purchases yet."));
  }

  team.squad.forEach(player=>{
   roster.appendChild(
    element(
     "div","listrow",
     player.name+" · "+player.role+" · "+money(player.price)
    )
   );
  });

  card.append(
   roster,
   element(
    "p","small",
    "Requires exactly 15 players within 120 Cr. "+
    "Minimum remaining reserve: "+money(team.needed*0.5)+"."
   )
  );

  if(myId === state.hostId){
   const row = element("div","row");

   const next = element("button","","NEXT OWNER");

   const finish = element(
    "button","secondary",
    final ? "FINISH TOUR" : "RESUME AUCTION"
   );

   next.onclick = async()=>{
    try{
     await api("review",{finish:false});
    }catch(error){
     toast(error.message);
    }
   };

   finish.onclick = async()=>{
    try{
     await api("review",{finish:true});
    }catch(error){
     toast(error.message);
    }
   };

   row.append(next,finish);
   card.appendChild(row);
  }

  $("review").appendChild(card);
 }

 function renderResults(){
  const own = me();

  $("resultTitle").textContent =
   own.name+" — "+(own.qualified ? "QUALIFIED" : "DISQUALIFIED");

  $("resultText").textContent =
   state.soldCount+" sold · "+state.unsold.length+" unsold · "+
   "Exactly 15 players within 120 Cr required.";

  $("finalTable").replaceChildren();

  const header = element("tr");

  ["OWNER","TEAM","PLAYERS","SPENT","LEFT","STATUS"].forEach(text=>{
   header.appendChild(element("th","",text));
  });

  $("finalTable").appendChild(header);

  state.teams.forEach(team=>{
   const row = element("tr");

   [
    team.playerLabel,
    team.name,
    team.squad.length+"/15",
    money(120-team.budget),
    money(team.budget),
    team.qualified ? "QUALIFIED" : "DISQUALIFIED"
   ].forEach(value=>{
    row.appendChild(element("td","",value));
   });

   $("finalTable").appendChild(row);
  });

  $("finalSquad").replaceChildren();

  own.squad.forEach(player=>{
   $("finalSquad").appendChild(
    element(
     "div","listrow",
     player.name+" · "+player.role+" · "+money(player.price)
    )
   );
  });

  $("finalUnsold").replaceChildren();

  if(!state.unsold.length){
   $("finalUnsold").textContent = "None.";
  }

  state.unsold.forEach(player=>{
   $("finalUnsold").appendChild(
    element("div","listrow",player.name+" · "+player.role)
   );
  });
 }

 /* ================= THREE.JS ================= */

 if(!window.THREE){
  toast(
   "3D library did not load. The room and bidding interface remain available."
  );
  return;
 }

 // Declared BEFORE buildWorld() runs, because animate() starts at once.
 const temporaryColour = new THREE.Color();
 const lookTarget = new THREE.Vector3();
 const forward = new THREE.Vector3();

 try{
  buildWorld();
 }catch(error){
  console.error(error);

  toast(
   "3D view unavailable. Room and bidding controls remain available."
  );
 }

 function material(colour){
  return new THREE.MeshStandardMaterial({
   color:colour,
   roughness:0.55,
   metalness:0.1
  });
 }

 function mesh(geometry,mat,x,y,z,parent){
  const object = new THREE.Mesh(geometry,mat);

  object.position.set(x,y,z);
  (parent || scene).add(object);

  return object;
 }

 function makeTexture(width,height){
  const canvas = document.createElement("canvas");

  canvas.width = width;
  canvas.height = height;

  return {
   ctx:canvas.getContext("2d"),
   map:new THREE.CanvasTexture(canvas)
  };
 }

 function seatPosition(seat){
  const angle = -1.18+seat*2.36/7;

  return new THREE.Vector3(
   Math.sin(angle)*20,
   0,
   7+Math.cos(angle)*8
  );
 }

 function chairPosition(team){
  const position = seatPosition(team.seat);

  const away = new THREE.Vector3(
   position.x,
   0,
   position.z+15
  ).normalize();

  return position
   .addScaledVector(away,3.2)
   .add(new THREE.Vector3(0,2.5,0));
 }

 function buildWorld(){
  renderer = new THREE.WebGLRenderer({
   canvas:$("gl"),
   antialias:false,
   powerPreference:"high-performance"
  });

  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth,innerHeight);

  scene = new THREE.Scene();

  scene.background = new THREE.Color(0x090e28);
  scene.fog = new THREE.FogExp2(0x090e28,0.004);

  camera = new THREE.PerspectiveCamera(
   68,
   innerWidth/innerHeight,
   0.05,
   200
  );

  camera.position.set(0,14,36);
  camera.lookAt(0,5,-15);

  clock = new THREE.Clock();

  scene.add(new THREE.HemisphereLight(0xdde8ff,0x414d83,1.4));
  scene.add(new THREE.AmbientLight(0xffffff,0.45));

  const sun = new THREE.DirectionalLight(0xffffff,1.1);

  sun.position.set(0,25,20);
  scene.add(sun);

  mesh(
   new THREE.CircleGeometry(48,72),
   material(0x182348),
   0,-0.05,0
  ).rotation.x = -Math.PI/2;

  mesh(
   new THREE.PlaneGeometry(100,45),
   new THREE.MeshBasicMaterial({color:0x111a41}),
   0,16,-30
  );

  mesh(
   new THREE.CylinderGeometry(7.5,8,0.8,40),
   material(0x293575),
   0,0.4,-15
  );

  mesh(
   new THREE.BoxGeometry(3.4,1.5,1.6),
   material(0x29345c),
   -3,1.6,-15
  );

  for(let i=1;i<6;i++){
   mesh(
    new THREE.RingGeometry(i*6,i*6+0.07,80),
    new THREE.MeshBasicMaterial({
     color:i%2 ? 0x497eff : 0xf56ec4
    }),
    0,0.02,0
   ).rotation.x = -Math.PI/2;
  }

  buildAnchor();
  buildPlayerAvatar();

  screenTexture = makeTexture(1280,720);
  monitorTexture = makeTexture(1024,640);

  mesh(
   new THREE.BoxGeometry(20,11,0.7),
   material(0x131d3e),
   0,9,-25
  );

  mesh(
   new THREE.PlaneGeometry(19.6,10.6),
   new THREE.MeshBasicMaterial({map:screenTexture.map}),
   0,9,-24.63
  );

  decorate();

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  $("gl").addEventListener("pointerdown",event=>{
   dragging = true;
   lastX = event.clientX;
   lastY = event.clientY;

   try{
    $("gl").setPointerCapture(event.pointerId);
   }catch(_){}
  });

  ["pointerup","pointercancel","lostpointercapture"].forEach(name=>{
   $("gl").addEventListener(name,()=>dragging=false);
  });

  $("gl").addEventListener("pointermove",event=>{
   if(!dragging) return;

   if(state && ["review","finalreview"].includes(state.phase)){
    lastX = event.clientX;
    lastY = event.clientY;
    return;
   }

   yaw = Math.max(
    -2.35,
    Math.min(2.35,yaw-(event.clientX-lastX)*0.005)
   );

   pitch = Math.max(
    -0.95,
    Math.min(0.9,pitch-(event.clientY-lastY)*0.004)
   );

   lastX = event.clientX;
   lastY = event.clientY;
  });

  addEventListener("resize",()=>{
   renderer.setSize(innerWidth,innerHeight);

   camera.aspect = innerWidth/innerHeight;
   camera.updateProjectionMatrix();
  });

  drawScreens();
  animate();
 }

 function buildAnchor(){
  const anchor = new THREE.Group();

  anchor.position.set(-3,0.8,-16);
  scene.add(anchor);

  mesh(new THREE.BoxGeometry(0.85,1.3,0.45),material(0xe7ecff),0,1.45,0,anchor);
  mesh(new THREE.SphereGeometry(0.36,12,10),material(0xc68d68),0,2.4,0,anchor);

  anchorMouth = mesh(
   new THREE.BoxGeometry(0.2,0.055,0.03),
   material(0x552d29),
   0,2.28,0.35,anchor
  );

  anchorArm = mesh(
   new THREE.BoxGeometry(0.22,0.85,0.25),
   material(0xe7ecff),
   0.58,1.6,0,anchor
  );

  mesh(
   new THREE.CylinderGeometry(0.025,0.025,0.7,8),
   material(0x111111),
   0.25,2,0.35,anchor
  );

  mesh(
   new THREE.SphereGeometry(0.09,8,6),
   material(0x222222),
   0.25,2.38,0.35,anchor
  );
 }

 function buildPlayerAvatar(){
  playerAvatar = new THREE.Group();

  playerAvatar.position.set(3,0.8,-15);
  scene.add(playerAvatar);

  const shirt = material(0x45baff);

  mesh(new THREE.BoxGeometry(1,1.3,0.5),shirt,0,1.6,0,playerAvatar);
  mesh(new THREE.SphereGeometry(0.36,12,10),material(0xd6a47c),0,2.65,0,playerAvatar);

  [-0.27,0.27].forEach(x=>{
   mesh(
    new THREE.BoxGeometry(0.35,1.1,0.4),
    material(0xe4e9ff),
    x,0.45,0,playerAvatar
   );
  });

  [-0.65,0.65].forEach(x=>{
   mesh(
    new THREE.BoxGeometry(0.22,1,0.25),
    shirt,
    x,1.6,0,playerAvatar
   );
  });

  playerAvatar.userData.shirt = shirt;
  playerAvatar.visible = false;
 }

 /* ================= CHAIRS AND MONITORS ================= */

 function disposeGroup(group){
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();

  group.traverse(object=>{
   if(object.geometry){
    geometries.add(object.geometry);
   }

   if(object.material){
    const list = Array.isArray(object.material)
     ? object.material
     : [object.material];

    list.forEach(mat=>{
     materials.add(mat);

     if(mat.map && mat.map !== monitorTexture.map){
      textures.add(mat.map);
     }
    });
   }
  });

  geometries.forEach(item=>item.dispose());
  materials.forEach(item=>item.dispose());
  textures.forEach(item=>item.dispose());

  scene.remove(group);
 }

 function fitText(ctx,text,width,size,min){
  ctx.font = "700 "+size+"px Oswald,Arial";

  while(ctx.measureText(text).width > width && size > min){
   size -= 2;
   ctx.font = "700 "+size+"px Oswald,Arial";
  }
 }

 function plaqueTexture(team){
  const texture = makeTexture(512,160);
  const ctx = texture.ctx;

  ctx.fillStyle = "#091126";
  ctx.fillRect(0,0,512,160);

  ctx.strokeStyle = team.colour;
  ctx.lineWidth = 10;
  ctx.strokeRect(5,5,502,150);

  ctx.textAlign = "center";
  ctx.fillStyle = team.colour;
  ctx.font = "700 40px Oswald,Arial";

  ctx.fillText(team.playerLabel.toUpperCase(),256,58);

  ctx.fillStyle = "#fff";

  fitText(ctx,team.name,460,32,18);

  ctx.fillText(team.name,256,111);

  texture.map.needsUpdate = true;

  return texture.map;
 }

 function buildSeats(){
  if(!state || !myId) return;

  const key =
   state.teams.map(team=>team.id+":"+team.seat).join(",")+myId;

  if(key === seatKey) return;

  seatKey = key;

  seatGroups.forEach(disposeGroup);
  seatGroups = [];

  state.teams.forEach(team=>{
   const position = seatPosition(team.seat);

   const group = new THREE.Group();

   group.position.copy(position);
   scene.add(group);

   mesh(new THREE.CylinderGeometry(2.6,2.8,0.28,24),material(0x243158),0,0.15,0,group);
   mesh(new THREE.CylinderGeometry(0.4,0.6,1.1,10),material(0x273357),0,0.75,0,group);
   mesh(new THREE.CylinderGeometry(2,2.1,0.25,24),material(team.colour),0,1.4,0,group);

   const away = new THREE.Vector3(
    position.x,
    0,
    position.z+15
   ).normalize();

   const chairOffset = away.clone().multiplyScalar(3.2);

   const chair = new THREE.Group();

   chair.position.copy(chairOffset);
   chair.lookAt(new THREE.Vector3());

   mesh(new THREE.BoxGeometry(1.2,0.25,1.2),material(team.colour),0,0.85,0,chair);
   mesh(new THREE.BoxGeometry(1.2,1.35,0.18),material(0x263558),0,1.5,-0.55,chair);

   group.add(chair);

   if(team.id !== myId){
    const body = new THREE.Group();

    body.position.copy(chairOffset);

    mesh(new THREE.BoxGeometry(0.7,0.9,0.45),material(team.colour),0,1.4,0,body);
    mesh(new THREE.SphereGeometry(0.28,10,8),material(0xc89870),0,2.13,0,body);

    group.add(body);
   }

   const monitorPosition = position.clone().addScaledVector(away,1.2);

   monitorPosition.y = 1.9;

   const frame = mesh(
    new THREE.BoxGeometry(2.5,1.55,0.12),
    material(0x070c18),
    0,0,0
   );

   frame.position.copy(monitorPosition);
   frame.lookAt(chairPosition(team));

   mesh(
    new THREE.PlaneGeometry(2.35,1.4),
    team.id === myId
     ? new THREE.MeshBasicMaterial({map:monitorTexture.map})
     : new THREE.MeshBasicMaterial({color:team.colour}),
    0,0,0.07,frame
   );

   scene.updateMatrixWorld(true);
   group.attach(frame);

   const signPosition = position.clone().addScaledVector(away,-1.55);

   signPosition.y = 2;

   const sign = mesh(
    new THREE.PlaneGeometry(2.5,0.8),
    new THREE.MeshBasicMaterial({
     map:plaqueTexture(team),
     side:THREE.DoubleSide
    }),
    0,0,0
   );

   sign.position.copy(signPosition);
   sign.lookAt(chairPosition(team));

   scene.updateMatrixWorld(true);
   group.attach(sign);

   seatGroups.push(group);
  });
 }

 /* ================= SCREEN DRAWING ================= */

 function portrait(ctx,x,y,scale,colour){
  ctx.save();
  ctx.translate(x,y);
  ctx.scale(scale,scale);

  ctx.fillStyle = colour;
  ctx.fillRect(-52,25,104,100);

  ctx.fillStyle = "#d4a17c";
  ctx.beginPath();
  ctx.arc(0,-10,38,0,Math.PI*2);
  ctx.fill();

  ctx.fillStyle = "#201a20";
  ctx.beginPath();
  ctx.arc(0,-22,39,Math.PI,Math.PI*2);
  ctx.fill();

  ctx.fillStyle = "#182139";
  ctx.fillRect(-18,-15,6,5);
  ctx.fillRect(12,-15,6,5);
  ctx.fillRect(-10,10,20,4);

  ctx.restore();
 }

 function drawScreens(){
  if(!screenTexture) return;

  const ctx = screenTexture.ctx;

  const width = 1280;
  const height = 720;

  const gradient = ctx.createLinearGradient(0,0,width,height);

  gradient.addColorStop(0,"#213e83");
  gradient.addColorStop(1,"#070d25");

  ctx.fillStyle = gradient;
  ctx.fillRect(0,0,width,height);

  ctx.textAlign = "center";
  ctx.fillStyle = "#ffd34c";
  ctx.font = "700 68px Oswald,Arial";

  ctx.fillText("HAMMER HALL",width/2,85);

  ctx.fillStyle = "#c2d3ff";
  ctx.font = "27px Arial";

  ctx.fillText("120 CR | 15 PLAYERS | SOLO & MULTIPLAYER",width/2,132);

  if(!state || !state.current){
   ctx.fillStyle = "#fff";

   const text = state ? state.notice : "WELCOME TO THE AUCTION";

   fitText(ctx,text,width-100,58,26);

   ctx.fillText(text,width/2,350);
  }else{
   const player = state.current;

   portrait(ctx,200,340,1.7,player.colour);

   ctx.textAlign = "left";
   ctx.fillStyle = "#fff";

   fitText(ctx,player.name.toUpperCase(),820,72,35);

   ctx.fillText(player.name.toUpperCase(),380,250);

   ctx.fillStyle = "#ffd98c";
   ctx.font = "30px Arial";

   ctx.fillText(
    player.role+" | AGE "+player.age+" | RATING "+player.rating,
    380,305
   );

   ctx.fillStyle = "#d3dfff";
   ctx.font = "25px Arial";

   ctx.fillText(
    "MATCHES "+player.matches+"  RUNS "+player.runs+"  WICKETS "+player.wickets,
    380,365
   );

   ctx.fillText(
    "STRIKE RATE "+player.strikeRate+"  ECONOMY "+player.economy,
    380,410
   );

   ctx.fillStyle = "#86ffb2";
   ctx.font = "700 90px Oswald,Arial";

   ctx.fillText(money(state.price),380,530);

   const leader = state.teams.find(team=>team.id === state.leader);

   const leadText = leader
    ? "LEADING: "+leader.name
    : "WAITING FOR OPENING BID";

   ctx.fillStyle = "#fff";

   fitText(ctx,leadText,830,28,18);

   ctx.fillText(leadText,380,585);

   ctx.textAlign = "center";
   ctx.font = "22px Arial";

   ctx.fillText("FICTIONAL SIMULATED STATISTICS",width/2,675);
  }

  screenTexture.map.needsUpdate = true;

  if(!monitorTexture || !me()) return;

  const monitor = monitorTexture.ctx;

  const own = me();
  const player = state.current;

  monitor.fillStyle = "#071025";
  monitor.fillRect(0,0,1024,640);

  monitor.strokeStyle = own.colour;
  monitor.lineWidth = 15;
  monitor.strokeRect(8,8,1008,624);

  monitor.textAlign = "center";
  monitor.fillStyle = own.colour;

  const title = own.playerLabel.toUpperCase()+" — "+own.name.toUpperCase();

  fitText(monitor,title,960,50,24);

  monitor.fillText(title,512,75);

  monitor.fillStyle = "#fff";
  monitor.font = "28px Arial";

  monitor.fillText(
   "PURSE "+money(own.budget)+" | SQUAD "+own.squad.length+"/15",
   512,130
  );

  monitor.fillStyle = "#ffd98c";
  monitor.font = "24px Arial";

  monitor.fillText(
   "NEEDED "+own.needed+" | SAFE MAX "+money(own.maxBid),
   512,175
  );

  if(player){
   portrait(monitor,145,310,1,player.colour);

   monitor.textAlign = "left";
   monitor.fillStyle = "#fff";

   fitText(monitor,player.name,700,43,24);

   monitor.fillText(player.name,260,250);

   monitor.font = "25px Arial";

   monitor.fillText(player.role+" · Rating "+player.rating,260,295);
   monitor.fillText("Runs "+player.runs+" · Wickets "+player.wickets,260,340);
   monitor.fillText("SR "+player.strikeRate+" · Economy "+player.economy,260,380);

   monitor.fillStyle = "#8dffb4";
   monitor.font = "700 55px Oswald,Arial";

   monitor.fillText(money(state.price),260,450);
  }else{
   monitor.fillStyle = "#fff";
   monitor.font = "32px Arial";

   monitor.fillText("WAITING / TEAM REVIEW",512,330);
  }

  monitor.textAlign = "center";
  monitor.fillStyle = "#b7c9ed";

  const recent =
   "YOUR PURCHASES: "+
   (
    own.squad.slice(-3).map(p=>p.name).join(" · ") || "None yet"
   );

  fitText(monitor,recent,960,22,14);

  monitor.fillText(recent,512,545);

  monitor.font = "22px Arial";

  monitor.fillText("SPACE TO BID · DRAG TO LOOK AROUND",512,590);

  monitorTexture.map.needsUpdate = true;
 }

 /* ================= BATCHED DECORATIVE LIGHTS ================= */

 function decorate(){
  const data = [];
  const wirePositions = [];

  const colours = [0xffdb78,0xff8bbb,0x8ee5ff,0xc68aff,0x81ffd2];

  function bulb(x,y,z,index,size){
   data.push({
    x,y,z,size,
    original:new THREE.Color(colours[index%5]),
    target:new THREE.Color().setHSL(Math.random(),0.85,0.65)
   });
  }

  function wire(points){
   for(let i=1;i<points.length;i++){
    wirePositions.push(...points[i-1],...points[i]);
   }
  }

  [-26,-15,-4,8,20].forEach((z,row)=>{
   const points = [];

   for(let i=0;i<26;i++){
    const u = i/25;
    const x = -28+56*u;
    const y = 20+row*0.5-Math.sin(u*Math.PI)*3;

    points.push([x,y,z]);
    bulb(x,y-0.2,z,i,1);
   }

   wire(points);
  });

  for(const side of [-1,1]){
   for(let column=0;column<8;column++){
    const points = [];

    for(let row=0;row<8;row++){
     const x = side*(11+column*2.1);
     const y = 3+row*1.9;

     points.push([x,y,-28.5]);
     bulb(x,y,-28.5,row+column,0.65);
    }

    wire(points);
   }
  }

  for(let i=0;i<48;i++){
   const angle = i/48*Math.PI*2;

   bulb(
    Math.cos(angle)*23,
    18,
    -2+Math.sin(angle)*23,
    i,0.9
   );
  }

  for(let spoke=0;spoke<10;spoke++){
   const angle = spoke/10*Math.PI*2;
   const points = [];

   for(let j=0;j<10;j++){
    const radius = 3+j*2.3;

    const x = Math.cos(angle)*radius;
    const y = 21-Math.sin(j/9*Math.PI)*2;
    const z = -2+Math.sin(angle)*radius;

    points.push([x,y,z]);
    bulb(x,y,z,spoke+j,0.65);
   }

   wire(points);
  }

  for(let i=0;i<40;i++){
   const angle = i/40*Math.PI*2;

   bulb(
    Math.cos(angle)*7.7,
    0.95,
    -15+Math.sin(angle)*7.7,
    i,0.7
   );
  }

  for(let i=0;i<24;i++){
   const x = -10.2+i/23*20.4;

   bulb(x,14.7,-24.1,i,0.7);
   bulb(x,3.3,-24.1,i+2,0.7);
  }

  for(let seat=0;seat<8;seat++){
   const position = seatPosition(seat);

   for(let i=0;i<14;i++){
    const angle = i/14*Math.PI*2;

    bulb(
     position.x+Math.cos(angle)*2.8,
     0.35,
     position.z+Math.sin(angle)*2.8,
     i+seat,0.5
    );
   }
  }

  const wireGeometry = new THREE.BufferGeometry();

  wireGeometry.setAttribute(
   "position",
   new THREE.Float32BufferAttribute(wirePositions,3)
  );

  scene.add(
   new THREE.LineSegments(
    wireGeometry,
    new THREE.LineBasicMaterial({color:0x665167})
   )
  );

  lights = data;

  lightMesh = new THREE.InstancedMesh(
   new THREE.SphereGeometry(0.15,6,4),
   new THREE.MeshBasicMaterial({color:0xffffff,fog:false}),
   data.length
  );

  const dummy = new THREE.Object3D();

  data.forEach((b,index)=>{
   dummy.position.set(b.x,b.y,b.z);
   dummy.scale.setScalar(b.size);
   dummy.updateMatrix();

   lightMesh.setMatrixAt(index,dummy.matrix);
   lightMesh.setColorAt(index,b.original);
  });

  lightMesh.instanceMatrix.needsUpdate = true;
  lightMesh.instanceColor.needsUpdate = true;

  scene.add(lightMesh);

  [
   [-18,10,-15,0xffb977],
   [18,10,-15,0xff8abc]
  ].forEach(item=>{
   const light = new THREE.PointLight(item[3],0.7,35,2);

   light.position.set(item[0],item[1],item[2]);
   scene.add(light);
  });
 }

 /* ================= ANIMATION ================= */

 function animate(){
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(),0.05);
  const time = clock.elapsedTime;

  lightAccumulator += dt;

  if(lightMesh && lightAccumulator > 0.05){
   lightAccumulator = 0;

   const cycle = Math.floor(time);
   const fraction = time-cycle;

   const progress = fraction <= 0.5 ? fraction*2 : (1-fraction)*2;
   const eased = 0.5-Math.cos(Math.PI*progress)*0.5;

   if(cycle !== lastLightCycle){
    lastLightCycle = cycle;

    lights.forEach(b=>{
     b.target.setHSL(Math.random(),0.85,0.65);
    });
   }

   lights.forEach((b,index)=>{
    temporaryColour.lerpColors(b.original,b.target,eased);
    lightMesh.setColorAt(index,temporaryColour);
   });

   lightMesh.instanceColor.needsUpdate = true;
  }

  if(anchorMouth){
   const speaking =
    voiceEnabled &&
    "speechSynthesis" in window &&
    speechSynthesis.speaking;

   anchorMouth.scale.y = speaking
    ? 1+Math.abs(Math.sin(time*19))*3
    : 1;

   anchorArm.rotation.z = speaking ? Math.sin(time*3)*0.18 : 0;
  }

  if(playerAvatar){
   playerAvatar.rotation.y = Math.sin(time*0.5)*0.12;
  }

  const own = me();

  if(state && own && state.phase !== "lobby"){
   const reviewing = ["review","finalreview"].includes(state.phase);

   const team = reviewing ? state.teams[state.reviewIndex] : own;

   if(team){
    if(reviewing){
     const position = seatPosition(team.seat);

     const desired = position.clone().add(new THREE.Vector3(5,4,7));

     camera.position.lerp(desired,1-Math.exp(-3.5*dt));

     camera.lookAt(position.add(new THREE.Vector3(0,1.6,0)));

     $("viewInfo").textContent =
      "SHOWCASE · "+team.playerLabel+" — "+team.name;
    }else{
     const blend = 1-Math.exp(-12*dt);

     smoothYaw += (yaw-smoothYaw)*blend;
     smoothPitch += (pitch-smoothPitch)*blend;

     const eye = chairPosition(own);

     const towardStage = new THREE.Vector3(
      -eye.x,
      0,
      -15-eye.z
     ).normalize();

     eye.addScaledVector(towardStage,0.18);

     if(!reducedMotion.matches){
      eye.y += Math.sin(time*1.7)*0.006;
     }

     camera.position.lerp(eye,1-Math.exp(-8*dt));

     const angle =
      Math.atan2(towardStage.x,towardStage.z)+smoothYaw;

     const headPitch = smoothPitch-0.045;

     forward.set(
      Math.sin(angle)*Math.cos(headPitch),
      Math.sin(headPitch),
      Math.cos(angle)*Math.cos(headPitch)
     );

     lookTarget.copy(camera.position).addScaledVector(forward,20);

     camera.lookAt(lookTarget);

     $("viewInfo").textContent =
      own.playerLabel+" · YOUR CHAIR · drag to look around";
    }
   }

   const secondsLeft = Math.max(
    0,
    (state.deadline-Date.now()-serverOffset)/1000
   );

   $("timer").textContent =
    state.phase === "live" ? secondsLeft.toFixed(1)+"s" : "—";
  }else{
   camera.position.lerp(
    new THREE.Vector3(0,14,36),
    1-Math.exp(-3*dt)
   );

   camera.lookAt(0,5,-15);
  }

  renderer.render(scene,camera);
 }

 if(document.fonts && document.fonts.ready){
  document.fonts.ready.then(()=>{
   drawScreens();

   if(scene && state && myId){
    seatKey = "";
    buildSeats();
   }
  });
 }
})();
</script>
</body>
</html>`;

const PAGE = HTML.split("__API_BASE__").join(
  API_BASE.replace(/[^a-zA-Z0-9:/._\-]/g, "")
);

/* ================= HTTP SERVER ================= */

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");

    // Cross-origin support (only if your page is on another domain).
    const origin = request.headers.origin;

    if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      response.setHeader("Vary", "Origin");
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname === "/health") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok");
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });

      response.end(PAGE);
      return;
    }

    if (request.method === "GET" && url.pathname === "/events") {
      const code = url.searchParams.get("code");
      const token = url.searchParams.get("token");

      const session = ownerSession(code, token);

      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });

      response.write("retry: 2000\n\n");

      if (!session) {
        sendEvent(response, "invalidSession", {
          message:
            "This owner session has expired. Join or create a room again."
        });

        response.end();
        return;
      }

      const { room, team } = session;
      const oldStream = team.stream;

      // Replace the stream before closing the old one so its close
      // handler cannot mark the new connection as disconnected.
      team.stream = response;
      team.connected = true;

      if (team.id === room.hostId) team.ready = true;

      room.lastActive = Date.now();

      if (oldStream && oldStream !== response && !oldStream.writableEnded) {
        oldStream.end();
      }

      response.on("close", () => {
        if (team.stream !== response) return;

        team.stream = null;
        team.connected = false;
        team.ready = false;
        room.lastActive = Date.now();

        if (rooms.has(room.code)) broadcast(room);
      });

      broadcast(room);
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url.pathname);
      return;
    }

    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found.");
  } catch (error) {
    console.error(error);

    if (!response.headersSent) {
      json(response, 500, {
        error: "The server could not complete the request."
      });
    } else {
      response.end();
    }
  }
});

server.on("error", error => {
  console.error("Server could not start:", error.message);
  process.exitCode = 1;
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("HAMMER HALL running at http://localhost:" + PORT);
});
