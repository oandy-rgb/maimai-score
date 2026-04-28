import { connectDB, db } from './db'
import { RecordId } from 'surrealdb'

const DXDATA_URL = 'https://raw.githubusercontent.com/gekichumai/dxrating/main/packages/dxdata/dxdata.json'

// 設定當前目標賽季
const TARGET_VERSION = 'CiRCLE'

const DIFFICULTY_MAP: Record<string, string> = {
  basic: 'BASIC',
  advanced: 'ADVANCED',
  expert: 'EXPERT',
  master: 'MASTER',
  remaster: 'REMASTER',
}

const TYPE_MAP: Record<string, string> = {
  dx: 'DX',
  std: 'STANDARD',
}

async function importCC() {
  await connectDB()

  console.log(`📥 正在下載最新 dxdata.json (優先匹配版本: ${TARGET_VERSION})...`)
  const res = await fetch(DXDATA_URL)
  const data = await res.json() as { songs: any[] }

  console.log(`📊 共偵測到 ${data.songs.length} 首歌`)

  let songUpdated = 0
  let scoreUpdated = 0

  for (const song of data.songs) {
    for (const sheet of song.sheets) {
      const type = TYPE_MAP[sheet.type]
      const difficulty = DIFFICULTY_MAP[sheet.difficulty]
      if (!type || !difficulty) continue

        // 改這行
        const songKey = `${song.title}_${type}_${difficulty}`

        // 取得官方各層級數據
        const intl = sheet.regionOverrides?.intl ?? {}
        const multiver = sheet.multiverInternalLevelValue
        const version = intl.version ?? sheet.version ?? ''

        // --- 定數判定邏輯：CiRCLE 優先 ---
        let finalCC: number

        // 1. 優先檢查 multiver 裡是否有當前賽季 (CiRCLE) 的特定定數
        if (multiver && typeof multiver[TARGET_VERSION] === 'number') {
          finalCC = multiver[TARGET_VERSION]
        }
        // 2. 次優先檢查國際版標註的定數
        else if (typeof intl.internalLevelValue === 'number') {
          finalCC = intl.internalLevelValue
        }
        // 3. 以上皆無則使用基礎定數
        else {
          finalCC = sheet.internalLevelValue
        }

        // 1. UPSERT song 表 (儲存計算後的 CC)
        await db.query(`
        UPSERT $id SET
        title = $title,
        genre = $genre,
        bpm = $bpm,
        version = $version,
        chart_constant = $cc
        `, {
          id: new RecordId('song', songKey),
                       title: song.title,
                       genre: song.category ?? '',
                       bpm: song.bpm ?? 0,
                       version,
                       cc: finalCC,
        })
        songUpdated++

        // 2. 更新所有玩家的 score CC 和 version
        await db.query(`
        UPDATE score SET
        chart_constant = $cc,
        version = $version
        WHERE song = $song
        `, {
          cc: finalCC,
          version,
          song: new RecordId('song', songKey),
                       difficulty,
                       chart_type: type,
        })
        scoreUpdated++
    }
  }

  console.log(`✅ song 更新：${songUpdated} 筆`)
  console.log(`✅ score 更新：${scoreUpdated} 筆`)
  process.exit(0)
}

importCC().catch(console.error)
