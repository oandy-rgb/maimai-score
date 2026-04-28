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

function getCC(sheet: any): number {
  const mv = sheet.multiverInternalLevelValue ?? {}
  return mv['CiRCLE'] ?? sheet.internalLevelValue
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
      if (!sheet.internalId) continue

      const songId = `${sheet.internalId}_${type}`
      const cc = getCC(sheet)
      const version = sheet.version ?? ''

      // UPSERT song 表
      await db.query(`
      INSERT INTO song (id, title, genre, bpm, version, chart_constant, image_name, internal_id, chart_type)
      VALUES ($id, $title, $genre, $bpm, $version, $cc, $image_name, $internal_id, $chart_type)
      ON DUPLICATE KEY UPDATE chart_constant = $cc, version = $version, image_name = $image_name
      `,  {
        id: new RecordId('song', songId),
        title: song.title,
        genre: song.category ?? '',
        bpm: song.bpm ?? 0,
        version,
        cc,
        image_name: song.imageName ?? '',
        song_internal_id: sheet.internalId,
        chart_type: type,
      })
      songUpdated++

      // 更新所有 player 的 score CC 和 version
      await db.query(`
        UPDATE score SET
          chart_constant = $cc,
          version = $version
        WHERE song = $song AND difficulty = $difficulty
      `, {
        cc,
        version,
        song: new RecordId('song', songId),
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
