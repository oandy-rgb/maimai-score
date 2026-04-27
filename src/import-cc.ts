import { connectDB, db } from './db'
import { RecordId } from 'surrealdb'

const DXDATA_URL = 'https://raw.githubusercontent.com/gekichumai/dxrating/main/packages/dxdata/dxdata.json'

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

  console.log('📥 下載 dxdata.json...')
  const res = await fetch(DXDATA_URL)
  const data = await res.json() as { songs: any[] }

  console.log(`📊 共 ${data.songs.length} 首歌`)

  let songUpdated = 0
  let scoreUpdated = 0

  for (const song of data.songs) {
    for (const sheet of song.sheets) {
      const type = TYPE_MAP[sheet.type]
      const difficulty = DIFFICULTY_MAP[sheet.difficulty]
      if (!type || !difficulty) continue

      const songKey = `${song.title}_${type}`
      const cc = sheet.internalLevelValue
      const version = sheet.version ?? ''

      // 1. UPSERT song 表（全局共用）
      await db.query(`
        INSERT INTO song (id, title, genre, bpm, version, chart_constant)
        VALUES ($id, $title, $genre, $bpm, $version, $cc)
        ON DUPLICATE KEY UPDATE chart_constant = $cc, version = $version
      `, {
        id: new RecordId('song', songKey),
        title: song.title,
        genre: song.category ?? '',
        bpm: song.bpm ?? 0,
        version,
        cc,
      })
      songUpdated++

      // 2. 更新所有 player 的 score CC 和 version
      await db.query(`
        UPDATE score SET
          chart_constant = $cc,
          version = $version
        WHERE song = $song AND difficulty = $difficulty
      `, {
        cc,
        version,
        song: new RecordId('song', songKey),
        difficulty,
      })
      scoreUpdated++
    }
  }

  console.log(`✅ song 更新：${songUpdated} 筆`)
  console.log(`✅ score 更新：${scoreUpdated} 筆`)
  process.exit(0)
}

importCC().catch(console.error)
