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
connectDB().then(() => initSchema())
app.use('*', cors())

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
    SELECT id, achievement, chart_type, difficulty, level, updated_at, song.title AS title
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
    const songKey = `${score.title}_${score.chart_type}`
    try {
      // 不再 INSERT song，song 由 import-cc.ts 管理
      await db.query(`
      INSERT INTO score (player, song, difficulty, chart_type, level, achievement)
      VALUES ($player, $song, $difficulty, $chart_type, $level, $achievement)
      ON DUPLICATE KEY UPDATE achievement = $achievement, updated_at = time::now()
      `, {
        player: new RecordId('player', playerId.split(':')[1]),
                     song: new RecordId('song', songKey),
                     difficulty: score.difficulty,
                     chart_type: score.chart_type,
                     level: score.level,
                     achievement: score.achievement,
      })
      success++
    } catch(e) {
      console.error('error:', e)
      failed++
    }
  }
  console.log(`✅ 存入 ${success} 筆，失敗 ${failed} 筆`)
  // 同步完後自動從 song 表複製 CC 和 version
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
  console.log('b50 playerId:', playerId)
  if (!playerId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const playerKey = playerId.split(':')[1]
  console.log('b50 playerKey:', playerKey)

  const result = await db.query(`
    SELECT id, achievement, chart_type, difficulty, level, chart_constant, version, song.title AS title
    FROM score
    WHERE chart_constant != NONE
    AND player = $player
    ORDER BY achievement DESC
  `, { player: new RecordId('player', playerKey) })

  const scores = result[0] as any[]
  const NEW_VERSIONS = new Set(['PRiSM PLUS', 'CiRCLE'])
  const withRating = scores.map(s => ({
    ...s,
    rating: calcRating(s.chart_constant, s.achievement),
    isNew: NEW_VERSIONS.has(s.version),
  }))
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

export default app
