import { db, query } from '../db'
import { initSchema } from '../schema'
import {
  calcRating,
  clamp,
  expectedAchievementFromRating,
  scoreTrainingWeight,
} from '../recommend/shared'

type Row = {
  player_id: string
  song_id: string
  achievement: number
  fc: string | null
  player_rating: number | null
  title: string
  chart_type: string
  difficulty: string
  image_name: string | null
  chart_constant: number
  version: string | null
}

type Point = {
  player_id: string
  song_id: string
  achievement: number
  expected_achievement: number
  weight: number
}

const FACTORS = Number(process.env.RECOMMEND_FACTORS ?? 5)
const EPOCHS = Number(process.env.RECOMMEND_EPOCHS ?? 36)
function latentInitial(id: number, factor: number) {
  const x = Math.sin((id + 1) * 12.9898 + (factor + 1) * 78.233) * 43758.5453
  return ((x - Math.floor(x)) - 0.5) * 0.08
}

function buildPlayerRatings(rows: Row[]) {
  const byPlayer = new Map<string, Row[]>()
  const overrides = new Map<string, number>()

  for (const row of rows) {
    if (row.player_rating && Number.isFinite(Number(row.player_rating))) {
      overrides.set(row.player_id, Number(row.player_rating))
    }
    if (!byPlayer.has(row.player_id)) byPlayer.set(row.player_id, [])
    byPlayer.get(row.player_id)!.push(row)
  }

  const ratings = new Map<string, number>()
  for (const [playerId, scores] of byPlayer) {
    const override = overrides.get(playerId)
    if (override) {
      ratings.set(playerId, override)
      continue
    }

    const withRating = scores.map(score => {
      const versionNum = parseInt(score.version ?? '') || 0
      return {
        rating: calcRating(Number(score.chart_constant), Number(score.achievement)) + (score.fc === 'ap' || score.fc === 'app' ? 1 : 0),
        isNew: versionNum >= 25500,
      }
    })
    const newScores = withRating.filter(s => s.isNew).sort((a, b) => b.rating - a.rating).slice(0, 15)
    const oldScores = withRating.filter(s => !s.isNew).sort((a, b) => b.rating - a.rating).slice(0, 35)
    ratings.set(playerId, [...newScores, ...oldScores].reduce((sum, s) => sum + s.rating, 0))
  }

  return ratings
}

function trainNmf(points: Point[], factors = FACTORS, epochs = EPOCHS) {
  const players = Array.from(new Set(points.map(p => p.player_id)))
  const songs = Array.from(new Set(points.map(p => p.song_id)))
  const playerIndex = new Map(players.map((id, i) => [id, i]))
  const songIndex = new Map(songs.map((id, i) => [id, i]))
  const normalized = points.map(p => ({
    u: playerIndex.get(p.player_id)!,
    i: songIndex.get(p.song_id)!,
    r: clamp((p.achievement - p.expected_achievement + 4) / 8, 0, 1),
    w: clamp(p.weight, 0, 1),
  }))

  const userFactors = players.map((_, u) => Array.from({ length: factors }, (_, f) => Math.abs(latentInitial(u, f)) + 0.04))
  const itemFactors = songs.map((_, i) => Array.from({ length: factors }, (_, f) => Math.abs(latentInitial(i + 7919, f)) + 0.04))

  let lr = 0.026
  const reg = 0.035

  for (let epoch = 0; epoch < epochs; epoch++) {
    for (const p of normalized) {
      const uf = userFactors[p.u]
      const vf = itemFactors[p.i]
      let pred = 0
      for (let f = 0; f < factors; f++) pred += uf[f] * vf[f]

      const err = (p.r - pred) * p.w
      for (let f = 0; f < factors; f++) {
        const oldU = uf[f]
        uf[f] = Math.max(0.0001, uf[f] + lr * (err * vf[f] - reg * uf[f]))
        vf[f] = Math.max(0.0001, vf[f] + lr * (err * oldU - reg * vf[f]))
      }
    }
    lr *= 0.94
  }

  return { players, songs, playerFactors: userFactors, songFactors: itemFactors }
}

async function loadRows() {
  const ownRows = await query<Row>(`
    SELECT score.player_id, score.song_id, score.achievement, score.fc,
      NULL::integer AS player_rating,
      song.title, song.chart_type, song.difficulty, song.image_name,
      COALESCE(score.chart_constant, song.chart_constant) AS chart_constant,
      COALESCE(score.version, song.version) AS version
    FROM score
    JOIN song ON song.id = score.song_id
    WHERE score.achievement IS NOT NULL
      AND COALESCE(score.chart_constant, song.chart_constant) IS NOT NULL
  `)

  const observedRows = await query<Row>(`
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
  `)

  return [...ownRows, ...observedRows]
}

async function main() {
  await initSchema()
  const rows = await loadRows()
  const playerRatings = buildPlayerRatings(rows)
  const filteredRows = rows.filter(row => scoreTrainingWeight(row, playerRatings.get(row.player_id) ?? 0) > 0)
  const points = filteredRows.map(row => {
    const playerRating = playerRatings.get(row.player_id) ?? 0
    return {
      player_id: row.player_id,
      song_id: row.song_id,
      achievement: Number(row.achievement),
      expected_achievement: expectedAchievementFromRating(playerRating, Number(row.chart_constant)),
      weight: scoreTrainingWeight(row, playerRating),
    }
  })

  const model = trainNmf(points)
  const songMeta = Object.fromEntries(
    rows.map(row => [row.song_id, {
      title: row.title,
      chart_type: row.chart_type,
      difficulty: row.difficulty,
      image_name: row.image_name,
      chart_constant: Number(row.chart_constant),
      version: row.version,
    }]),
  )

  const payload = {
    factors: FACTORS,
    epochs: EPOCHS,
    player_ratings: Object.fromEntries(playerRatings),
    song_meta: songMeta,
    ...model,
  }

  await query(`
    INSERT INTO recommend_model (
      id, status, factors, trained_at, input_score_count,
      input_player_count, input_song_count, model
    )
    VALUES ('latest', 'ready', $1, now(), $2, $3, $4, $5::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      factors = EXCLUDED.factors,
      trained_at = EXCLUDED.trained_at,
      input_score_count = EXCLUDED.input_score_count,
      input_player_count = EXCLUDED.input_player_count,
      input_song_count = EXCLUDED.input_song_count,
      model = EXCLUDED.model,
      error = NULL
  `, [
    FACTORS,
    points.length,
    model.players.length,
    model.songs.length,
    JSON.stringify(payload),
  ])

  console.log(`Recommend model trained: players=${model.players.length} songs=${model.songs.length} scores=${points.length} factors=${FACTORS}`)
}

main()
.catch(async (error) => {
  console.error('Recommend model training failed:', error)
  await query(`
    INSERT INTO recommend_model (id, status, factors, model, error)
    VALUES ('latest', 'failed', $1, '{}'::jsonb, $2)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      trained_at = now(),
      error = EXCLUDED.error
  `, [FACTORS, error instanceof Error ? error.message : String(error)])
  process.exitCode = 1
})
.finally(async () => {
  await db.end()
})
