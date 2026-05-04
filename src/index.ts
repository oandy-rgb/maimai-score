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
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
}))

connectDB()
.then(() => initSchema())
.catch((err) => {
  console.error('❌ 資料庫初始化失敗，請檢查 Schema 語法：', err)
})

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

app.get('/health', async (c) => {
  return c.json({ status: 'ok', db: 'connected' })
})

app.post('/auth/google', async (c) => {
  const { idToken } = await c.req.json()
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    })
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

    console.log(`✅ Google 登入成功：${email}，player: ${playerId}`)
    return c.json({ token, email })
  } catch (e) {
    console.error('Google auth error:', e)
    return c.json({ error: 'Invalid token' }, 401)
  }
})

app.get('/test', async (c) => {
  await db.query('CREATE player:test SET email = "test@test.com", username = "oandy"')
  const result = await db.query('SELECT * FROM player')
  return c.json(result)
})

app.get('/scores', async (c) => {
  const result = await db.query(`
  SELECT
  id, achievement, chart_type, difficulty, level, updated_at,
  song.title AS title,
  song.image_name AS image_name
  FROM score
  ORDER BY achievement DESC
  LIMIT 50
  `)
  return c.json(result)
})

app.post('/api/scores/sync', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const scores = await c.req.json()
  let success = 0
  let failed = 0
  for (const score of scores) {
    const chartType = score.chart_type?.toUpperCase()
    const difficulty = score.difficulty?.toUpperCase()
    const songKey = `${score.title}_${chartType}_${difficulty}`
    try {
      await db.query(`
      INSERT INTO score {
        player: $player,
        song: $song,
        difficulty: $difficulty,
        chart_type: $chart_type,
        level: $level,
        achievement: $achievement,
        fc: $fc,
        sync: $sync
      } ON DUPLICATE KEY UPDATE
      achievement = $input.achievement,
      fc = $input.fc,
      sync = $input.sync,
      updated_at = time::now()
      `, {
        player: new RecordId('player', playerId.split(':')[1]),
        song: new RecordId('song', songKey),
        difficulty,
        chart_type: chartType,
        level: score.level,
        achievement: score.achievement,
        fc: score.fc || undefined,
        sync: score.sync || undefined,
      })
      success++
    } catch(e) {
      console.error('error:', e)
      failed++
    }
  }
  console.log(`✅ 存入 ${success} 筆，失敗 ${failed} 筆`)
  await db.query(`
  UPDATE score SET
  chart_constant = song.chart_constant,
  version = song.version
  WHERE player = $player AND chart_constant = NONE
  `, { player: new RecordId('player', playerId.split(':')[1]) })
  return c.json({ ok: true, success, failed })
})

app.get('/b50', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const playerKey = playerId.split(':')[1]

  const result = await db.query(`
  SELECT
  id, achievement, chart_type, difficulty, level, chart_constant, version, fc, sync,
  song.title AS title,
  song.image_name AS image_name
  FROM score
  WHERE chart_constant != NONE
  AND player = $player
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
  const newScores = withRating
  .filter(s => s.isNew)
  .sort((a, b) => b.rating - a.rating)
  .slice(0, 15)
  const oldScores = withRating
  .filter(s => !s.isNew)
  .sort((a, b) => b.rating - a.rating)
  .slice(0, 35)
  const totalRating = [...newScores, ...oldScores].reduce((sum, s) => sum + s.rating, 0)
  return c.json({ totalRating, newScores, oldScores })
})

// 在 app 定義之後，endpoint 之前加這個
let _songsCache: any[] | null = null
let _songsCacheAt = 0
const SONGS_CACHE_TTL = 60 * 60 * 1000 // 1小時

app.get('/api/songs', async (c) => {
  const now = Date.now()
  if (_songsCache && now - _songsCacheAt < SONGS_CACHE_TTL) {
    return c.json(_songsCache)
  }

  try {
    const result = await db.query(`
    SELECT title, artist, image_name, chart_type, difficulty, level, chart_constant, chart_designer, notes_tap, notes_hold, notes_slide, notes_touch, notes_break
    FROM song
    `)

    const allCharts = result[0] as any[]
    const songMap = new Map<string, any>()

    for (const chart of allCharts) {
      const key = `${chart.title}_${chart.chart_type}`
      if (!songMap.has(key)) {
        songMap.set(key, {
          id: key,
          title: chart.title,
          artist: chart.artist,
          image_name: chart.image_name,
          chart_type: chart.chart_type,
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

    _songsCache = Array.from(songMap.values())
    _songsCacheAt = now
    return c.json(_songsCache)
  } catch (error) {
    console.error('Fetch songs error:', error)
    return c.json({ error: '無法獲取歌曲資料' }, 500)
  }
})

app.get('/api/scores/all', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)

  const playerKey = playerId.split(':')[1]
  const result = await db.query(`
  SELECT
  song.title AS title,
  song.chart_type AS chart_type,
  achievement,
  difficulty,
  fc,
  sync
  FROM score
  WHERE player = $player
  `, { player: new RecordId('player', playerKey) })

  return c.json(result[0])
})

app.get('/api/songs/search', async (c) => {
  const keyword = c.req.query('q')
  if (!keyword) return c.json([])

  try {
    const result = await db.query(`
    SELECT title, artist, image_name, chart_type, difficulty,
    level, chart_constant, chart_designer,
    notes_tap, notes_hold, notes_slide, notes_touch, notes_break,
    search::score(1) AS relevance_score
    FROM song
    WHERE title @1@ $keyword OR artist @1@ $keyword
    ORDER BY relevance_score DESC
    LIMIT 100
    `, { keyword })

    const matchedCharts = result[0] as any[]
    const songMap = new Map<string, any>()
    for (const chart of matchedCharts) {
      const key = `${chart.title}_${chart.chart_type}`
      if (!songMap.has(key)) {
        songMap.set(key, {
          id: key,
          title: chart.title,
          artist: chart.artist,
          image_name: chart.image_name,
          chart_type: chart.chart_type,
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

    return c.json(Array.from(songMap.values()))
  } catch (error) {
    console.error('Search error:', error)
    return c.json({ error: '搜尋失敗' }, 500)
  }
})

app.post('/api/songs/cache/clear', async (c) => {
  _songsCache = null
  _songsCacheAt = 0
  console.log('✅ songs cache cleared')
  return c.json({ ok: true })
})
export default app
