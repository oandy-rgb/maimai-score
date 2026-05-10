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
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
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
  "19900": "FiNALE",       "20000": "DX",
  "20500": "DX PLUS", "21000": "Splash",
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

    // src/index.ts 的 app.post('/auth/google', ...) 區塊
    const existing = await db.query<any[]>(`SELECT * FROM player WHERE email = $email LIMIT 1`, { email })
    let playerId: string
    let currentUsername: string // 新增變數

    if (existing[0]?.length > 0) {
      playerId = existing[0][0].id.toString()
      currentUsername = existing[0][0].username // 從資料庫抓出改過的名字
    } else {
      const created = await db.query<any[]>(`CREATE player SET email = $email, username = $name`, { email, name })
      playerId = created[0][0].id.toString()
      currentUsername = name
    }

    const token = await new SignJWT({ playerId, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('30d')
    .sign(JWT_SECRET)

    return c.json({ token, email, username: currentUsername })
  } catch (e) {
    return c.json({ error: 'Invalid token' }, 401)
  }
})

// ==========================================
// 成績
// ==========================================

// version index（官網 ?version=N）對應到 VERSION_LIST 的 key
const VERSION_INDEX_TO_CODE: Record<number, string> = {
  0:  '10000', 1:  '11000', 2:  '12000', 3:  '13000',
  4:  '14000', 5:  '15000', 6:  '16000', 7:  '17000',
  8:  '18000', 9:  '18500', 10: '19000', 11: '19500',
  12: '19900', 13: '20000', 14: '20500', 15: '21000',
  16: '21500', 17: '22000', 18: '22500', 19: '23000',
  20: '23500', 21: '24000', 22: '24500', 23: '25000',
  24: '25500', 25: '26000',
}

app.post('/api/scores/sync', async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401);

  // 🌟 修正：讀取一次 JSON 並解構出所有欄位
  const { playerName, danImgUrl, iconImgUrl, scores } = await c.req.json();
  const playerKey = playerId.split(':')[1];

  // 1. 同步更新玩家遊戲內的名稱、段位圖、頭像圖
  if (playerName) {
    await db.query(
      'UPDATE player SET in_game_name = $name, dan_img_url = $dan, icon_img_url = $icon WHERE id = $id',
      {
        id: new RecordId('player', playerKey),
        name: playerName,
        dan: danImgUrl,
        icon: iconImgUrl
      }
    );
  }

  // 2. 處理分數同步（平行處理）
  let success = 0, failed = 0;
  if (Array.isArray(scores)) {
    const PARALLEL = 10 // 每批平行處理筆數
    for (let i = 0; i < scores.length; i += PARALLEL) {
      const batch = scores.slice(i, i + PARALLEL)
      await Promise.allSettled(batch.map(async (score) => {
        const chartType = score.chart_type?.toUpperCase();
        const difficulty = score.difficulty?.toUpperCase();
        const songKey = `${score.title}_${chartType}_${difficulty}`;

        const versionCode = score.version_index != null
          ? (VERSION_INDEX_TO_CODE[score.version_index] ?? null)
          : null

        try {
          // 先更新 song.version（無論有沒有成績都更新）
          if (versionCode) {
            await db.query(
              `UPDATE $song SET version = $version`,
              { song: new RecordId('song', songKey), version: versionCode }
            )
          }

          // 沒有成績就跳過 score 寫入
          if (score.achievement === null || score.achievement === undefined) {
            return
          }

          await db.query(`
          INSERT INTO score {
            player: $player, song: $song, difficulty: $difficulty,
            chart_type: $chart_type, level: $level, achievement: $achievement,
            fc: $fc, sync: $sync,
            dx_score: $dx_score, dx_total: $dx_total, dx_stars: $dx_stars
          } ON DUPLICATE KEY UPDATE
          achievement = $input.achievement, fc = $input.fc,
          sync = $input.sync, updated_at = time::now(),
          dx_score = $input.dx_score, dx_total = $input.dx_total, dx_stars = $input.dx_stars
          `, {
            player:      new RecordId('player', playerKey),
            song:        new RecordId('song', songKey),
            difficulty,
            chart_type:  chartType,
            level:       score.level,
            achievement: score.achievement ?? null,
            fc:          score.fc   || undefined,
            sync:        score.sync || undefined,
            dx_score:    score.dx_score  ?? undefined,
            dx_total:    score.dx_total  ?? undefined,
            dx_stars:    score.dx_stars  ?? undefined,
          });
          success++;
        } catch(e) {
          console.error('sync error:', score.title, score.chart_type, score.difficulty, e);
          failed++;
        }
      }))
    }
  }

  // 更新定數與版本資訊
  await db.query(`
  UPDATE score SET chart_constant = song.chart_constant, version = song.version
  WHERE player = $player AND chart_constant = NONE
  `, { player: new RecordId('player', playerKey) });

  return c.json({ ok: true, success, failed });
});

