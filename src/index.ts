import { Hono } from 'hono'
import { connectDB, db } from './db'
import { initSchema } from './schema'
import { cors } from 'hono/cors'
import { RecordId } from 'surrealdb'
import { OAuth2Client } from 'google-auth-library'
import { SignJWT, jwtVerify } from 'jose'

const GOOGLE_CLIENT_ID = '785041222690-7l200uqtgsoio0bugjd2a1bh8bti629j.apps.googleusercontent.com'
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret-change-in-prod')
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID)

const app = new Hono()

app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],  // ← 加 PATCH
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
}))

connectDB()
.then(() => initSchema())
.catch((err) => {
  console.error('❌ 資料庫初始化失敗，請檢查 Schema 語法：', err)
})

const VERSION_LIST: Record<string, string> = {
  "10000": "maimai",       "11000": "maimai PLUS",
  "12000": "GreeN",        "13000": "GreeN PLUS",
  "14000": "ORANGE",       "15000": "ORANGE PLUS",
  "16000": "PiNK",         "17000": "PiNK PLUS",
  "18000": "MURASAKi",     "18500": "MURASAKi PLUS",
  "19000": "MiLK",         "19500": "MiLK PLUS",
  "19900": "FiNALE",       "20000": "でらっくす",
  "20500": "でらっくす PLUS", "21000": "Splash",
  "21500": "Splash PLUS",  "22000": "UNiVERSE",
  "22500": "UNiVERSE PLUS","23000": "FESTiVAL",
  "23500": "FESTiVAL PLUS","24000": "BUDDiES",
  "24500": "BUDDiES PLUS", "25000": "PRiSM",
  "25500": "PRiSM PLUS",   "26000": "CiRCLE",
  "26500": "CiRCLE PLUS",
}

function calcRating(cc: number, achievement: number): number {
  const a = Math.min(achievement, 100.5)
  let multiplier: number
  if (a >= 100.5) multiplier = 22.4
  else if (a >= 100.0) multiplier = 21.6
  else if (a >= 99.5) multiplier = 21.1
  else if (a >= 99.0) multiplier = 20.8
  else if (a >= 98.0) multiplier = 20.3
  else if (a >= 97.0) multiplier = 20.0
  else if (a >= 94.0) multiplier = 16.8
  else if (a >= 90.0) multiplier = 15.2
  else if (a >= 80.0) multiplier = 13.6
  else multiplier = 0
  return Math.floor(cc * multiplier * a / 100)
}

async function getPlayerFromToken(c: any): Promise<string | null> {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) return null
  try {
    const token = auth.slice(7)
    const { payload } = await jwtVerify(token, JWT_SECRET)
    return payload.playerId as string
  } catch {
    return null
  }
}

// ==========================================
// 基本
// ==========================================

app.get('/health', async (c) => c.json({ status: 'ok' }))

app.post('/auth/google', async (c) => {
  const { idToken } = await c.req.json()
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID })
    const payload = ticket.getPayload()!
    const email = payload.email!
    const name = payload.name ?? email

    const existing = await db.query<any[]>(`SELECT * FROM player WHERE email = $email LIMIT 1`, { email })
    let playerId: string
    if (existing[0]?.length > 0) {
      playerId = existing[0][0].id.toString()
    } else {
      const created = await db.query<any[]>(`CREATE player SET email = $email, username = $name`, { email, name })
      playerId = created[0][0].id.toString()
    }

    const token = await new SignJWT({ playerId, email })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('30d')
      .sign(JWT_SECRET)

    return c.json({ token, email })
  } catch (e) {
    return c.json({ error: 'Invalid token' }, 401)
  }
})

// ==========================================
// 成績
// ==========================================

app.post('/api/scores/sync', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)

  const scores = await c.req.json()
  let success = 0, failed = 0
  for (const score of scores) {
    const chartType = score.chart_type?.toUpperCase()
    const difficulty = score.difficulty?.toUpperCase()
    const songKey = `${score.title}_${chartType}_${difficulty}`
    try {
      await db.query(`
      INSERT INTO score {
        player: $player, song: $song, difficulty: $difficulty,
        chart_type: $chart_type, level: $level, achievement: $achievement,
        fc: $fc, sync: $sync
      } ON DUPLICATE KEY UPDATE
      achievement = $input.achievement, fc = $input.fc,
      sync = $input.sync, updated_at = time::now()
      `, {
        player: new RecordId('player', playerId.split(':')[1]),
        song: new RecordId('song', songKey),
        difficulty, chart_type: chartType, level: score.level,
        achievement: score.achievement,
        fc: score.fc || undefined,
        sync: score.sync || undefined,
      })
      success++
    } catch(e) {
      console.error('sync error:', e)
      failed++
    }
  }
  await db.query(`
  UPDATE score SET chart_constant = song.chart_constant, version = song.version
  WHERE player = $player AND chart_constant = NONE
  `, { player: new RecordId('player', playerId.split(':')[1]) })
  return c.json({ ok: true, success, failed })
})

