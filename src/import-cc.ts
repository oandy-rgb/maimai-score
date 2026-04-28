import { connectDB, db } from './db'
import { RecordId } from 'surrealdb'

const DXDATA_URL = 'https://raw.githubusercontent.com/gekichumai/dxrating/main/packages/dxdata/dxdata.json'
const TARGET_VERSION = 'CiRCLE'

async function importCC() {
  await connectDB()
  const res = await fetch(DXDATA_URL)
  const data = await res.json() as { songs: any[] }

  console.log(`📥 正在同步 ${data.songs.length} 首歌...`)

  for (const song of data.songs) {
    const internalId = parseInt(song.songId)
    // 整理各難度的 CC，索引 0-4 對應 B, A, E, M, ReM
    const ccList = [0, 0, 0, 0, 0]
    const diffIdx: Record<string, number> = { basic:0, advanced:1, expert:2, master:3, remaster:4 }

    for (const sheet of song.sheets) {
      const idx = diffIdx[sheet.difficulty]
      if (idx === undefined) continue

        const intl = sheet.regionOverrides?.intl ?? {}
        const multiver = sheet.multiverInternalLevelValue
        let finalCC = sheet.internalLevelValue

        if (multiver?.[TARGET_VERSION]) {
          finalCC = multiver[TARGET_VERSION]
        } else if (intl.internalLevelValue) {
          finalCC = intl.internalLevelValue
        }
        ccList[idx] = finalCC
    }

    // 寫入歌曲，ID 使用 song:internalId
    await db.query(`
    INSERT INTO song (id, internalId, title, genre, bpm, version, chart_constant)
    VALUES ($id, $internalId, $title, $genre, $bpm, $version, $cc)
    ON DUPLICATE KEY UPDATE chart_constant = $cc, version = $version
    `, {
      id: new RecordId('song', internalId.toString()),
                   internalId,
                   title: song.title,
                   genre: song.category ?? '',
                   bpm: song.bpm ?? 0,
                   version: song.version ?? '',
                   cc: ccList,
    })
  }

  console.log(`✅ 歌曲庫同步完畢`)
  process.exit(0)
}

importCC().catch(console.error)
