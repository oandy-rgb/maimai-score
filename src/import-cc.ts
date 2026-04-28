import { connectDB, db } from './db'
import { RecordId } from 'surrealdb'

const DXDATA_URL = 'https://raw.githubusercontent.com/gekichumai/dxrating/main/packages/dxdata/dxdata.json'
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

        // 🌟 終極正規化：拔除所有符號與空格，只留中日英文與數字
        const safeTitle = song.title.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
        const safeSongId = `\`${safeTitle}_${type}_${difficulty}\``

        const intl = sheet.regionOverrides?.intl ?? {}
        const multiver = sheet.multiverInternalLevelValue
        const version = intl.version ?? sheet.version ?? ''

        let finalCC: number
        if (multiver && typeof multiver[TARGET_VERSION] === 'number') {
          finalCC = multiver[TARGET_VERSION]
        } else if (typeof intl.internalLevelValue === 'number') {
          finalCC = intl.internalLevelValue
        } else {
          finalCC = sheet.internalLevelValue
        }

        // 1. 寫入 song 表 (現在 ID 已經包含難度了)
        await db.query(`
        INSERT INTO song (id, title, genre, bpm, version, chart_constant)
        VALUES ($id, $title, $genre, $bpm, $version, $cc)
        ON DUPLICATE KEY UPDATE chart_constant = $cc, version = $version
        `, {
          id: new RecordId('song', safeSongId),
                       title: song.title, // 存原始名稱供顯示
                       genre: song.category ?? '',
                       bpm: song.bpm ?? 0,
                       version,
                       cc: finalCC,
        })
        songUpdated++

        // 2. 更新 score 表 (因為 ID 是唯一的，只需比對 song 欄位)
        await db.query(`
        UPDATE score SET chart_constant = $cc, version = $version
        WHERE song = $song
        `, {
          cc: finalCC,
          version,
          song: new RecordId('song', safeSongId),
        })
        scoreUpdated++
    }
  }

  console.log(`✅ song 更新：${songUpdated} 筆 (每個難度皆獨立存檔)`)
  console.log(`✅ score 更新：${scoreUpdated} 筆`)
  process.exit(0)
}

importCC().catch(console.error)
