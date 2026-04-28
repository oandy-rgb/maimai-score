import { connectDB, db } from './db'
import { RecordId } from 'surrealdb'
import { MANUAL_OVERRIDES } from './overrides'

const DXDATA_URL = 'https://raw.githubusercontent.com/gekichumai/dxrating/main/packages/dxdata/dxdata.json'

// --- 設定當前賽季版本 ---
const CURRENT_VERSION = 'CiRCLE'

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

  console.log(`📥 正在從 dxrating 下載最新 dxdata.json (目標版本: ${CURRENT_VERSION})...`)
  const res = await fetch(DXDATA_URL)
  const data = await res.json() as { songs: any[] }

  console.log(`📊 偵測到 ${data.songs.length} 首歌`)

  let songUpdated = 0
  let scoreUpdated = 0

  for (const song of data.songs) {
    for (const sheet of song.sheets) {
      const type = TYPE_MAP[sheet.type]
      const difficulty = DIFFICULTY_MAP[sheet.difficulty]
      if (!type || !difficulty) continue

        const songKey = `${song.title}_${type}`

        // 取得官方資料區塊
        const intl = sheet.regionOverrides?.intl ?? {}
        const multiver = sheet.multiverInternalLevelValue
        const version = intl.version ?? sheet.version ?? ''

        // --- 定數優先級邏輯 ---
        let officialCC: number

        // 1. 優先找 multiver 裡的 CiRCLE 數值
        if (multiver && typeof multiver[CURRENT_VERSION] === 'number') {
          officialCC = multiver[CURRENT_VERSION]
        }
        // 2. 其次找 intl 標註的國際版定數
        else if (typeof intl.internalLevelValue === 'number') {
          officialCC = intl.internalLevelValue
        }
        // 3. 最後用最外層的保底定數
        else {
          officialCC = sheet.internalLevelValue
        }

        // 4. 檢查是否有來自 overrides.ts 的絕對覆蓋
        const manualCC = MANUAL_OVERRIDES[songKey] ?? null

        // 1. UPSERT song 表 (更新定數)
        await db.query(`
        INSERT INTO song (id, title, genre, bpm, version, chart_constant, custom_chart_constant)
        VALUES ($id, $title, $genre, $bpm, $version, $cc, $manualCC)
        ON DUPLICATE KEY UPDATE
        chart_constant = $cc,
        version = $version,
        custom_chart_constant = $manualCC
        `, {
          id: new RecordId('song', songKey),
                       title: song.title,
                       genre: song.category ?? '',
                       bpm: song.bpm ?? 0,
                       version,
                       cc: officialCC, // 存入經判斷後的官方定數
                       manualCC,
        })
        songUpdated++

        // 2. 更新該歌曲關聯的所有玩家分數 (Score)
        // 邏輯：如果有手動定數就用手動的，否則用剛才判斷出的 CC
        await db.query(`
        UPDATE score SET
        chart_constant = IF $manualCC != NONE THEN $manualCC ELSE $cc END,
        version = $version
        WHERE song = $song
        AND difficulty = $difficulty
        AND chart_type = $chart_type
        `, {
          cc: officialCC,
          manualCC,
          version,
          song: new RecordId('song', songKey),
                       difficulty,
                       chart_type: type,
        })
        scoreUpdated++
    }
  }

  console.log(`✅ 同步完成！`)
  console.log(`✨ song 更新：${songUpdated} 筆`)
  console.log(`📈 score 關聯更新：${scoreUpdated} 筆`)
  process.exit(0)
}

importCC().catch((err) => {
  console.error('❌ 導入失敗:', err)
  process.exit(1)
})
