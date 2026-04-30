import { connectDB, db } from './db'
import { RecordId } from 'surrealdb'

const DXDATA_URL = 'https://raw.githubusercontent.com/gekichumai/dxrating/main/packages/dxdata/dxdata.json'
const DIVING_FISH_URL = 'https://www.diving-fish.com/api/maimaidxprober/music_data' // ✅ 新增水魚 API
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

  console.log(`🐟 正在下載水魚 API 以獲取官方封面 ID...`)
  const dfRes = await fetch(DIVING_FISH_URL)
  const dfData = await dfRes.json() as any[]

  console.log(`🔗 正在建立封面 ID 對照表...`)
  const imageMap: Record<string, string> = {}
  for (const song of dfData) {
    // 官方圖庫標準：不足 5 位數要補零，並加上 .png (例如 168 -> 00168.png)
    imageMap[song.title] = String(song.id).padStart(5, '0') + '.png'
  }

  console.log(`📊 共偵測到 dxdata: ${data.songs.length} 首歌, 水魚: ${dfData.length} 首歌`)

  let songUpdated = 0
  let scoreUpdated = 0

  for (const song of data.songs) {
    // 🌟 查表：從水魚的資料庫裡抓出這首歌的 5 位數檔名。極少數水魚還沒更新的新歌給預設空圖
    const finalImageName = imageMap[song.title] ?? '00000.png'

    for (const sheet of song.sheets) {
      const type = TYPE_MAP[sheet.type]
      const difficulty = DIFFICULTY_MAP[sheet.difficulty]
      if (!type || !difficulty) continue

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

        // 1. UPSERT song 表 (儲存計算後的 CC 與 5位數封面檔名)
        await db.query(`
        UPSERT $id SET
        title = $title,
        genre = $genre,
        bpm = $bpm,
        version = $version,
        chart_constant = $cc,
        image_name = $image_name
        `, {
          id: new RecordId('song', songKey),
                       title: song.title,
                       genre: song.category ?? '',
                       bpm: song.bpm ?? 0,
                       version,
                       cc: finalCC,
                       image_name: finalImageName // ✅ 寫入查出來的 00168.png 格式
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
