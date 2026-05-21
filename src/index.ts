import { Hono } from "hono";
import { connectDB, query, one, transaction } from "./db";
import { initSchema } from "./schema";
import { cors } from "hono/cors";
import { OAuth2Client } from "google-auth-library";
import { SignJWT, jwtVerify } from "jose";
import { createHash } from "node:crypto";
import { buildNmfResponseFromModel } from "./recommend/inference";
import { calcRating } from "./recommend/shared";

const GOOGLE_CLIENT_ID =
  "785041222690-7l200uqtgsoio0bugjd2a1bh8bti629j.apps.googleusercontent.com";
if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is required in production");
}
const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "dev-secret-change-in-prod",
);
const FRIEND_CODE_PEPPER =
  process.env.FRIEND_CODE_PEPPER ??
  process.env.JWT_SECRET ??
  "dev-friend-code-pepper";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const app = new Hono();
const SONGS_CACHE_MS = Number(process.env.SONGS_CACHE_MS ?? 10 * 60_000);
const RECOMMEND_RESPONSE_CACHE_MS = Number(
  process.env.RECOMMEND_RESPONSE_CACHE_MS ?? 5 * 60_000,
);
const SYNC_BODY_LIMIT_BYTES = Number(
  process.env.SYNC_BODY_LIMIT_BYTES ?? 5_000_000,
);
const FRIEND_OBSERVATIONS_BODY_LIMIT_BYTES = Number(
  process.env.FRIEND_OBSERVATIONS_BODY_LIMIT_BYTES ?? 5_000_000,
);

const toRecordId = (table: string, id: string) => `${table}:${id}`;
const fromRecordId = (id: string, table?: string) => {
  const prefix = table ? `${table}:` : "";
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
};

function publicScore(row: any) {
  return { ...row, id: toRecordId("score", row.id) };
}

function publicSong(row: any) {
  return { ...row, id: toRecordId("song", row.id) };
}

function uniqueBy<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = getKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueLastBy<T>(items: T[], getKey: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(getKey(item), item);
  }
  return Array.from(map.values());
}

function buildValues(rows: any[][]) {
  const values: any[] = [];
  const placeholders = rows.map((row) => {
    const start = values.length;
    values.push(...row);
    return `(${row.map((_, i) => `$${start + i + 1}`).join(", ")})`;
  });
  return { placeholders: placeholders.join(", "), values };
}

function normalizeFriendCode(value: unknown) {
  const normalized = String(value ?? "").replace(/\D/g, "");
  return normalized.length >= 6 ? normalized : null;
}

function hashFriendCode(value: string) {
  return createHash("sha256")
    .update(`${FRIEND_CODE_PEPPER}:${value}`)
    .digest("hex");
}

type JsonReadResult =
  | { ok: true; value: any }
  | { ok: false; status: 400 | 413; error: string };

async function readLimitedJson(
  c: any,
  maxBytes: number,
): Promise<JsonReadResult> {
  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, status: 413, error: "Payload too large" };
  }

  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return { ok: false, status: 413, error: "Payload too large" };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON" };
  }
}

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
let songsCache: { data: any[]; expiresAt: number } | null = null;
const recommendResponseCache = new Map<
  string,
  { value: any; expiresAt: number }
>();

function clearSongsCache() {
  songsCache = null;
}

function getClientIp(c: any) {
  const forwarded =
    c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "";
  return (
    forwarded.split(",")[0].trim() || c.req.header("x-real-ip") || "unknown"
  );
}

function rateLimit(max: number, windowMs: number, scope: string) {
  return async (c: any, next: any) => {
    const now = Date.now();
    const auth = c.req.header("Authorization") ?? "";
    const tokenKey = auth.startsWith("Bearer ") ? auth.slice(7, 23) : "";
    const key = `${scope}:${getClientIp(c)}:${tokenKey}`;
    const bucket = rateLimitBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      return c.json({ error: "Too many requests", retryAfter }, 429, {
        "Retry-After": String(retryAfter),
      });
    }

    bucket.count++;
    return next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }
  for (const [key, cached] of recommendResponseCache) {
    if (cached.expiresAt <= now) recommendResponseCache.delete(key);
  }
}, 60_000).unref?.();

const allowedOrigins = new Set([
  process.env.FRONTEND_ORIGIN ?? "https://mai.o-andy.com",
  "https://maimaidx-eng.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin)
        return process.env.FRONTEND_ORIGIN ?? "https://mai.o-andy.com";
      return allowedOrigins.has(origin) ? origin : null;
    },
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

app.use("/auth/google", rateLimit(10, 60_000, "auth"));
app.use("/api/scores/sync", rateLimit(30, 60_000, "sync"));
app.use(
  "/api/maimai-friends/observations",
  rateLimit(15, 60_000, "friend-observations"),
);
app.use("/api/recommend/nmf", rateLimit(20, 60_000, "recommend-nmf"));
app.use("/api/songs", rateLimit(30, 60_000, "songs"));
app.use("/api/*", rateLimit(80, 60_000, "api"));
app.use("/b50", rateLimit(20, 60_000, "b50"));

connectDB()
  .then(() => initSchema())
  .catch((err) => {
    console.error("❌ 資料庫初始化失敗，請檢查 Schema 語法：", err);
  });

const VERSION_LIST: Record<string, string> = {
  "10000": "maimai",
  "11000": "maimai PLUS",
  "12000": "GreeN",
  "13000": "GreeN PLUS",
  "14000": "ORANGE",
  "15000": "ORANGE PLUS",
  "16000": "PiNK",
  "17000": "PiNK PLUS",
  "18000": "MURASAKi",
  "18500": "MURASAKi PLUS",
  "19000": "MiLK",
  "19500": "MiLK PLUS",
  "19900": "FiNALE",
  "20000": "DX",
  "20500": "DX PLUS",
  "21000": "Splash",
  "21500": "Splash PLUS",
  "22000": "UNiVERSE",
  "22500": "UNiVERSE PLUS",
  "23000": "FESTiVAL",
  "23500": "FESTiVAL PLUS",
  "24000": "BUDDiES",
  "24500": "BUDDiES PLUS",
  "25000": "PRiSM",
  "25500": "PRiSM PLUS",
  "26000": "CiRCLE",
  "26500": "CiRCLE PLUS",
};

interface AuthPayload {
  playerId: string;
  email?: string;
}

async function getAuthFromToken(c: any): Promise<AuthPayload | null> {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    const token = auth.slice(7);
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return {
      playerId: payload.playerId as string,
      email: payload.email as string | undefined,
    };
  } catch {
    return null;
  }
}

async function getPlayerFromToken(c: any): Promise<string | null> {
  return (await getAuthFromToken(c))?.playerId ?? null;
}

function isAdminEmail(email?: string) {
  const adminEmails = new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  return !!email && adminEmails.has(email.toLowerCase());
}

function normalizeUsername(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 16);
}

async function buildUniqueUsername(base: string) {
  const normalized = normalizeUsername(base);
  const fallback = normalized.length >= 2 ? normalized : "Player";

  for (let i = 0; i < 20; i++) {
    const suffix = i === 0 ? "" : String(i + 1);
    const candidate = `${fallback.slice(0, 16 - suffix.length)}${suffix}`;
    const exists = await one(
      `SELECT id FROM player WHERE username = $1 LIMIT 1`,
      [candidate],
    );
    if (!exists) return candidate;
  }

  return `Player${Math.random().toString(36).slice(2, 8)}`;
}

