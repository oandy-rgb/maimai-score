import { Hono } from 'hono'
import { connectDB, db } from './db'
import { initSchema } from './schema'
import { cors } from 'hono/cors'
import { RecordId } from 'surrealdb'
import { OAuth2Client } from 'google-auth-library'
import { SignJWT, jwtVerify } from 'jose'

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret')
const googleClient = new OAuth2Client('785041222690-7l200uqtgsoio0bugjd2a1bh8bti629j.apps.googleusercontent.com')
const app = new Hono()

connectDB().then(() => initSchema())
app.use('*', cors())

const DIFF_TO_IDX: Record<string, number> = { 'BASIC':0, 'ADVANCED':1, 'EXPERT':2, 'MASTER':3, 'REMASTER':4 }

function calcRating(cc: number, achievement: number): number {
  if (achievement === 0 || cc === 0) return 0
    const a = Math.min(achievement, 100.5)
    let m = 0
    if (a >= 100.5) m = 22.4; else if (a >= 100.0) m = 21.6; else if (a >= 99.5) m = 21.1;
    else if (a >= 99.0) m = 20.8; else if (a >= 98.0) m = 20.3; else if (a >= 97.0) m = 20.0;
    else if (a >= 94.0) m = 16.8; else if (a >= 90.0) m = 15.2; else if (a >= 80.0) m = 13.6;
    return Math.floor(cc * m * a / 100)
}

async function getPlayerId(c: any) {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) return null
    try {
      const { payload } = await jwtVerify(auth.slice(7), JWT_SECRET)
      return (payload.playerId as string).split(':')[1]
    } catch { return null }
}

app.get('/health', async (c) => {
  return c.json({ status: 'ok', db: 'connected' })
})

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

app.get('/scores', async (c) => {
  const result = await db.query(`
  SELECT id, achievement, chart_type, difficulty, level, updated_at, song.title AS title
  FROM score ORDER BY achievement DESC LIMIT 50
  `)
  return c.json(result)
})

app.post('/api/scores/sync', async (c) => {
  const pId = await getPlayerId(c)
  if (!pId) return c.json({ error: 'Unauthorized' }, 401)

    const scores = await c.req.json()
    for (const s of scores) {
      try {
        const diff = s.difficulty.toUpperCase().replace('RE:', 'RE')
        await db.query(`
        INSERT INTO score (player, song, difficulty, chart_type, level, achievement)
        VALUES ($player, $song, $difficulty, $chart_type, $level, $achievement)
        ON DUPLICATE KEY UPDATE achievement = $achievement, updated_at = time::now()
        `, {
          player: new RecordId('player', pId),
                       song: new RecordId('song', s.songId.toString()), // 這裡是關鍵
                       difficulty: diff,
                       chart_type: s.chart_type.toUpperCase(),
                       level: s.level,
                       achievement: s.achievement
        })
      } catch (e) { console.error(`同步失敗 ID:${s.songId}`) }
    }
    return c.json({ ok: true })
})

app.get('/b50', async (c) => {
  const pId = await getPlayerId(c)
  if (!pId) return c.json({ error: 'Unauthorized' }, 401)

    const result = await db.query(`
    SELECT achievement, difficulty, chart_type,
    song.title as title, song.version as version, song.chart_constant as cc_list
    FROM score WHERE player = $player FETCH song
    `, { player: new RecordId('player', pId) })

    const raw = result[0] as any[]
    const NEW_VERSIONS = new Set(['PRiSM PLUS', 'CiRCLE'])

    const withRating = raw.map(s => {
      const cc = s.cc_list[DIFF_TO_IDX[s.difficulty]] || 0
      return {
        title: s.title,
        achievement: s.achievement,
        rating: calcRating(cc, s.achievement),
                               isNew: NEW_VERSIONS.has(s.version)
      }
    }).filter(s => s.rating > 0)

    const newScores = withRating.filter(s => s.isNew).sort((a,b) => b.rating - a.rating).slice(0, 15)
    const oldScores = withRating.filter(s => !s.isNew).sort((a,b) => b.rating - a.rating).slice(0, 35)
    const totalRating = [...newScores, ...oldScores].reduce((sum, s) => sum + s.rating, 0)

    return c.json({ totalRating, newScores, oldScores })
})

export default app
