import { connectDB, db } from './db'
import { RecordId } from 'surrealdb'

const DXDATA_URL = 'https://raw.githubusercontent.com/gekichumai/dxrating/main/packages/dxdata/dxdata.json'
const DIVING_FISH_URL = 'https://www.diving-fish.com/api/maimaidxprober/music_data'
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

  console.log(`🔗 正在建立封面 ID 對照表 (雙源整合中)...`)
  const imageMap: Record<string, string> = {}

  // 來源一：水魚 API (建立基礎國服資料)
  for (const song of dfData) {
    if (song.id) {
      imageMap[song.title] = String(song.id).padStart(5, '0') + '.png'
    }
  }

  // 🌟 來源二：自動抓取 Lxns API (國際服/日服最新曲目) 🌟
  console.log(`🌍 正在連接 Lxns API 獲取國際服/日服最新曲目...`)
  try {
    // Lxns 的公開 API，會一次回傳所有曲目的官方 ID
    const LXNS_URL = 'https://maimai.lxns.net/api/v0/maimai/song/list'
    const lxnsRes = await fetch(LXNS_URL)

    if (!lxnsRes.ok) {
      throw new Error(`HTTP Error: ${lxnsRes.status}`);
    }

    const lxnsData = await lxnsRes.json() as any

    // Lxns 回傳格式為 { success: true, data: [...] }
    if (lxnsData.success && lxnsData.data) {
      let patchCount = 0
      for (const song of lxnsData.data) {
        if (song.id) {
          // 將官方 ID 轉換成五位數圖片檔名
          const fileName = String(song.id).padStart(5, '0') + '.png'

          // 如果水魚沒有這首歌，就用 Lxns 的資料補上！
          if (!imageMap[song.title]) {
            imageMap[song.title] = fileName
            patchCount++
          }
        }
      }
      console.log(`✨ 成功從 Lxns 自動補齊了 ${patchCount} 首新歌！`)
    }
  } catch (error) {
    console.warn(`⚠️ 無法連接 Lxns API，將僅使用水魚資料。原因:`, error)
  }

  console.log(`📊 共偵測到 dxdata: ${data.songs.length} 首歌`)

  // ✅ 確保這兩個變數宣告在所有迴圈的最外面
  let songUpdated = 0
  let scoreUpdated = 0

  for (const song of data.songs) {
    const finalImageName = imageMap[song.title] ?? '00000.png'

    for (const sheet of song.sheets) {
      const type = TYPE_MAP[sheet.type]
      const difficulty = DIFFICULTY_MAP[sheet.difficulty]
      if (!type || !difficulty) continue

        const songKey = `${song.title}_${type}_${difficulty}`

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

        // UPSERT song 表
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
                       image_name: finalImageName
        })
        songUpdated++ // ✅ 這裡現在可以正確讀取到外部宣告的變數了

        // UPDATE score 表
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