async function ensurePlayerExists(
  playerId: string,
  email?: string,
  username?: string,
) {
  const playerKey = fromRecordId(playerId, "player");

  if (email) {
    const existing = await one(
      `SELECT id FROM player WHERE email = $1 LIMIT 1`,
      [email],
    );
    if (existing) {
      if (username) {
        await query(`UPDATE player SET in_game_name = $1 WHERE id = $2`, [
          username,
          existing.id,
        ]);
      }
      return existing.id as string;
    }
  }

  const uniqueUsername = await buildUniqueUsername(
    username ?? email?.split("@")[0] ?? "Player",
  );
  const created = await one(
    `
    INSERT INTO player (id, email, username, in_game_name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (id) DO UPDATE SET
      email = COALESCE(player.email, EXCLUDED.email),
      username = COALESCE(player.username, EXCLUDED.username),
      in_game_name = COALESCE(EXCLUDED.in_game_name, player.in_game_name)
    RETURNING id
  `,
    [playerKey, email ?? null, uniqueUsername, username ?? null],
  );

  return created.id as string;
}

// ==========================================
// 基本
// ==========================================

app.get("/health", async (c) => c.json({ status: "ok" }));

app.get("/api/me", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);

  const player = await one(
    `SELECT username, in_game_name, email FROM player WHERE id = $1`,
    [fromRecordId(playerId, "player")],
  );
  if (!player) return c.json({ error: "Not found" }, 404);

  return c.json({
    username: player.username,
    in_game_name: player.in_game_name,
    display_name:
      player.username ||
      player.in_game_name ||
      player.email?.split("@")[0] ||
      "Player",
    is_admin: isAdminEmail(player.email),
  });
});

app.post("/auth/google", async (c) => {
  const { idToken } = await c.req.json();
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload()!;
    const email = payload.email!;
    const name = payload.name ?? email;

    const existing = await one(
      `SELECT * FROM player WHERE email = $1 LIMIT 1`,
      [email],
    );
    let playerId: string;
    let currentUsername: string;

    if (existing) {
      playerId = toRecordId("player", existing.id);
      currentUsername = existing.username;
    } else {
      const username = await buildUniqueUsername(name || email.split("@")[0]);
      const created = await one(
        `INSERT INTO player (email, username)
         VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET
           email = EXCLUDED.email
         RETURNING *`,
        [email, username],
      );
      playerId = toRecordId("player", created.id);
      currentUsername = created.username;
    }

    const token = await new SignJWT({ playerId, email })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("30d")
      .sign(JWT_SECRET);

    return c.json({ token, email, username: currentUsername });
  } catch (e) {
    return c.json({ error: "Invalid token" }, 401);
  }
});

// ==========================================
// 成績
// ==========================================

// version index（官網 ?version=N）對應到 VERSION_LIST 的 key
const VERSION_INDEX_TO_CODE: Record<number, string> = {
  0: "10000",
  1: "11000",
  2: "12000",
  3: "13000",
  4: "14000",
  5: "15000",
  6: "16000",
  7: "17000",
  8: "18000",
  9: "18500",
  10: "19000",
  11: "19500",
  12: "19900",
  13: "20000",
  14: "20500",
  15: "21000",
  16: "21500",
  17: "22000",
  18: "22500",
  19: "23000",
  20: "23500",
  21: "24000",
  22: "24500",
  23: "25000",
  24: "25500",
  25: "26000",
};

app.post("/api/scores/sync", async (c) => {
  const auth = await getAuthFromToken(c);
  if (!auth?.playerId) return c.json({ error: "Unauthorized" }, 401);

  const parsed = await readLimitedJson(c, SYNC_BODY_LIMIT_BYTES);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  const body = parsed.value;

  try {
    const result = await processSyncJob(auth.playerId, body, auth.email);
    return c.json({ ok: true, ...result });
  } catch (error) {
    console.error("sync failed:", error);
    return c.json({ error: "Sync failed" }, 500);
  }
});

async function processSyncJob(playerId: string, body: any, email?: string) {
  const { playerName, danImgUrl, iconImgUrl, scores } = body;
  const playerKey = await ensurePlayerExists(playerId, email, playerName);

  // 1. 更新玩家資訊
  if (playerName) {
    await query(
      "UPDATE player SET in_game_name = $1, dan_img_url = $2, icon_img_url = $3 WHERE id = $4",
      [playerName, danImgUrl, iconImgUrl, playerKey],
    );
  }

  if (!Array.isArray(scores) || scores.length === 0) {
    return { scores: 0, noAchievement: 0 };
  }

  // 2. 收集資料，分組處理
  const versionGroups = new Map<
    string,
    { versionCode: string; chartType: string; titles: string[] }
  >();
  let scoreRecords: any[] = [];
  let score_historyRecords: any[] = [];
  let noAchievementRecords: any[] = [];

  for (const score of scores) {
    const chartType = score.chart_type?.toUpperCase();
    const difficulty = score.difficulty?.toUpperCase();
    const songKey = `${score.title}_${chartType}_${difficulty}`;
    const versionCode =
      score.version_index != null
        ? (VERSION_INDEX_TO_CODE[score.version_index] ?? null)
        : null;

    // 收集 MASTER 的版本分組（用於批次更新 song.version）
    if (versionCode && difficulty === "MASTER") {
      const groupKey = `${versionCode}_${chartType}`;
      if (!versionGroups.has(groupKey)) {
        versionGroups.set(groupKey, { versionCode, chartType, titles: [] });
      }
      versionGroups.get(groupKey)!.titles.push(score.title);
    }

    // 收集 score 資料
    if (score.achievement === null || score.achievement === undefined) {
      // 沒有成績：只寫 version
      noAchievementRecords.push({
        id: `${playerKey}_${songKey}`,
        player_id: playerKey,
        song_id: songKey,
        difficulty,
        chart_type: chartType,
        level: score.level ?? "",
        version: versionCode ?? undefined,
      });
    } else {
      scoreRecords.push({
        id: `${playerKey}_${songKey}`,
        player_id: playerKey,
        song_id: songKey,
        difficulty,
        chart_type: chartType,
        level: score.level ?? "",
        achievement: score.achievement,
        fc: score.fc || undefined,
        sync: score.sync || undefined,
        dx_score: score.dx_score ?? undefined,
        dx_total: score.dx_total ?? undefined,
        dx_stars: score.dx_stars ?? undefined,
        version: versionCode ?? undefined,
      });

      score_historyRecords.push({
        id: `${playerKey}_${songKey}_${Date.now()}`,
        player_id: playerKey,
        song_id: songKey,
        difficulty,
        chart_type: chartType,
        level: score.level ?? "",
        achievement: score.achievement,
        fc: score.fc || undefined,
        sync: score.sync || undefined,
        dx_score: score.dx_score ?? undefined,
        dx_total: score.dx_total ?? undefined,
        dx_stars: score.dx_stars ?? undefined,
        version: versionCode ?? undefined,
        synced_at: new Date().toISOString(),
      });
    }
  }

  scoreRecords = uniqueLastBy(
    scoreRecords,
    (record) => `${record.player_id}_${record.song_id}`,
  );
  noAchievementRecords = uniqueLastBy(
    noAchievementRecords,
    (record) => `${record.player_id}_${record.song_id}`,
  );

  // 3. 批次更新 song.version（按版本分組，一次 UPDATE）
  for (const { versionCode, chartType, titles } of versionGroups.values()) {
    // 更新 MASTER
    await query(
      `UPDATE song SET version = $1 WHERE title = ANY($2::text[]) AND chart_type = $3 AND difficulty = 'MASTER'`,
      [versionCode, titles, chartType],
    );
    // 同步更新 BASIC/ADVANCED/EXPERT
    for (const diff of ["BASIC", "ADVANCED", "EXPERT"]) {
      await query(
        `UPDATE song SET version = $1 WHERE title = ANY($2::text[]) AND chart_type = $3 AND difficulty = $4`,
        [versionCode, titles, chartType, diff],
      );
    }
  }

  // REMASTER 版本也更新
  const remasterGroups = new Map<
    string,
    { versionCode: string; chartType: string; titles: string[] }
  >();
  for (const score of scores) {
    const chartType = score.chart_type?.toUpperCase();
    const difficulty = score.difficulty?.toUpperCase();
    const versionCode =
      score.version_index != null
        ? (VERSION_INDEX_TO_CODE[score.version_index] ?? null)
        : null;
    if (versionCode && difficulty === "REMASTER") {
      const groupKey = `${versionCode}_${chartType}`;
      if (!remasterGroups.has(groupKey)) {
        remasterGroups.set(groupKey, { versionCode, chartType, titles: [] });
      }
      remasterGroups.get(groupKey)!.titles.push(score.title);
    }
  }
  for (const { versionCode, chartType, titles } of remasterGroups.values()) {
    await query(
      `UPDATE song SET version = $1 WHERE title = ANY($2::text[]) AND chart_type = $3 AND difficulty = 'REMASTER'`,
      [versionCode, titles, chartType],
    );
  }

  // 4. Bulk INSERT score（有成績的）
  const CHUNK = 200;
  await transaction(async (client) => {
    for (let i = 0; i < scoreRecords.length; i += CHUNK) {
      const chunk = scoreRecords.slice(i, i + CHUNK);
      const { placeholders, values } = buildValues(
        chunk.map((record) => [
          record.id,
          record.player_id,
          record.song_id,
          record.difficulty,
          record.chart_type,
          record.level,
          record.achievement,
          record.fc,
          record.sync,
          record.dx_score,
          record.dx_total,
          record.dx_stars,
          record.version,
        ]),
      );

      await client.query(
        `
          INSERT INTO score (
            id, player_id, song_id, difficulty, chart_type, level, achievement,
            fc, sync, dx_score, dx_total, dx_stars, version
          )
          VALUES ${placeholders}
          ON CONFLICT (player_id, song_id) DO UPDATE SET
            achievement = EXCLUDED.achievement,
            fc = EXCLUDED.fc,
            sync = EXCLUDED.sync,
            updated_at = now(),
            dx_score = EXCLUDED.dx_score,
            dx_total = EXCLUDED.dx_total,
            dx_stars = EXCLUDED.dx_stars,
            version = EXCLUDED.version
        `,
        values,
      );

      const historyChunk = score_historyRecords.slice(i, i + CHUNK);
      const { placeholders: historyPlaceholders, values: historyValues } =
        buildValues(
          historyChunk.map((record) => [
            record.id,
            record.player_id,
            record.song_id,
            record.difficulty,
            record.chart_type,
            record.level,
            record.achievement,
            record.fc,
            record.sync,
            record.dx_score,
            record.dx_total,
            record.dx_stars,
            record.version,
            record.synced_at,
          ]),
        );
      await client.query(
        `
        INSERT INTO score_history (
          id, player_id, song_id, difficulty, chart_type, level, achievement,
          fc, sync, dx_score, dx_total, dx_stars, version, synced_at
        )
        VALUES ${historyPlaceholders}
      `,
        historyValues,
      );
    }

    // 5. Bulk INSERT 沒有成績的（只寫 version，不覆蓋成績）
    for (let i = 0; i < noAchievementRecords.length; i += CHUNK) {
      const chunk = noAchievementRecords.slice(i, i + CHUNK);
      const { placeholders, values } = buildValues(
        chunk.map((record) => [
          record.id,
          record.player_id,
          record.song_id,
          record.difficulty,
          record.chart_type,
          record.level,
          record.version,
        ]),
      );

      await client.query(
        `
          INSERT INTO score (id, player_id, song_id, difficulty, chart_type, level, version)
          VALUES ${placeholders}
          ON CONFLICT (player_id, song_id) DO UPDATE SET
            version = EXCLUDED.version
        `,
        values,
      );
    }
  });

  console.log(
    `✅ sync 完成 player=${playerKey} scores=${scoreRecords.length} noAchievement=${noAchievementRecords.length}`,
  );
  return {
    scores: scoreRecords.length,
    noAchievement: noAchievementRecords.length,
  };
}