app.get('/api/scores/all', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
  const playerKey = playerId.split(':')[1]
  const result = await db.query(`
  SELECT song.title AS title, song.chart_type AS chart_type,
  achievement, difficulty, fc, sync
  FROM score WHERE player = $player
  `, { player: new RecordId('player', playerKey) })
  return c.json(result[0])
})

app.get('/b50', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
  const playerKey = playerId.split(':')[1]

  const result = await db.query(`
  SELECT id, achievement, chart_type, difficulty, level, chart_constant, version, fc, sync,
  song.title AS title, song.image_name AS image_name
  FROM score
  WHERE chart_constant != NONE AND player = $player
  ORDER BY achievement DESC
  `, { player: new RecordId('player', playerKey) })

  const scores = result[0] as any[]
  const withRating = scores.map(s => {
    const versionNum = parseInt(s.version) || 0
    return {
      ...s,
      rating: calcRating(s.chart_constant, s.achievement) + (s.fc === 'ap' || s.fc === 'app' ? 1 : 0),
      isNew: versionNum >= 25500,
    }
  })
  const newScores = withRating.filter(s => s.isNew).sort((a, b) => b.rating - a.rating).slice(0, 15)
  const oldScores = withRating.filter(s => !s.isNew).sort((a, b) => b.rating - a.rating).slice(0, 35)
  const totalRating = [...newScores, ...oldScores].reduce((sum, s) => sum + s.rating, 0)
  return c.json({ totalRating, newScores, oldScores })
})

// ==========================================
// 歌曲
// ==========================================

let _songsCache: any[] | null = null
let _songsCacheAt = 0
const SONGS_CACHE_TTL = 60 * 60 * 1000

function buildSongMap(charts: any[]) {
  const songMap = new Map<string, any>()
  for (const chart of charts) {
    const key = `${chart.title}_${chart.chart_type}`
    if (!songMap.has(key)) {
      songMap.set(key, {
        id: key,
        title: chart.title,
        artist: chart.artist,
        image_name: chart.image_name,
        chart_type: chart.chart_type,
        aliases: chart.aliases ?? [],
        difficulties: []
      })
    }
    songMap.get(key).difficulties.push({
      difficulty: chart.difficulty,
      level: chart.level,
      chart_constant: chart.chart_constant,
      chart_designer: chart.chart_designer,
      notes_tap: chart.notes_tap,
      notes_hold: chart.notes_hold,
      notes_slide: chart.notes_slide,
      notes_touch: chart.notes_touch,
      notes_break: chart.notes_break,
    })
  }
  return Array.from(songMap.values())
}

app.get('/api/songs', async (c) => {
  const now = Date.now()
  if (_songsCache && now - _songsCacheAt < SONGS_CACHE_TTL) return c.json(_songsCache)
  try {
    const result = await db.query(`
    SELECT title, artist, image_name, chart_type, difficulty, level,
    chart_constant, chart_designer, aliases,
    notes_tap, notes_hold, notes_slide, notes_touch, notes_break
    FROM song
    `)
    _songsCache = buildSongMap(result[0] as any[])
    _songsCacheAt = now
    return c.json(_songsCache)
  } catch (error) {
    return c.json({ error: '無法獲取歌曲資料' }, 500)
  }
})

app.get('/api/songs/search', async (c) => {
  const keyword = c.req.query('q')
  if (!keyword) return c.json([])
  try {
    const result = await db.query(`
    SELECT title, artist, image_name, chart_type, difficulty, level,
    chart_constant, chart_designer, aliases,
    notes_tap, notes_hold, notes_slide, notes_touch, notes_break,
    search::score(1) AS relevance_score
    FROM song
    WHERE title @1@ $keyword OR artist @1@ $keyword
    ORDER BY relevance_score DESC LIMIT 100
    `, { keyword })
    return c.json(buildSongMap(result[0] as any[]))
  } catch (error) {
    return c.json({ error: '搜尋失敗' }, 500)
  }
})

app.post('/api/songs/cache/clear', async (c) => {
  _songsCache = null
  _songsCacheAt = 0
  return c.json({ ok: true })
})

// ==========================================
// 📝 待打清單
// ==========================================

app.get('/api/todo', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
  const result = await db.query(`
  SELECT * FROM todo WHERE player = $player ORDER BY created_at DESC
  `, { player: new RecordId('player', playerId.split(':')[1]) })
  return c.json(result[0])
})

