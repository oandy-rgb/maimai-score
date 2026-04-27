import { Hono } from 'hono'
import { connectDB, db } from './db'
import { initSchema } from './schema'
import { cors } from 'hono/cors'
import { RecordId } from 'surrealdb'

const app = new Hono()

connectDB().then(() => initSchema())
app.use('*', cors())

app.get('/health', async (c) => {
  return c.json({ status: 'ok', db: 'connected' })
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
  const scores = await c.req.json()
  let success = 0
  let failed = 0
  for (const score of scores) {
    const songKey = `${score.title}_${score.chart_type}`
    try {
      const r1 = await db.query(`
      INSERT INTO song (id, title, genre)
      VALUES ($id, $title, $genre)
      ON DUPLICATE KEY UPDATE title = $title
      `, {
        id: new RecordId('song', songKey),
                                title: score.title,
                                genre: score.genre ?? '',
      })
      console.log('song:', JSON.stringify(r1))

      const r2 = await db.query(`
      INSERT INTO score (player, song, difficulty, chart_type, level, achievement)
      VALUES ($player, $song, $difficulty, $chart_type, $level, $achievement)
      ON DUPLICATE KEY UPDATE achievement = $achievement, updated_at = time::now()
      `, {
        player: new RecordId('player', 'test'),
                                song: new RecordId('song', songKey),
                                difficulty: score.difficulty,
                                chart_type: score.chart_type,
                                level: score.level,
                                achievement: score.achievement,
      })
      console.log('score:', JSON.stringify(r2))
      success++
    } catch(e) {
      console.error('error:', e)
      failed++
    }
  }
  console.log(`✅ 存入 ${success} 筆，失敗 ${failed} 筆`)
  return c.json({ ok: true, success, failed })
})


app.get('/b50', async (c) => {
  const result = await db.query(`
  SELECT id, achievement, chart_type, difficulty, level, chart_constant, version, song.title AS title
  FROM score
  WHERE chart_constant != NONE
  ORDER BY achievement DESC
  `)
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

app.get('/test-insert', async (c) => {
  const result = await db.query(`
  CREATE song:testtest SET title = 'test', genre = 'test';
  `)
  console.log('test insert result:', JSON.stringify(result))
  return c.json(result)
})
export default app