app.get("/api/scores/all", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const playerKey = fromRecordId(playerId, "player");
  const result = await query(
    `
      SELECT song.title AS title, song.chart_type AS chart_type,
        score.achievement, score.difficulty, score.fc, score.sync,
        score.dx_score, score.dx_total, score.dx_stars
      FROM score
      JOIN song ON song.id = score.song_id
      WHERE score.player_id = $1
    `,
    [playerKey],
  );
  return c.json(result);
});

app.get("/b50", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const playerKey = fromRecordId(playerId, "player");
  // 🌟 新增：查詢玩家資訊
  const pInfo =
    (await one(
      `
      SELECT username, in_game_name, dan_img_url, icon_img_url FROM player WHERE id = $1
    `,
      [playerKey],
    )) ?? {};

  const result = await query(
    `
      SELECT score.id, score.achievement, score.chart_type, score.difficulty, score.level,
        COALESCE(score.chart_constant, song.chart_constant) AS chart_constant,
        COALESCE(score.version, song.version) AS version,
        score.fc, score.sync, song.title AS title, song.image_name AS image_name
      FROM score
      JOIN song ON song.id = score.song_id
      WHERE COALESCE(score.chart_constant, song.chart_constant) IS NOT NULL
        AND score.player_id = $1
      ORDER BY score.achievement DESC
    `,
    [playerKey],
  );

  const scores = uniqueBy(
    result.map(publicScore),
    (s: any) => `${s.title}_${s.chart_type}_${s.difficulty}`,
  );
  const withRating = scores.map((s) => {
    const versionNum = parseInt(s.version) || 0;
    return {
      ...s,
      rating:
        calcRating(s.chart_constant, s.achievement) +
        (s.fc === "ap" || s.fc === "app" ? 1 : 0),
      isNew: versionNum >= 25500,
    };
  });
  const newScores = withRating
    .filter((s) => s.isNew)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 15);
  const oldScores = withRating
    .filter((s) => !s.isNew)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 35);
  const totalRating = [...newScores, ...oldScores].reduce(
    (sum, s) => sum + s.rating,
    0,
  );
  return c.json({
    totalRating,
    newScores,
    oldScores,
    username: pInfo.username,
    in_game_name: pInfo.in_game_name,
    dan_img_url: pInfo.dan_img_url,
    icon_img_url: pInfo.icon_img_url,
  });
});

// src/index.ts

