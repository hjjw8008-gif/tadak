export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/rooms")) {
      return handleRooms(request, env, url);
    }

    if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
      return new Response("Static asset binding is unavailable.", { status: 503 });
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;

    if (!url.pathname.includes(".")) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    }

    return response;
  },
};

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

async function ensureRoomsTable(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_rooms_status_updated ON rooms(status, updated_at)"),
  ]);
}

async function readRoom(db, code) {
  const row = await db.prepare("SELECT data FROM rooms WHERE code = ?").bind(code).first();
  return row ? JSON.parse(row.data) : null;
}

async function writeRoom(db, room) {
  await db.prepare("INSERT INTO rooms(code, data, status, updated_at) VALUES(?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET data = excluded.data, status = excluded.status, updated_at = excluded.updated_at")
    .bind(room.code, JSON.stringify(room), room.status, Date.now()).run();
  return room;
}

function cleanPlayer(player) {
  if (!player || typeof player.id !== "string" || typeof player.name !== "string") return null;
  const id = player.id.slice(0, 80);
  const name = player.name.trim().slice(0, 20);
  return id && name ? { id, name } : null;
}

async function handleRooms(request, env, url) {
  if (!env.DB) return json({ error: "공용 방 저장소가 준비되지 않았어요." }, 503);
  await ensureRoomsTable(env.DB);
  const parts = url.pathname.split("/").filter(Boolean);
  const code = parts[2]?.toUpperCase();

  try {
    if (request.method === "GET" && !code) {
      const rows = await env.DB.prepare("SELECT data FROM rooms WHERE status = ? AND updated_at > ? ORDER BY updated_at DESC LIMIT 30")
        .bind("waiting", Date.now() - 86400000).all();
      return json(rows.results.map((row) => JSON.parse(row.data)));
    }

    if (request.method === "GET" && code) {
      const room = await readRoom(env.DB, code);
      return room ? json(room) : json({ error: "방을 찾을 수 없어요." }, 404);
    }

    if (request.method === "POST" && !code) {
      const body = await request.json();
      const player = cleanPlayer(body.player);
      if (!player) return json({ error: "참가자 정보가 올바르지 않아요." }, 400);
      let roomCode;
      do roomCode = Math.random().toString(36).slice(2, 6).toUpperCase();
      while (await readRoom(env.DB, roomCode));
      const room = { code: roomCode, title: String(body.title || "신나는 방").trim().slice(0, 20), host: player.id, status: "waiting", players: [player], created: Date.now() };
      return json(await writeRoom(env.DB, room), 201);
    }

    if (request.method === "POST" && code && parts[3] === "action") {
      const body = await request.json();
      const room = await readRoom(env.DB, code);
      if (!room) return json({ error: "방을 찾을 수 없어요." }, 404);

      if (body.action === "join") {
        const player = cleanPlayer(body.player);
        if (!player) return json({ error: "참가자 정보가 올바르지 않아요." }, 400);
        if (room.status !== "waiting") return json({ error: "이미 게임이 시작된 방이에요." }, 409);
        if (!room.players.some((item) => item.id === player.id)) room.players.push(player);
      } else if (body.action === "leave") {
        room.players = room.players.filter((player) => player.id !== body.playerId);
        if (!room.players.length) {
          await env.DB.prepare("DELETE FROM rooms WHERE code = ?").bind(code).run();
          return json({ deleted: true });
        }
        if (room.host === body.playerId) room.host = room.players[0].id;
      } else if (body.action === "demo") {
        room.players.push({ id: `demo-${Date.now()}`, name: ["서윤", "지호", "하늘", "다온"][room.players.length % 4] });
      } else if (body.action === "start") {
        if (room.host !== body.playerId) return json({ error: "방장만 시작할 수 있어요." }, 403);
        if (room.players.length < 2 || room.players.length % 2) return json({ error: "짝수 인원이 모여야 시작할 수 있어요." }, 409);
        room.status = "playing";
        room.tiles = body.words.map((word, index) => ({ w: word, owner: index % 2 ? "star" : "cloud" }));
      } else if (body.action === "flip") {
        const playerIndex = room.players.findIndex((player) => player.id === body.playerId);
        const team = playerIndex % 2 === 0 ? "cloud" : "star";
        if (playerIndex < 0 || team !== body.team) return json({ error: "참가자 정보를 다시 확인해 주세요." }, 403);
        const tile = room.tiles?.find((item) => item.w === body.word && item.owner !== team);
        if (!tile) return json({ error: "이미 뒤집힌 단어이거나 없는 단어예요." }, 409);
        tile.owner = team;
      } else {
        return json({ error: "지원하지 않는 방 동작이에요." }, 400);
      }

      return json(await writeRoom(env.DB, room));
    }
  } catch (error) {
    return json({ error: "방 처리 중 오류가 발생했어요.", detail: error.message }, 500);
  }

  return json({ error: "지원하지 않는 요청이에요." }, 405);
}
