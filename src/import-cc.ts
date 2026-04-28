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
    // 每個 internalId 只處理一次（同首歌不同難度的 internalId 相同）
    const processedIds = new Set<number>()

    for (const sheet of song.sheets) {
      const type = TYPE_MAP[sheet.type]
      const difficulty = DIFFICULTY_MAP[sheet.difficulty]
      if (!type || !difficulty) continue

      const internalId = sheet.internalId
      const cc = sheet.internalLevelValue
      const version = sheet.version ?? ''

      // UPSERT song 表（用 internalId 當 key，只存一次）
      if (!processedIds.has(internalId)) {
        processedIds.add(internalId)
        await db.query(`
          INSERT INTO song (id, title, genre, bpm, version, chart_type, image_name)
          VALUES ($id, $title, $genre, $bpm, $version, $chart_type, $image_name)
          ON DUPLICATE KEY UPDATE title = $title, version = $version, image_name = $image_name
        `, {
          id: new RecordId('song', String(internalId)),
          title: song.title,
          genre: song.category ?? '',
          bpm: song.bpm ?? 0,
          version,
          chart_type: type,
          image_name: song.imageName ?? '',
        })
        songUpdated++
      }

      // 更新 score 表的 chart_constant 和 version
      await db.query(`
        UPDATE score SET
          chart_constant = $cc,
          version = $version
        WHERE song = $song AND difficulty = $difficulty
      `, {
        cc,
        version,
        song: new RecordId('song', String(internalId)),
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