app.post('/api/todo', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
  const playerKey = playerId.split(':')[1]
  const { title, chart_type, image_name, difficulty, target_achievement, target_fc, source } = await c.req.json()
  const songKey = `${title}_${chart_type}_${difficulty}`
  try {
    await db.query(`
    INSERT INTO todo {
      player: $player, song_key: $song_key, title: $title,
      chart_type: $chart_type, image_name: $image_name, difficulty: $difficulty,
      target_achievement: $target_achievement, target_fc: $target_fc,
      source: $source, done: false
    } ON DUPLICATE KEY UPDATE
    target_achievement = $input.target_achievement,
    target_fc = $input.target_fc, done = false
    `, {
      player: new RecordId('player', playerKey),
      song_key: songKey, title, chart_type, image_name, difficulty,
      target_achievement: target_achievement || undefined,
      target_fc: target_fc || undefined,
      source: source || 'manual',
    })
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: 'Failed' }, 500)
  }
})

app.patch('/api/todo/:id', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
  const { done } = await c.req.json()
  await db.query(`UPDATE $id SET done = $done`, {
    id: new RecordId('todo', c.req.param('id')), done,
  })
  return c.json({ ok: true })
})

app.delete('/api/todo/:id', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
  await db.query(`DELETE $id`, { id: new RecordId('todo', c.req.param('id')) })
  return c.json({ ok: true })
})

// ==========================================
// 🏆 牌子統計
// ==========================================

app.get('/api/badge-progress', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
  const playerKey = playerId.split(':')[1]

  const [scoresResult, songsResult] = await Promise.all([
    db.query(`SELECT song, achievement, fc FROM score WHERE player = $player`,
      { player: new RecordId('player', playerKey) }),
    db.query(`SELECT id, title, chart_type, difficulty, version, image_name FROM song WHERE difficulty != 'REMASTER'`),
  ])

  const allCharts = songsResult[0] as any[]
  const scoreMap = new Map<string, any>()
  for (const s of scoresResult[0] as any[]) {
    scoreMap.set(s.song.toString(), s)
  }

  const versionMap = new Map<string, any>()
  for (const chart of allCharts) {
    const ver = chart.version ?? '0'
    if (!versionMap.has(ver)) {
      versionMap.set(ver, {
        total: 0, sss: 0, fc: 0, ap: 0, app: 0,
        missing: { sss: [], fc: [], ap: [], app: [] }
      })
    }
    const v = versionMap.get(ver)!
    v.total++

    const score = scoreMap.get(chart.id.toString())
    const achievement = score?.achievement ?? 0
    const fcVal = score?.fc ?? null
    const info = { title: chart.title, chart_type: chart.chart_type, difficulty: chart.difficulty, image_name: chart.image_name, achievement, fc: fcVal }

    if (achievement >= 100.0) v.sss++
    else v.missing.sss.push(info)

    if (['fc', 'fcp', 'ap', 'app'].includes(fcVal)) v.fc++
    else v.missing.fc.push(info)

    if (['ap', 'app'].includes(fcVal)) v.ap++
    else v.missing.ap.push(info)

    if (fcVal === 'app') v.app++
    else v.missing.app.push(info)
  }

  return c.json(
    Array.from(versionMap.entries())
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .map(([version, data]) => ({
        version,
        version_name: VERSION_LIST[version] ?? version,
        ...data,
      }))
  )
})

// ==========================================
// 👥 好友功能
// ==========================================

app.get('/api/players/search', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
  const q = c.req.query('q')
  if (!q) return c.json([])
  const result = await db.query(`
  SELECT id, username FROM player WHERE username ~ $q OR email ~ $q LIMIT 10
  `, { q })
  return c.json(result[0])
})

app.post('/api/friends/request', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
  const { toPlayerId } = await c.req.json()
  try {
    await db.query(`
    INSERT INTO friendship { from_player: $from, to_player: $to, status: 'pending' }
    `, {
      from: new RecordId('player', playerId.split(':')[1]),
      to: new RecordId('player', toPlayerId.split(':')[1]),
    })
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'Already exists' }, 400)
  }
})

app.post('/api/friends/accept', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
  const { friendshipId } = await c.req.json()
  await db.query(`UPDATE $id SET status = 'accepted' WHERE to_player = $player`, {
    id: new RecordId('friendship', friendshipId),
    player: new RecordId('player', playerId.split(':')[1]),
  })
  return c.json({ ok: true })
})

app.get('/api/friends', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
  const playerKey = playerId.split(':')[1]
  const result = await db.query(`
  SELECT id,
    from_player.username AS from_username, from_player.id AS from_id,
    to_player.username AS to_username, to_player.id AS to_id,
    status
  FROM friendship
  WHERE (from_player = $player OR to_player = $player) AND status = 'accepted'
  `, { player: new RecordId('player', playerKey) })
  return c.json(result[0])
})

app.get('/api/friends/pending', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
  const result = await db.query(`
  SELECT id, from_player.username AS from_username, from_player.id AS from_id, created_at
  FROM friendship WHERE to_player = $player AND status = 'pending'
  `, { player: new RecordId('player', playerId.split(':')[1]) })
  return c.json(result[0])
})

export default app
