export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/rooms")) {
      return handleRooms(request, env, url);
    }

    if (url.pathname === "/api/records") {
      return handleRecords(request, env);
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

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validStudent(student) {
  const students = {
    1: { name: "김민준", code: [0, 2, 5] },
    2: { name: "이서윤", code: [3, 8, 12] },
    3: { name: "박지호", code: [6, 1, 15] },
  };
  const expected = students[Number(student?.id)];
  return Boolean(expected && expected.name === student?.name && Array.isArray(student?.code) && expected.code.join() === student.code.map(Number).join());
}

async function supabaseRecords(env, path, options = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY || !env.SUPABASE_APP_SECRET) throw new Error("Supabase 설정이 준비되지 않았어요.");
  return fetch(`${env.SUPABASE_URL}/rest/v1/practice_records${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_PUBLISHABLE_KEY}`,
      "x-app-api-key": env.SUPABASE_APP_SECRET,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

async function handleRecords(request, env) {
  if (request.method !== "POST") return json({ error: "지원하지 않는 요청이에요." }, 405);
  try {
    const body = await request.json();
    if (body.action === "verifyAdmin" || body.action === "adminRecords") {
      if (!env.ADMIN_PASSWORD_HASH || await sha256(String(body.password || "")) !== env.ADMIN_PASSWORD_HASH) return json({ error: "관리자 비밀번호가 맞지 않아요." }, 401);
      if (body.action === "verifyAdmin") return json({ ok: true });
      const response = await supabaseRecords(env, "?select=*&order=created_at.desc&limit=500");
      if (!response.ok) throw new Error(await response.text());
      return json({ records: await response.json() });
    }

    if (!validStudent(body.student)) return json({ error: "학생 인증 정보가 맞지 않아요." }, 401);
    if (body.action === "studentRecords") {
      const response = await supabaseRecords(env, `?select=*&student_id=eq.${Number(body.student.id)}&order=created_at.desc&limit=100`);
      if (!response.ok) throw new Error(await response.text());
      return json({ records: await response.json() });
    }
    if (body.action === "save") {
      const record = body.record || {}, payload = {
        client_id: String(record.clientId || "").slice(0, 100), student_id: Number(body.student.id), student_name: body.student.name,
        activity_type: String(record.type || "").slice(0, 50), accuracy: Math.max(0, Math.min(100, Number(record.accuracy) || 0)),
        cpm: Math.max(0, Math.min(2000, Number(record.cpm) || 0)), score: Math.max(0, Math.min(1000000, Number(record.score) || 0)),
        details: record.details && typeof record.details === "object" ? record.details : {},
      };
      if (!payload.client_id || !payload.activity_type) return json({ error: "저장할 기록이 올바르지 않아요." }, 400);
      const response = await supabaseRecords(env, "?on_conflict=client_id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(await response.text());
      return json({ ok: true });
    }
    return json({ error: "지원하지 않는 요청이에요." }, 400);
  } catch (error) {
    console.error("records", error);
    return json({ error: "공용 기록을 처리하지 못했어요." }, 500);
  }
}