app.get("/api/proxy-image", async (c) => {
  // 從 Query String 取得想要抓取的圖片網址
  const targetUrl = c.req.query("url");
  if (!targetUrl) return c.json({ error: "Missing URL parameter" }, 400);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return c.json({ error: "Invalid URL" }, 400);
  }

  const allowedImageHosts = new Set([
    "cdn.jsdelivr.net",
    "maimaidx.jp",
    "maimaidx-eng.com",
    "maimaidx-eng.sega.com",
  ]);

  if (
    parsedUrl.protocol !== "https:" ||
    !allowedImageHosts.has(parsedUrl.hostname)
  ) {
    return c.json({ error: "Image host not allowed" }, 400);
  }

  try {
    // 讓後端發送請求去抓圖片 (加上 User-Agent 模擬一般瀏覽器避免被擋)
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        // 如果官方圖片有極嚴格的防盜連，可以嘗試在這裡加上 Referer: 'https://maimaidx-eng.com/'
      },
    });

    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.statusText}`);
    }

    // 將圖片轉換為二進位 ArrayBuffer
    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("Content-Type") || "image/png";

    // 🌟 關鍵回傳：將二進位資料直接回傳，並加上允許跨域的 Header
    return c.body(arrayBuffer, 200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*", // 👈 解除 Canvas 封鎖的關鍵
      "Cache-Control": "public, max-age=86400", // 快取一天，避免頻繁請求官方伺服器
    });
  } catch (e) {
    console.error("Proxy Error:", e);
    return c.json({ error: "Failed to proxy image" }, 500);
  }
});
// ==========================================
// 歌曲
// ==========================================

function buildSongMap(charts: any[]) {
  const songMap = new Map<string, any>();
  for (const chart of charts) {
    const key = `${chart.title}_${chart.chart_type}_${chart.image_name}`;
    if (!songMap.has(key)) {
      songMap.set(key, {
        id: key,
        title: chart.title,
        artist: chart.artist,
        bpm: chart.bpm,
        image_name: chart.image_name,
        chart_type: chart.chart_type,
        aliases: chart.aliases ?? [],
        date_intl_added: chart.date_intl_added ?? null,
        date_intl_updated: chart.date_intl_updated ?? null,
        date_added: chart.date_added ?? null,
        date_updated: chart.date_updated ?? null,
        difficulties: [],
      });
    }
    const entry = songMap.get(key);
    // 取最早的 date_intl_added
    if (
      chart.date_intl_added &&
      (!entry.date_intl_added || chart.date_intl_added < entry.date_intl_added)
    ) {
      entry.date_intl_added = chart.date_intl_added;
    }
    // 取最晚的 date_intl_updated
    if (
      chart.date_intl_updated &&
      (!entry.date_intl_updated ||
        chart.date_intl_updated > entry.date_intl_updated)
    ) {
      entry.date_intl_updated = chart.date_intl_updated;
    }
    entry.difficulties.push({
      difficulty: chart.difficulty,
      level: chart.level,
      chart_constant: chart.chart_constant,
      chart_designer: chart.chart_designer,
      notes_tap: chart.notes_tap,
      notes_hold: chart.notes_hold,
      notes_slide: chart.notes_slide,
      notes_touch: chart.notes_touch,
      notes_break: chart.notes_break,
    });
  }
  return Array.from(songMap.values());
}

app.get("/api/songs", async (c) => {
  try {
    const now = Date.now();
    c.header(
      "Cache-Control",
      "public, max-age=600, stale-while-revalidate=3600",
    );

    if (songsCache && songsCache.expiresAt > now) {
      return c.json(songsCache.data);
    }

    const result = await query(`
      SELECT song.title, song.artist, song.bpm, song.image_name, song.chart_type, song.difficulty, song.level,
      song.chart_constant, song.chart_designer,
      ARRAY(
        SELECT DISTINCT alias
        FROM unnest(COALESCE(song.aliases, '{}'::text[]) || COALESCE(approved_alias.aliases, '{}'::text[])) alias
        WHERE alias <> ''
        ORDER BY alias
      ) AS aliases,
      song.date_intl_added, song.date_intl_updated, song.date_added, song.date_updated,
      song.notes_tap, song.notes_hold, song.notes_slide, song.notes_touch, song.notes_break
      FROM song
      LEFT JOIN (
        SELECT title, chart_type, array_agg(alias ORDER BY alias) AS aliases
        FROM song_alias_suggestion
        WHERE status = 'approved'
        GROUP BY title, chart_type
      ) approved_alias ON approved_alias.title = song.title AND approved_alias.chart_type = song.chart_type
    `);
    const songs = buildSongMap(result);
    songsCache = { data: songs, expiresAt: now + SONGS_CACHE_MS };
    return c.json(songs);
  } catch (error) {
    return c.json({ error: "無法獲取歌曲資料" }, 500);
  }
});

app.post("/api/songs/aliases", async (c) => {
  const auth = await getAuthFromToken(c);
  if (!auth?.playerId) return c.json({ error: "Unauthorized" }, 401);

  if (!isAdminEmail(auth.email)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = await c.req.json();
  const title = String(body.title ?? "").trim();
  const chartType = String(body.chart_type ?? body.chartType ?? "")
    .trim()
    .toUpperCase();
  const alias = String(body.alias ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title || !["STANDARD", "DX"].includes(chartType)) {
    return c.json({ error: "Missing song identity" }, 400);
  }
  if (alias.length < 1 || alias.length > 50) {
    return c.json({ error: "Alias length must be 1-50 characters" }, 400);
  }
  if (alias.toLowerCase() === title.toLowerCase()) {
    return c.json({ error: "Alias is the same as title" }, 400);
  }

  const existingRows = await query(
    `
    SELECT aliases
    FROM song
    WHERE title = $1 AND chart_type = $2
    LIMIT 1
  `,
    [title, chartType],
  );

  if (existingRows.length === 0)
    return c.json({ error: "Song not found" }, 404);

  const aliases = Array.isArray(existingRows[0].aliases)
    ? existingRows[0].aliases
    : [];
  const hasAlias = aliases.some(
    (item: string) => item.toLowerCase() === alias.toLowerCase(),
  );
  const nextAliases = hasAlias ? aliases : [...aliases, alias];

  await query(
    `
    UPDATE song
    SET aliases = $3
    WHERE title = $1 AND chart_type = $2
  `,
    [title, chartType, nextAliases],
  );

  await query(
    `
    INSERT INTO song_alias_suggestion (
      title, chart_type, alias, suggested_by_player_id,
      status, reviewed_by_player_id, reviewed_at
    )
    VALUES ($1, $2, $3, $4, 'approved', $4, now())
    ON CONFLICT (title, chart_type, alias) DO UPDATE SET
      status = 'approved',
      reviewed_by_player_id = EXCLUDED.reviewed_by_player_id,
      reviewed_at = now()
  `,
    [title, chartType, alias, fromRecordId(auth.playerId, "player")],
  );

  clearSongsCache();
  return c.json({
    ok: true,
    title,
    chart_type: chartType,
    aliases: nextAliases,
  });
});

app.post("/api/songs/alias-suggestions", async (c) => {
  const auth = await getAuthFromToken(c);
  if (!auth?.playerId) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json();
  const title = String(body.title ?? "").trim();
  const chartType = String(body.chart_type ?? body.chartType ?? "")
    .trim()
    .toUpperCase();
  const alias = String(body.alias ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title || !["STANDARD", "DX"].includes(chartType)) {
    return c.json({ error: "Missing song identity" }, 400);
  }
  if (alias.length < 1 || alias.length > 50) {
    return c.json({ error: "Alias length must be 1-50 characters" }, 400);
  }
  if (alias.toLowerCase() === title.toLowerCase()) {
    return c.json({ error: "Alias is the same as title" }, 400);
  }

  const song = await one(
    `
    SELECT aliases
    FROM song
    WHERE title = $1 AND chart_type = $2
    LIMIT 1
  `,
    [title, chartType],
  );

  if (!song) return c.json({ error: "Song not found" }, 404);

  const aliases = Array.isArray(song.aliases) ? song.aliases : [];
  if (
    aliases.some((item: string) => item.toLowerCase() === alias.toLowerCase())
  ) {
    return c.json({ ok: true, status: "already_exists" });
  }

  const inserted = await one(
    `
    INSERT INTO song_alias_suggestion (title, chart_type, alias, suggested_by_player_id)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (title, chart_type, alias) DO UPDATE SET
      suggested_by_player_id = COALESCE(song_alias_suggestion.suggested_by_player_id, EXCLUDED.suggested_by_player_id)
    RETURNING id, status
  `,
    [title, chartType, alias, fromRecordId(auth.playerId, "player")],
  );

  return c.json({
    ok: true,
    id: toRecordId("song_alias_suggestion", inserted.id),
    status: inserted.status,
  });
});

app.get("/api/admin/song-alias-suggestions", async (c) => {
  const auth = await getAuthFromToken(c);
  if (!auth?.playerId) return c.json({ error: "Unauthorized" }, 401);
  if (!isAdminEmail(auth.email)) return c.json({ error: "Forbidden" }, 403);

  const status = c.req.query("status") ?? "pending";
  if (!["pending", "approved", "rejected", "all"].includes(status)) {
    return c.json({ error: "Invalid status" }, 400);
  }

  const rows = await query(
    `
    SELECT sug.id, sug.title, sug.chart_type, sug.alias, sug.status,
      sug.created_at, sug.reviewed_at, player.email AS suggested_by_email
    FROM song_alias_suggestion sug
    LEFT JOIN player ON player.id = sug.suggested_by_player_id
    WHERE $1 = 'all' OR sug.status = $1
    ORDER BY sug.created_at DESC
    LIMIT 200
  `,
    [status],
  );

  return c.json(
    rows.map((row: any) => ({
      ...row,
      id: toRecordId("song_alias_suggestion", row.id),
    })),
  );
});

app.post("/api/admin/song-alias-suggestions/:id/review", async (c) => {
  const auth = await getAuthFromToken(c);
  if (!auth?.playerId) return c.json({ error: "Unauthorized" }, 401);
  if (!isAdminEmail(auth.email)) return c.json({ error: "Forbidden" }, 403);

  const id = fromRecordId(c.req.param("id"), "song_alias_suggestion");
  const body = await c.req.json();
  const action = String(body.action ?? "").trim();
  if (!["approve", "reject"].includes(action))
    return c.json({ error: "Invalid action" }, 400);

  const suggestion = await one(
    `
    SELECT id, title, chart_type, alias, status
    FROM song_alias_suggestion
    WHERE id = $1
    LIMIT 1
  `,
    [id],
  );
  if (!suggestion) return c.json({ error: "Suggestion not found" }, 404);

  if (action === "reject") {
    await query(
      `
      UPDATE song_alias_suggestion
      SET status = 'rejected', reviewed_by_player_id = $2, reviewed_at = now()
      WHERE id = $1
    `,
      [id, fromRecordId(auth.playerId, "player")],
    );
    return c.json({ ok: true, status: "rejected" });
  }

  const song = await one(
    `
    SELECT aliases
    FROM song
    WHERE title = $1 AND chart_type = $2
    LIMIT 1
  `,
    [suggestion.title, suggestion.chart_type],
  );
  if (!song) return c.json({ error: "Song not found" }, 404);

  const aliases = Array.isArray(song.aliases) ? song.aliases : [];
  const hasAlias = aliases.some(
    (item: string) => item.toLowerCase() === suggestion.alias.toLowerCase(),
  );
  const nextAliases = hasAlias ? aliases : [...aliases, suggestion.alias];

  await transaction(async (client) => {
    await client.query(
      `
      UPDATE song
      SET aliases = $3
      WHERE title = $1 AND chart_type = $2
    `,
      [suggestion.title, suggestion.chart_type, nextAliases],
    );
    await client.query(
      `
      UPDATE song_alias_suggestion
      SET status = 'approved', reviewed_by_player_id = $2, reviewed_at = now()
      WHERE id = $1
    `,
      [id, fromRecordId(auth.playerId, "player")],
    );
  });

  clearSongsCache();
  return c.json({
    ok: true,
    status: "approved",
    title: suggestion.title,
    chart_type: suggestion.chart_type,
    aliases: nextAliases,
  });
});

// ==========================================
// 📝 待打清單
// ==========================================

app.get("/api/todo", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const result = await query(
    `
      SELECT id, song_key, title, chart_type, image_name, difficulty,
        target_achievement, target_fc, source, done, created_at
      FROM todo WHERE player_id = $1 ORDER BY created_at DESC
    `,
    [fromRecordId(playerId, "player")],
  );
  return c.json(
    result.map((row: any) => ({ ...row, id: toRecordId("todo", row.id) })),
  );
});

function normalizeTargetAchievement(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(101, Math.round(n * 10) / 10));
}

app.post("/api/todo", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const playerKey = fromRecordId(playerId, "player");
  const {
    title,
    chart_type,
    image_name,
    difficulty,
    target_achievement,
    target_fc,
    source,
  } = await c.req.json();
  const songKey = `${title}_${chart_type}_${difficulty}`;
  try {
    await query(
      `
        INSERT INTO todo (
          player_id, song_key, title, chart_type, image_name, difficulty,
          target_achievement, target_fc, source, done
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)
        ON CONFLICT (player_id, song_key) DO UPDATE SET
          target_achievement = EXCLUDED.target_achievement,
          target_fc = EXCLUDED.target_fc,
          done = false
      `,
      [
        playerKey,
        songKey,
        title,
        chart_type,
        image_name,
        difficulty,
        normalizeTargetAchievement(target_achievement),
        target_fc || null,
        source || "manual",
      ],
    );
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "Failed" }, 500);
  }
});

app.patch("/api/todo/:id", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json();
  const updates: string[] = [];
  const values: any[] = [];

  if ("done" in body) {
    values.push(Boolean(body.done));
    updates.push(`done = $${values.length}`);
  }
  if ("target_achievement" in body) {
    values.push(normalizeTargetAchievement(body.target_achievement));
    updates.push(`target_achievement = $${values.length}`);
  }
  if ("target_fc" in body) {
    values.push(body.target_fc || null);
    updates.push(`target_fc = $${values.length}`);
  }

  if (updates.length === 0)
    return c.json({ error: "No fields to update" }, 400);

  values.push(
    fromRecordId(c.req.param("id"), "todo"),
    fromRecordId(playerId, "player"),
  );
  await query(
    `UPDATE todo SET ${updates.join(", ")} WHERE id = $${values.length - 1} AND player_id = $${values.length}`,
    values,
  );
  return c.json({ ok: true });
});

app.delete("/api/todo/:id", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  await query(`DELETE FROM todo WHERE id = $1 AND player_id = $2`, [
    fromRecordId(c.req.param("id"), "todo"),
    fromRecordId(playerId, "player"),
  ]);
  return c.json({ ok: true });
});

// ==========================================
// 🏆 牌子統計
// ==========================================

const VERSION_BADGE_NAME: Record<string, string> = {
  "10000": "真",
  "11000": "真",
  "12000": "超",
  "13000": "檄",
  "14000": "橙",
  "15000": "暁",
  "16000": "桃",
  "17000": "櫻",
  "18000": "紫",
  "18500": "菫",
  "19000": "白",
  "19500": "雪",
  "19900": "輝",
  "20000": "熊",
  "20500": "華",
  "21000": "爽",
  "21500": "煌",
  "22000": "宙",
  "22500": "星",
  "23000": "祭",
  "23500": "祝",
  "24000": "双",
  "24500": "宴",
  "25000": "鏡",
  "25500": "彩",
  "26000": "丸",
};

const BADGE_DIFFS = ["BASIC", "ADVANCED", "EXPERT", "MASTER"] as const;

function buildBadgeProgress(allCharts: any[], scores: any[]) {
  const scoreMap = new Map<string, any>();
  for (const s of scores) scoreMap.set(s.song?.toString() ?? "", s);

  const versionMap = new Map<string, any>();
  for (const chart of allCharts) {
    const score = scoreMap.get(chart.id?.toString() ?? "");
    const achievement = score?.achievement ?? 0;
    const fcVal = score?.fc ?? null;
    const syncVal = score?.sync ?? null;
    const ver = chart.version ?? "10000";

    if (!versionMap.has(ver)) {
      versionMap.set(ver, {
        total: 0,
        sss: 0,
        fc: 0,
        ap: 0,
        fdx: 0,
        difficulties: { BASIC: [], ADVANCED: [], EXPERT: [], MASTER: [] },
      });
    }
    const v = versionMap.get(ver)!;
    v.total++;

    const isSss = achievement >= 100.0;
    const isFc = ["fc", "fcp", "ap", "app"].includes(fcVal);
    const isAp = ["ap", "app"].includes(fcVal);
    const isFdx = syncVal === "fdx" || syncVal === "fdxp";

    if (isSss) v.sss++;
    if (isFc) v.fc++;
    if (isAp) v.ap++;
    if (isFdx) v.fdx++;

    const diff = chart.difficulty as string;
    if (BADGE_DIFFS.includes(diff as any)) {
      v.difficulties[diff].push({
        title: chart.title,
        chart_type: chart.chart_type,
        image_name: chart.image_name,
        chart_constant: chart.chart_constant,
        achievement,
        fc: fcVal,
        sync: syncVal,
        sss: isSss,
        fc_badge: isFc,
        ap: isAp,
        fdx: isFdx,
      });
    }
  }

  return Array.from(versionMap.entries())
    .sort(([a], [b]) => parseInt(a) - parseInt(b))
    .map(([version, data]) => ({
      version,
      version_name: VERSION_LIST[version] ?? version,
      badge_name: VERSION_BADGE_NAME[version] ?? "",
      has_sho: parseInt(version) >= 12000,
      ...data,
    }));
}

app.get("/api/badge-progress", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const playerKey = fromRecordId(playerId, "player");

  const [scoresResult, songsResult] = await Promise.all([
    query(
      `SELECT 'song:' || song_id AS song, achievement, fc, sync, version FROM score WHERE player_id = $1`,
      [playerKey],
    ),
    query(
      `SELECT id, title, chart_type, difficulty, version, image_name, chart_constant FROM song WHERE difficulty != 'REMASTER'`,
    ),
  ]);

  return c.json(buildBadgeProgress(songsResult.map(publicSong), scoresResult));
});

// ==========================================
// 🎯 推薦系統
// ==========================================

const RANK_THRESHOLDS = [
  { rank: "SSS+", min: 100.5 },
  { rank: "SSS", min: 100.0 },
  { rank: "SS+", min: 99.5 },
  { rank: "SS", min: 99.0 },
  { rank: "S+", min: 98.0 },
  { rank: "S", min: 97.0 },
  { rank: "AAA", min: 94.0 },
  { rank: "AA", min: 90.0 },
  { rank: "A", min: 80.0 },
  { rank: "B", min: 0 },
];

function getRank(achievement: number): string {
  return RANK_THRESHOLDS.find((r) => achievement >= r.min)?.rank ?? "B";
}

function getNextRankThreshold(achievement: number): number | null {
  for (let i = RANK_THRESHOLDS.length - 1; i >= 0; i--) {
    if (achievement < RANK_THRESHOLDS[i].min) {
      return RANK_THRESHOLDS[i].min;
    }
  }
  return null; // 已經 SSS+
}

app.get("/api/recommend", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const playerKey = fromRecordId(playerId, "player");

  const result = await query(
    `
      SELECT score.id, score.achievement, score.chart_type, score.difficulty,
        COALESCE(score.chart_constant, song.chart_constant) AS chart_constant,
        COALESCE(score.version, song.version) AS version,
        score.fc, score.sync, song.title AS title, song.image_name AS image_name
      FROM score
      JOIN song ON song.id = score.song_id
      WHERE COALESCE(score.chart_constant, song.chart_constant) IS NOT NULL
        AND score.player_id = $1
    `,
    [playerKey],
  );

  const scores = result.map(publicScore);

  // 算出 B50 門檻
  const withRating = scores.map((s) => {
    const versionNum = parseInt(s.version) || 0;
    return {
      ...s,
      rating: calcRating(s.chart_constant, s.achievement),
      isNew: versionNum >= 25500,
    };
  });

  const newSorted = withRating
    .filter((s) => s.isNew)
    .sort((a, b) => b.rating - a.rating);
  const oldSorted = withRating
    .filter((s) => !s.isNew)
    .sort((a, b) => b.rating - a.rating);

  const newThreshold = newSorted.length >= 15 ? newSorted[14].rating : 0;
  const oldThreshold = oldSorted.length >= 35 ? oldSorted[34].rating : 0;

  const newResult: any[] = [];
  const oldResult: any[] = [];

  for (const s of withRating) {
    const nextMin = getNextRankThreshold(s.achievement);
    if (nextMin === null) continue; // 已 SSS+，無法再提升 rank

    const nextRating = calcRating(s.chart_constant, nextMin);
    const threshold = s.isNew ? newThreshold : oldThreshold;

    // 先判斷這首歌目前是否已經在 B50 榜單內
    const in_b50 = s.isNew
      ? newSorted.slice(0, 15).some((x: any) => x.id === s.id)
      : oldSorted.slice(0, 35).some((x: any) => x.id === s.id);

    // 🌟 核心修正：
    // - 在 B50 內：實際收益 = (新 Rating - 原本的 Rating)
    // - 不在 B50 內：實際收益 = (新 Rating - 被擠掉的底線門檻 Threshold)
    const actual_gain = in_b50 ? nextRating - s.rating : nextRating - threshold;

    if (actual_gain <= 0) continue; // 打到下一 rank 仍進不了 B50 或沒進步

    const gap = nextMin - s.achievement;
    const entry = {
      title: s.title,
      chart_type: s.chart_type,
      difficulty: s.difficulty,
      image_name: s.image_name,
      chart_constant: s.chart_constant,
      current_achievement: s.achievement,
      current_rank: getRank(s.achievement),
      next_rank: getRank(nextMin),
      next_achievement: nextMin,
      current_rating: s.rating,
      next_rating: nextRating,
      rating_gain: actual_gain, // 套用正確的收益計算
      gap: parseFloat(gap.toFixed(4)),
      in_b50: in_b50,
    };

    if (s.isNew) newResult.push(entry);
    else oldResult.push(entry);
  }

  newResult.sort((a, b) => a.gap - b.gap);
  oldResult.sort((a, b) => a.gap - b.gap);

  return c.json({ new: newResult, old: oldResult });
});

app.post("/api/maimai-friends/observations", async (c) => {
  try {
    const auth = await getAuthFromToken(c);
    if (!auth?.playerId) return c.json({ error: "Unauthorized" }, 401);

    const playerKey = await ensurePlayerExists(auth.playerId, auth.email);
    const parsed = await readLimitedJson(
      c,
      FRIEND_OBSERVATIONS_BODY_LIMIT_BYTES,
    );
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    const body = parsed.value;
    const friendCode = normalizeFriendCode(
      body.friend_code ??
        body.friendCode ??
        body.friend_idx ??
        body.friend?.friend_code ??
        body.friend?.friendCode ??
        body.friend?.friend_idx ??
        body.friend?.friendIdx,
    );

    if (!friendCode) return c.json({ error: "Missing friend code" }, 400);

    const friendKey = hashFriendCode(friendCode);
    const rawScores = Array.isArray(body.scores) ? body.scores : [];
    const scores = uniqueLastBy(
      rawScores
        .map((score: any) => {
          const achievement = Number(
            score.friend_achievement ?? score.achievement,
          );
          const title = String(score.title ?? "").trim();
          const chartType = String(score.chart_type ?? "").toUpperCase();
          const difficulty = String(score.difficulty ?? "").toUpperCase();

          if (!title || !Number.isFinite(achievement)) return null;
          if (!["STANDARD", "DX"].includes(chartType)) return null;
          if (
            !["BASIC", "ADVANCED", "EXPERT", "MASTER", "REMASTER"].includes(
              difficulty,
            )
          )
            return null;

          return {
            title,
            chart_type: chartType,
            difficulty,
            level: String(score.level ?? ""),
            achievement,
            fc: score.friend?.fc ?? score.fc ?? null,
            sync: score.friend?.sync ?? score.sync ?? null,
          };
        })
        .filter(Boolean) as any[],
      (score) => `${score.title}_${score.chart_type}_${score.difficulty}`,
    );

    const friend = body.friend ?? {};
    const rating = Number(friend.rating ?? body.rating);
    const titles = Array.from(new Set(scores.map((score) => score.title)));
    const songRows = titles.length
      ? await query(
          `
          SELECT id, title, chart_type, difficulty
          FROM song
          WHERE title = ANY($1::text[])
        `,
          [titles],
        )
      : [];
    const songMap = new Map(
      songRows.map((song: any) => [
        `${song.title}_${song.chart_type}_${song.difficulty}`,
        song.id,
      ]),
    );

    const records = scores
      .map((score) => ({
        ...score,
        song_id: songMap.get(
          `${score.title}_${score.chart_type}_${score.difficulty}`,
        ),
      }))
      .filter((score) => score.song_id);

    await transaction(async (client) => {
      const existing = await client.query(
        `SELECT anonymous_number FROM maimai_friend_identity WHERE friend_idx = $1 OR friend_code_hash = $1 LIMIT 1`,
        [friendKey],
      );
      const anonymousNumber =
        existing.rows[0]?.anonymous_number ??
        (
          await client.query(
            `SELECT COALESCE(MAX(anonymous_number), 0) + 1 AS next FROM maimai_friend_identity`,
          )
        ).rows[0].next;

      await client.query(
        `
        INSERT INTO maimai_friend_identity (
          friend_idx, friend_code_hash, anonymous_number, display_name,
          rating, dan_img_url, icon_img_url, last_seen_at
        )
        VALUES ($1, $1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (friend_idx) DO UPDATE SET
          friend_code_hash = EXCLUDED.friend_code_hash,
          anonymous_number = COALESCE(maimai_friend_identity.anonymous_number, EXCLUDED.anonymous_number),
          display_name = COALESCE(EXCLUDED.display_name, maimai_friend_identity.display_name),
          rating = COALESCE(EXCLUDED.rating, maimai_friend_identity.rating),
          dan_img_url = COALESCE(EXCLUDED.dan_img_url, maimai_friend_identity.dan_img_url),
          icon_img_url = COALESCE(EXCLUDED.icon_img_url, maimai_friend_identity.icon_img_url),
          last_seen_at = now()
      `,
        [
          friendKey,
          anonymousNumber,
          friend.display_name ?? friend.displayName ?? null,
          Number.isFinite(rating) ? rating : null,
          friend.dan_img_url ?? friend.danImgUrl ?? null,
          friend.icon_img_url ?? friend.iconImgUrl ?? null,
        ],
      );

      const CHUNK = 200;
      for (let i = 0; i < records.length; i += CHUNK) {
        const chunk = records.slice(i, i + CHUNK);
        const { placeholders, values } = buildValues(
          chunk.map((record) => [
            friendKey,
            playerKey,
            record.song_id,
            record.difficulty,
            record.chart_type,
            record.level,
            record.achievement,
            record.fc,
            record.sync,
          ]),
        );

        await client.query(
          `
          INSERT INTO maimai_friend_observed_score (
            friend_idx, observer_player_id, song_id, difficulty, chart_type,
            level, achievement, fc, sync
          )
          VALUES ${placeholders}
          ON CONFLICT (friend_idx, song_id) DO UPDATE SET
            observer_player_id = EXCLUDED.observer_player_id,
            difficulty = EXCLUDED.difficulty,
            chart_type = EXCLUDED.chart_type,
            level = EXCLUDED.level,
            achievement = EXCLUDED.achievement,
            fc = EXCLUDED.fc,
            sync = EXCLUDED.sync,
            observed_at = now()
        `,
          values,
        );
      }
    });

    return c.json({
      ok: true,
      friend_id: `maimai_friend:${friendKey.slice(0, 12)}`,
      anonymous: true,
      observed: records.length,
      skipped: scores.length - records.length,
    });
  } catch (error) {
    console.error("friend observations sync failed:", error);
    return c.json({ error: "Friend observations sync failed" }, 500);
  }
});

app.get("/api/recommend/nmf", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const playerKey = fromRecordId(playerId, "player");
  const cached = recommendResponseCache.get(playerKey);
  if (cached && cached.expiresAt > Date.now()) {
    return c.json(cached.value);
  }

  const ownRows = await query(`
      SELECT score.player_id, score.song_id, score.achievement, score.fc,
        NULL::integer AS player_rating,
        song.title, song.chart_type, song.difficulty, song.image_name,
        COALESCE(score.chart_constant, song.chart_constant) AS chart_constant,
        COALESCE(score.version, song.version) AS version
      FROM score
      JOIN song ON song.id = score.song_id
      WHERE score.achievement IS NOT NULL
        AND COALESCE(score.chart_constant, song.chart_constant) IS NOT NULL
    `);
  const observedRows = await query(`
      SELECT 'maimai_friend:' || obs.friend_idx AS player_id,
        obs.song_id, obs.achievement, obs.fc, ident.rating AS player_rating,
        song.title, song.chart_type, song.difficulty, song.image_name,
        song.chart_constant AS chart_constant,
        song.version AS version
      FROM maimai_friend_observed_score obs
      JOIN maimai_friend_identity ident ON ident.friend_idx = obs.friend_idx
      JOIN song ON song.id = obs.song_id
      WHERE obs.achievement IS NOT NULL
        AND song.chart_constant IS NOT NULL
    `);
  const rows = [...ownRows, ...observedRows];

  const latestModel = await one(`
      SELECT *
      FROM recommend_model
      WHERE id = 'latest' AND status = 'ready'
      LIMIT 1
    `);
  if (latestModel) {
    const cachedResponse = buildNmfResponseFromModel(
      latestModel,
      playerKey,
      rows,
    );
    if (cachedResponse) {
      recommendResponseCache.set(playerKey, {
        value: cachedResponse,
        expiresAt: Date.now() + RECOMMEND_RESPONSE_CACHE_MS,
      });
      return c.json(cachedResponse);
    }
  }

  return c.json({
    ready: false,
    reason:
      "Personalized recommendations are generated by the training script. Run bun run train:recommend or wait for the CronJob to finish.",
    model: latestModel
      ? {
          source: "cronjob",
          status: "ready",
          player_missing: true,
          trained_at: latestModel.trained_at,
        }
      : {
          source: "cronjob",
          status: "missing",
        },
    recommendations: [],
    candidates: [],
    factors: [],
  });
});

// ==========================================
// 👥 好友功能
// ==========================================

app.get("/api/players/search", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const q = c.req.query("q");
  if (!q) return c.json([]);
  const result = await query(
    `
        SELECT id, username
        FROM player
        WHERE username ILIKE '%' || $1 || '%'
        LIMIT 10
      `,
    [q],
  );
  return c.json(
    result.map((row: any) => ({ ...row, id: toRecordId("player", row.id) })),
  );
});

app.post("/api/friends/request", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const fromPlayerKey = fromRecordId(playerId, "player");
  const { toPlayerId } = await c.req.json();
  const toPlayerKey = fromRecordId(toPlayerId, "player");

  if (!toPlayerKey) return c.json({ error: "Missing target player" }, 400);
  if (fromPlayerKey === toPlayerKey)
    return c.json({ error: "Cannot add yourself" }, 400);

  try {
    await query(
      `
        INSERT INTO friendship (from_player_id, to_player_id, status)
        VALUES ($1, $2, 'pending')
      `,
      [fromPlayerKey, toPlayerKey],
    );
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "Already exists" }, 400);
  }
});

app.post("/api/friends/accept", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const { friendshipId } = await c.req.json();
  await query(
    `UPDATE friendship SET status = 'accepted' WHERE id = $1 AND to_player_id = $2 AND status = 'pending'`,
    [
      fromRecordId(friendshipId, "friendship"),
      fromRecordId(playerId, "player"),
    ],
  );
  return c.json({ ok: true });
});

app.post("/api/friends/reject", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const { friendshipId } = await c.req.json();
  await query(
    `DELETE FROM friendship WHERE id = $1 AND to_player_id = $2 AND status = 'pending'`,
    [
      fromRecordId(friendshipId, "friendship"),
      fromRecordId(playerId, "player"),
    ],
  );
  return c.json({ ok: true });
});

app.get("/api/friends", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const playerKey = fromRecordId(playerId, "player");
  const result = await query(
    `
      SELECT friendship.id,
        from_player.username AS from_username, from_player.id AS from_id,
        to_player.username AS to_username, to_player.id AS to_id,
        friendship.status
      FROM friendship
      JOIN player from_player ON from_player.id = friendship.from_player_id
      JOIN player to_player ON to_player.id = friendship.to_player_id
      WHERE (from_player_id = $1 OR to_player_id = $1) AND status = 'accepted'
    `,
    [playerKey],
  );
  return c.json(
    result.map((row: any) => ({
      ...row,
      id: toRecordId("friendship", row.id),
      from_id: toRecordId("player", row.from_id),
      to_id: toRecordId("player", row.to_id),
    })),
  );
});

app.get("/api/friends/pending", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const result = await query(
    `
      SELECT friendship.id, from_player.username AS from_username,
        from_player.id AS from_id, friendship.created_at
      FROM friendship
      JOIN player from_player ON from_player.id = friendship.from_player_id
      WHERE to_player_id = $1 AND status = 'pending'
    `,
    [fromRecordId(playerId, "player")],
  );
  return c.json(
    result.map((row: any) => ({
      ...row,
      id: toRecordId("friendship", row.id),
      from_id: toRecordId("player", row.from_id),
    })),
  );
});

app.delete("/api/friends/:friendshipId", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);

  const result = await query(
    `
    DELETE FROM friendship
    WHERE id = $1
      AND status = 'accepted'
      AND (from_player_id = $2 OR to_player_id = $2)
    RETURNING id
  `,
    [
      fromRecordId(c.req.param("friendshipId"), "friendship"),
      fromRecordId(playerId, "player"),
    ],
  );

  if (!result.length) return c.json({ error: "Friendship not found" }, 404);
  return c.json({ ok: true });
});

// ==========================================
// 👥 好友 B50
// ==========================================

app.get("/api/friends/:friendId/b50", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const playerKey = fromRecordId(playerId, "player");
  const friendId = fromRecordId(c.req.param("friendId"), "player");

  const friendCheck = await query(
    `
      SELECT id FROM friendship
      WHERE (
        (from_player_id = $1 AND to_player_id = $2) OR
        (from_player_id = $2 AND to_player_id = $1)
      ) AND status = 'accepted'
      LIMIT 1
    `,
    [playerKey, friendId],
  );

  if (!friendCheck.length) {
    return c.json({ error: "Not friends" }, 403);
  }

  const result = await query(
    `
      SELECT score.id, score.achievement, score.chart_type, score.difficulty, score.level,
        COALESCE(score.chart_constant, song.chart_constant) AS chart_constant,
        COALESCE(score.version, song.version) AS version,
        score.fc, score.sync, song.title AS title, song.image_name AS image_name
      FROM score
      JOIN song ON song.id = score.song_id
      WHERE COALESCE(score.chart_constant, song.chart_constant) IS NOT NULL
        AND score.player_id = $1
      ORDER BY score.achievement DESC
    `,
    [friendId],
  );

  const scores = result.map(publicScore);
  const withRating = scores.map((s) => {
    const versionNum = parseInt(s.version) || 0;
    return {
      ...s,
      rating:
        calcRating(s.chart_constant, s.achievement) +
        (s.fc === "ap" || s.fc === "app" ? 1 : 0),
      isNew: versionNum >= 25500,
    };
  });
  const newScores = withRating
    .filter((s) => s.isNew)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 15);
  const oldScores = withRating
    .filter((s) => !s.isNew)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 35);
  const totalRating = [...newScores, ...oldScores].reduce(
    (sum, s) => sum + s.rating,
    0,
  );
  return c.json({ totalRating, newScores, oldScores });
});

// 好友全部成績
app.get("/api/friends/:friendId/scores", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const playerKey = fromRecordId(playerId, "player");
  const friendId = fromRecordId(c.req.param("friendId"), "player");

  const friendCheck = await query(
    `
      SELECT id FROM friendship
      WHERE (
        (from_player_id = $1 AND to_player_id = $2) OR
        (from_player_id = $2 AND to_player_id = $1)
      ) AND status = 'accepted' LIMIT 1
    `,
    [playerKey, friendId],
  );
  if (!friendCheck.length) return c.json({ error: "Not friends" }, 403);

  const result = await query(
    `
        SELECT song.title AS title, song.chart_type AS chart_type,
          score.achievement, score.difficulty, score.fc, score.sync,
          song.image_name AS image_name
        FROM score
        JOIN song ON song.id = score.song_id
        WHERE score.player_id = $1
        ORDER BY score.achievement DESC
      `,
    [friendId],
  );
  return c.json(result);
});

// 好友牌子進度
app.get("/api/friends/:friendId/badge", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const playerKey = fromRecordId(playerId, "player");
  const friendId = fromRecordId(c.req.param("friendId"), "player");

  const friendCheck = await query(
    `
      SELECT id FROM friendship
      WHERE (
        (from_player_id = $1 AND to_player_id = $2) OR
        (from_player_id = $2 AND to_player_id = $1)
      ) AND status = 'accepted' LIMIT 1
    `,
    [playerKey, friendId],
  );
  if (!friendCheck.length) return c.json({ error: "Not friends" }, 403);

  const [scoresResult, songsResult] = await Promise.all([
    query(
      `SELECT 'song:' || song_id AS song, achievement, fc, sync FROM score WHERE player_id = $1`,
      [friendId],
    ),
    query(
      `SELECT id, title, chart_type, difficulty, version, image_name FROM song WHERE difficulty != 'REMASTER'`,
    ),
  ]);

  return c.json(buildBadgeProgress(songsResult.map(publicSong), scoresResult));
});

// src/index.ts

// ==========================================
// 👤 玩家設定
// ==========================================

// 玩家更名 API
// src/index.ts
app.patch("/api/player/update-name", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);

  const { newName } = await c.req.json();
  const trimmedName = normalizeUsername(newName ?? "");

  // 驗證字數規範
  if (!trimmedName || trimmedName.length < 2 || trimmedName.length > 16) {
    return c.json({ error: "名稱需為 2-16 字" }, 400);
  }

  try {
    // 執行資料庫更新
    const idPart = fromRecordId(playerId, "player");
    await query("UPDATE player SET username = $1 WHERE id = $2", [
      trimmedName,
      idPart,
    ]);
    return c.json({ ok: true });
  } catch (e: any) {
    // PostgreSQL unique violation
    if (e.code === "23505") {
      return c.json({ error: "此名稱已被佔用" }, 409);
    }
    return c.json({ error: "系統錯誤" }, 500);
  }
});

export default app;

//歷史紀錄
app.get("/api/history", async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: "Unauthorized" }, 401);
  const result = await query(
    `
    SELECT id, song_id, difficulty, chart_type, level, achievement,
      fc, sync, dx_score, dx_total, dx_stars, version, synced_at
    FROM score_history WHERE player_id = $1 ORDER BY synced_at DESC
    `,
    [fromRecordId(playerId, "player")],
  );
  return c.json(
    result.map((row: any) => ({ ...row, id: toRecordId("history", row.id) })),
  );
});
