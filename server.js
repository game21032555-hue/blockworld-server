const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = 6;

const ADMIN_NAME = "game1";
const ADMIN_CODE = "130";

const rooms = new Map();

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function cleanName(value) {
  return String(value || "Player").trim().slice(0, 24) || "Player";
}

function cleanRoom(value) {
  return String(value || "").trim().slice(0, 32);
}

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      players: new Map(),
      globalLuck: {
        multiplier: 1,
        until: 0
      }
    });
  }

  return rooms.get(code);
}

function playerData(player) {
  return {
    id: player.id,
    name: player.name,

    // ส่งเฉพาะฐานและเบรอท
    // ไม่ส่งตำแหน่งตัวผู้เล่น
    base: player.base,
    brainrots: player.brainrots
  };
}

function roomData(room) {
  return {
    type: "room_state",
    players: [...room.players.values()].map(playerData),
    globalLuck: room.globalLuck
  };
}

function send(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data) {
  const packet = JSON.stringify(data);

  for (const player of room.players.values()) {
    if (player.ws.readyState === 1) {
      player.ws.send(packet);
    }
  }
}

function broadcastRoom(room) {
  broadcast(room, roomData(room));
}

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
      ok: true,
      service: "BlockWorld Server",
      rooms: rooms.size
    }));

    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  res.end("BlockWorld Server is running.");
});

const wss = new WebSocketServer({
  server: httpServer
});

wss.on("connection", (ws) => {
  let player = null;
  let room = null;

  ws.on("message", (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, {
        type: "error",
        message: "Invalid message"
      });
      return;
    }

    /*
      JOIN
    */
    if (msg.type === "join") {
      if (player) return;

      const roomCode = cleanRoom(msg.roomCode);

      if (!roomCode) {
        send(ws, {
          type: "error",
          message: "Room code required"
        });
        return;
      }

      room = getRoom(roomCode);

      if (room.players.size >= MAX_PLAYERS) {
        send(ws, {
          type: "room_full",
          maxPlayers: MAX_PLAYERS
        });
        return;
      }

      const name = cleanName(msg.name);

      player = {
        id: makeId(),
        name,

        base: msg.base ?? null,

        brainrots: Array.isArray(msg.brainrots)
          ? msg.brainrots
          : [],

        ws,

        isAdmin:
          name === ADMIN_NAME &&
          String(msg.code || "") === ADMIN_CODE
      };

      room.players.set(player.id, player);

      send(ws, {
        type: "joined",
        playerId: player.id,
        maxPlayers: MAX_PLAYERS,
        state: roomData(room)
      });

      broadcastRoom(room);

      return;
    }

    if (!player || !room) return;

    /*
      อัปเดตฐาน + เบรอทของผู้เล่น
    */
    if (msg.type === "state") {
      if ("base" in msg) {
        player.base = msg.base;
      }

      if (Array.isArray(msg.brainrots)) {
        player.brainrots = msg.brainrots;
      }

      broadcastRoom(room);

      return;
    }

    /*
      ADMIN
      game1 + 130 เท่านั้น
    */
    if (msg.type === "admin_action") {

      if (!player.isAdmin) {
        send(ws, {
          type: "admin_denied"
        });

        return;
      }

      const action = msg.action;

      /*
        เงินไม่ส่งให้คนอื่น
        ดังนั้น admin_add_money จะถูกเมินที่เซิร์ฟเวอร์
      */
      if (action === "money") {
        return;
      }

      /*
        เสกเบรอทให้ทุกคน
      */
      if (action === "spawn") {

        broadcast(room, {
          type: "admin_global",

          action: "spawn",

          species: String(msg.species || ""),

          mutation: String(
            msg.mutation || "none"
          ),

          owned: Boolean(msg.owned)
        });

        return;
      }

      /*
        โชคให้ทุกคน
      */
      if (action === "luck") {

        const multiplier =
          Number(msg.multiplier);

        const seconds =
          Number(msg.seconds);

        if (
          !Number.isFinite(multiplier) ||
          !Number.isFinite(seconds)
        ) {
          return;
        }

        room.globalLuck = {
          multiplier,
          until:
            Date.now() +
            Math.max(0, seconds * 1000)
        };

        broadcast(room, {
          type: "admin_global",

          action: "luck",

          multiplier,

          seconds
        });

        return;
      }

      /*
        คำสั่งอื่นจาก Admin
        ส่งให้ทุกคน
      */
      if (action === "global") {

        broadcast(room, {
          type: "admin_global",

          action: "global",

          data: msg.data ?? null
        });

        return;
      }

      /*
        ล้างของที่เป็นระบบกลาง
      */
      if (action === "clear_global") {

        broadcast(room, {
          type: "admin_global",

          action: "clear_global"
        });

        return;
      }
    }
  });

  ws.on("close", () => {

    if (!player || !room) return;

    room.players.delete(player.id);

    /*
      ไม่ลบห้อง
      เพื่อให้ผู้เล่นกลับเข้าห้องเดิมได้
    */

    broadcastRoom(room);
  });
});

httpServer.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `BlockWorld Server running on port ${PORT}`
    );
  }
);