app.get('/api/scores/all', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
    const playerKey = playerId.split(':')[1]
    const result = await db.query(`
    SELECT song.title AS title, song.chart_type AS chart_type,
    achievement, difficulty, fc, sync, dx_score, dx_total, dx_stars
    FROM score WHERE player = $player
    `, { player: new RecordId('player', playerKey) })
    return c.json(result[0])
})

app.get('/b50', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
    const playerKey = playerId.split(':')[1]
    // 🌟 新增：查詢玩家資訊
    const playerResult = await db.query(`
    SELECT username, in_game_name, dan_img_url, icon_img_url FROM player WHERE id = $player
    `, { player: new RecordId('player', playerKey) })
    const pInfo = (playerResult[0] as any[])[0] || {}

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
    return c.json({
      totalRating,
      newScores,
      oldScores,
      username: pInfo.username,
      in_game_name: pInfo.in_game_name,
      dan_img_url: pInfo.dan_img_url,
      icon_img_url: pInfo.icon_img_url
    })
})

// src/index.ts

app.get('/api/proxy-image', async (c) => {
  // 從 Query String 取得想要抓取的圖片網址
  const targetUrl = c.req.query('url');
  if (!targetUrl) return c.json({ error: 'Missing URL parameter' }, 400);

  try {
    // 讓後端發送請求去抓圖片 (加上 User-Agent 模擬一般瀏覽器避免被擋)
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                 // 如果官方圖片有極嚴格的防盜連，可以嘗試在這裡加上 Referer: 'https://maimaidx-eng.com/'
      }
    });

    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.statusText}`);
    }

    // 將圖片轉換為二進位 ArrayBuffer
    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get('Content-Type') || 'image/png';

    // 🌟 關鍵回傳：將二進位資料直接回傳，並加上允許跨域的 Header
return c.body(arrayBuffer, 200, {
  'Content-Type': contentType,
  'Access-Control-Allow-Origin': '*', // 👈 解除 Canvas 封鎖的關鍵
  'Cache-Control': 'public, max-age=86400' // 快取一天，避免頻繁請求官方伺服器
});
  } catch (e) {
    console.error('Proxy Error:', e);
    return c.json({ error: 'Failed to proxy image' }, 500);
  }
});
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
        date_intl_added:   chart.date_intl_added   ?? null,
        date_intl_updated: chart.date_intl_updated  ?? null,
        date_added:        chart.date_added         ?? null,
        date_updated:      chart.date_updated       ?? null,
        difficulties: []
      })
    }
    const entry = songMap.get(key)
    // 取最早的 date_intl_added
    if (chart.date_intl_added && (!entry.date_intl_added || chart.date_intl_added < entry.date_intl_added)) {
      entry.date_intl_added = chart.date_intl_added
    }
    // 取最晚的 date_intl_updated
    if (chart.date_intl_updated && (!entry.date_intl_updated || chart.date_intl_updated > entry.date_intl_updated)) {
      entry.date_intl_updated = chart.date_intl_updated
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
    })
  }
  return Array.from(songMap.values())
}

app.get('/api/songs', async (c) => {
  try {
    const result = await db.query(`
      SELECT title, artist, image_name, chart_type, difficulty, level,
      chart_constant, chart_designer, aliases,
      date_intl_added, date_intl_updated, date_added, date_updated,
      notes_tap, notes_hold, notes_slide, notes_touch, notes_break
      FROM song
    `)
    const songs = buildSongMap(result[0] as any[])
    return c.json(songs)
  } catch (error) {
    return c.json({ error: '無法獲取歌曲資料' }, 500)
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

const VERSION_BADGE_NAME: Record<string, string> = {
  '10000': '真',  '11000': '真',
  '12000': '超', '13000': '檄',
  '14000': '橙', '15000': '暁',
  '16000': '桃', '17000': '櫻',
  '18000': '紫', '18500': '菫',
  '19000': '白', '19500': '雪',
  '19900': '輝', '20000': '熊',
  '20500': '華', '21000': '爽',
  '21500': '煌', '22000': '宙',
  '22500': '星', '23000': '祭',
  '23500': '祝', '24000': '双',
  '24500': '宴', '25000': '鏡',
  '25500': '彩', '26000': '丸',
}

const BADGE_DIFFS = ['BASIC', 'ADVANCED', 'EXPERT', 'MASTER'] as const

function buildBadgeProgress(allCharts: any[], scores: any[]) {
  // scores 裡的資料已經跟 chart 合併，直接用 chart 的 achievement/fc/sync
  const scoreMap = new Map<string, any>()
  for (const s of scores) scoreMap.set(s.song?.toString() ?? '', s)

  const versionMap = new Map<string, any>()
  for (const chart of allCharts) {
    const ver = chart.version ?? '10000'
    if (!versionMap.has(ver)) {
      versionMap.set(ver, {
        total: 0, sss: 0, fc: 0, ap: 0, fdx: 0,
        difficulties: { BASIC: [], ADVANCED: [], EXPERT: [], MASTER: [] },
      })
    }
    const v = versionMap.get(ver)!
    v.total++

    // chart 已包含 achievement/fc/sync（從 score row 來）
    const achievement = chart.achievement ?? 0
    const fcVal       = chart.fc   ?? null
    const syncVal     = chart.sync ?? null

    const isSss = achievement >= 100.0
    const isFc  = ['fc', 'fcp', 'ap', 'app'].includes(fcVal)
    const isAp  = ['ap', 'app'].includes(fcVal)
    const isFdx = syncVal === 'fdx' || syncVal === 'fdxp'

    if (isSss) v.sss++
    if (isFc)  v.fc++
    if (isAp)  v.ap++
    if (isFdx) v.fdx++

    const diff = chart.difficulty as string
    if (BADGE_DIFFS.includes(diff as any)) {
      v.difficulties[diff].push({
        title:      chart.title,
        chart_type: chart.chart_type,
        image_name: chart.image_name,
        achievement,
        fc:       fcVal,
        sync:     syncVal,
        sss:      isSss,
        fc_badge: isFc,
        ap:       isAp,
        fdx:      isFdx,
      })
    }
  }

  return Array.from(versionMap.entries())
    .sort(([a], [b]) => parseInt(a) - parseInt(b))
    .map(([version, data]) => ({
      version,
      version_name: VERSION_LIST[version] ?? version,
      badge_name:   VERSION_BADGE_NAME[version] ?? '',
      has_sho:      parseInt(version) >= 12000,
      ...data,
    }))
}

app.get('/api/badge-progress', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
    const playerKey = playerId.split(':')[1]

    // song 列表從 score 來，只包含書籤 sync 過的歌
    const result = await db.query(`
      SELECT
        song.id AS id, song.title AS title, song.chart_type AS chart_type,
        song.difficulty AS difficulty, song.version AS version,
        song.image_name AS image_name,
        achievement, fc, sync
      FROM score
      WHERE player = $player AND song.difficulty != 'REMASTER'
      FETCH song
    `, { player: new RecordId('player', playerKey) })

    const rows = result[0] as any[]

    // 把每筆 score row 當成 chart + score 合併處理
    const charts = rows.map(r => ({
      id:         r.id,
      title:      r.title,
      chart_type: r.chart_type,
      difficulty: r.difficulty,
      version:    r.version,
      image_name: r.image_name,
    }))
    const scores = rows.map(r => ({
      song:        r.id,
      achievement: r.achievement,
      fc:          r.fc,
      sync:        r.sync,
    }))

    return c.json(buildBadgeProgress(charts, scores))
})

// ==========================================
// 🎯 推薦系統
// ==========================================

const RANK_THRESHOLDS = [
  { rank: 'SSS+', min: 100.5 },
{ rank: 'SSS',  min: 100.0 },
{ rank: 'SS+',  min: 99.5  },
{ rank: 'SS',   min: 99.0  },
{ rank: 'S+',   min: 98.0  },
{ rank: 'S',    min: 97.0  },
{ rank: 'AAA',  min: 94.0  },
{ rank: 'AA',   min: 90.0  },
{ rank: 'A',    min: 80.0  },
{ rank: 'B',    min: 0     },
]

function getRank(achievement: number): string {
  return RANK_THRESHOLDS.find(r => achievement >= r.min)?.rank ?? 'B'
}

function getNextRankThreshold(achievement: number): number | null {
  for (let i = RANK_THRESHOLDS.length - 1; i >= 0; i--) {
    if (achievement < RANK_THRESHOLDS[i].min) {
      return RANK_THRESHOLDS[i].min
    }
  }
  return null // 已經 SSS+
}

app.get('/api/recommend', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
    const playerKey = playerId.split(':')[1]

    const result = await db.query(`
    SELECT id, achievement, chart_type, difficulty, chart_constant, version, fc, sync,
    song.title AS title, song.image_name AS image_name
    FROM score
    WHERE chart_constant != NONE AND player = $player
    `, { player: new RecordId('player', playerKey) })

    const scores = result[0] as any[]

    // 算出 B50 門檻
    const withRating = scores.map(s => {
      const versionNum = parseInt(s.version) || 0
      return {
        ...s,
        rating: calcRating(s.chart_constant, s.achievement),
                                  isNew: versionNum >= 25500,
      }
    })

    const newSorted = withRating.filter(s => s.isNew).sort((a, b) => b.rating - a.rating)
    const oldSorted = withRating.filter(s => !s.isNew).sort((a, b) => b.rating - a.rating)

    const newThreshold = newSorted.length >= 15 ? newSorted[14].rating : 0
    const oldThreshold = oldSorted.length >= 35 ? oldSorted[34].rating : 0

    const newResult: any[] = []
    const oldResult: any[] = []

    for (const s of withRating) {
      const nextMin = getNextRankThreshold(s.achievement)
      if (nextMin === null) continue // 已 SSS+，無法再提升 rank

        const nextRating = calcRating(s.chart_constant, nextMin)
        const threshold = s.isNew ? newThreshold : oldThreshold

        // 先判斷這首歌目前是否已經在 B50 榜單內
        const in_b50 = s.isNew
        ? newSorted.slice(0, 15).some((x: any) => x.id === s.id)
        : oldSorted.slice(0, 35).some((x: any) => x.id === s.id)

        // 🌟 核心修正：
        // - 在 B50 內：實際收益 = (新 Rating - 原本的 Rating)
        // - 不在 B50 內：實際收益 = (新 Rating - 被擠掉的底線門檻 Threshold)
        const actual_gain = in_b50 ? (nextRating - s.rating) : (nextRating - threshold)

        if (actual_gain <= 0) continue // 打到下一 rank 仍進不了 B50 或沒進步

          const gap = nextMin - s.achievement
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
          }

          if (s.isNew) newResult.push(entry)
            else oldResult.push(entry)
    }

    newResult.sort((a, b) => a.gap - b.gap)
    oldResult.sort((a, b) => a.gap - b.gap)

    return c.json({ new: newResult, old: oldResult })
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
      SELECT id, username FROM player
      WHERE string::contains(string::lowercase(username), string::lowercase($q))
      OR string::contains(string::lowercase(email), string::lowercase($q))
      LIMIT 10
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




// ==========================================
// 👥 好友 B50
// ==========================================

app.get('/api/friends/:friendId/b50', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
    const playerKey = playerId.split(':')[1]
    const friendId = c.req.param('friendId')

    const friendCheck = await db.query(`
    SELECT id FROM friendship
    WHERE (
      (from_player = $player AND to_player = $friend) OR
      (from_player = $friend AND to_player = $player)
    ) AND status = 'accepted'
    LIMIT 1
    `, {
      player: new RecordId('player', playerKey),
                                       friend: new RecordId('player', friendId),
    })

    if (!(friendCheck[0] as any[]).length) {
      return c.json({ error: 'Not friends' }, 403)
    }

    const result = await db.query(`
    SELECT id, achievement, chart_type, difficulty, level, chart_constant, version, fc, sync,
    song.title AS title, song.image_name AS image_name
    FROM score
    WHERE chart_constant != NONE AND player = $friend
    ORDER BY achievement DESC
    `, { friend: new RecordId('player', friendId) })

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


// 好友全部成績
app.get('/api/friends/:friendId/scores', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
    const playerKey = playerId.split(':')[1]
    const friendId = c.req.param('friendId')

    const friendCheck = await db.query(`
    SELECT id FROM friendship
    WHERE (
      (from_player = $player AND to_player = $friend) OR
      (from_player = $friend AND to_player = $player)
    ) AND status = 'accepted' LIMIT 1
    `, {
      player: new RecordId('player', playerKey),
                                       friend: new RecordId('player', friendId),
    })
    if (!(friendCheck[0] as any[]).length) return c.json({ error: 'Not friends' }, 403)

      const result = await db.query(`
      SELECT song.title AS title, song.chart_type AS chart_type,
      achievement, difficulty, fc, sync, song.image_name AS image_name
      FROM score WHERE player = $friend ORDER BY achievement DESC
      `, { friend: new RecordId('player', friendId) })
      return c.json(result[0])
})

// 好友牌子進度
app.get('/api/friends/:friendId/badge', async (c) => {
  const playerId = await getPlayerFromToken(c)
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401)
    const playerKey = playerId.split(':')[1]
    const friendId = c.req.param('friendId')

    const friendCheck = await db.query(`
    SELECT id FROM friendship
    WHERE (
      (from_player = $player AND to_player = $friend) OR
      (from_player = $friend AND to_player = $player)
    ) AND status = 'accepted' LIMIT 1
    `, {
      player: new RecordId('player', playerKey),
                                       friend: new RecordId('player', friendId),
    })
    if (!(friendCheck[0] as any[]).length) return c.json({ error: 'Not friends' }, 403)

      const [scoresResult, songsResult] = await Promise.all([
        db.query(`SELECT song, achievement, fc, sync FROM score WHERE player = $friend`,
                 { friend: new RecordId('player', friendId) }),
                                                            db.query(`SELECT id, title, chart_type, difficulty, version, image_name FROM song WHERE difficulty != 'REMASTER'`),
      ])

      return c.json(buildBadgeProgress(songsResult[0] as any[], scoresResult[0] as any[]))
})

// src/index.ts

// ==========================================
// 👤 玩家設定
// ==========================================


// 玩家更名 API
// src/index.ts
app.patch('/api/player/update-name', async (c) => {
  const playerId = await getPlayerFromToken(c);
  if (!playerId) return c.json({ error: 'Unauthorized' }, 401);

  const { newName } = await c.req.json();
  const trimmedName = newName?.trim();

  // 驗證字數規範
  if (!trimmedName || trimmedName.length < 2 || trimmedName.length > 16) {
    return c.json({ error: '名稱需為 2-16 字' }, 400);
  }

  try {
    // 執行資料庫更新
    const idPart = playerId.split(':')[1];
    await db.query(
      'UPDATE player SET username = $newName WHERE id = $id',
      { id: new RecordId('player', idPart), newName: trimmedName }
    );
    return c.json({ ok: true });
  } catch (e: any) {
    // 如果名稱重複，SurrealDB 會拋出 Index 衝突錯誤
    if (e.message?.includes('already contains')) {
      return c.json({ error: '此名稱已被佔用' }, 409);
    }
    return c.json({ error: '系統錯誤' }, 500);
  }
});

export default app
