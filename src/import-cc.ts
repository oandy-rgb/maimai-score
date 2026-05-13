import { connectDB, query } from './db'
import { initSchema } from './schema'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const INTL_DB_URL = 'https://raw.githubusercontent.com/zvuc/otoge-db/refs/heads/master/maimai/data/music-ex-intl.json'

const DIFFS = [
  { key: 'bas',   name: 'BASIC'    },
  { key: 'adv',   name: 'ADVANCED' },
  { key: 'exp',   name: 'EXPERT'   },
  { key: 'mas',   name: 'MASTER'   },
  { key: 'remas', name: 'REMASTER' },
]

// ==========================================
// overrides.json（手動覆蓋錯誤版本/日期）
// 格式：{ "{title}_{chart_type}": { "date_intl_added": "YYYYMMDD", "date_intl_updated": "YYYYMMDD" } }
// ==========================================
const OVERRIDES_PATH = join(__dirname, 'overrides.json')
let overrides: Record<string, { date_intl_added?: string; date_intl_updated?: string }> = {}
if (existsSync(OVERRIDES_PATH)) {
  try {
    overrides = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8'))
    console.log(`✅ 載入 overrides.json，共 ${Object.keys(overrides).length} 條覆蓋規則`)
  } catch (e) {
    console.warn('⚠️ overrides.json 解析失敗，忽略覆蓋規則')
  }
}

// ==========================================
// 版本日期對照表（國際服上線日期，由新到舊）
// ==========================================
const VERSION_DATE_RANGES: { version: string; from: string }[] = [
  { version: '26500', from: '20260701' }, // CiRCLE PLUS（預估）
  { version: '26000', from: '20260122' }, // CiRCLE
  { version: '25500', from: '20250724' }, // PRiSM PLUS
  { version: '25000', from: '20250116' }, // PRiSM
  { version: '24500', from: '20240725' }, // BUDDiES PLUS
  { version: '24000', from: '20240118' }, // BUDDiES
  { version: '23500', from: '20230727' }, // FESTiVAL PLUS
  { version: '23000', from: '20230119' }, // FESTiVAL
  { version: '22500', from: '20220728' }, // UNiVERSE PLUS
  { version: '22000', from: '20220127' }, // UNiVERSE
  { version: '21500', from: '20210730' }, // Splash PLUS
  { version: '21000', from: '20210129' }, // Splash
  { version: '20500', from: '20200729' }, // でらっくす PLUS
  { version: '20000', from: '20191125' }, // でらっくす（國際服開站）
  { version: '19900', from: '20181213' }, // FiNALE
  { version: '19500', from: '20180621' }, // MiLK PLUS
  { version: '19000', from: '20171214' }, // MiLK
  { version: '18500', from: '20170622' }, // MURASAKi PLUS
  { version: '18000', from: '20161215' }, // MURASAKi
  { version: '17000', from: '20160730' }, // PiNK PLUS
  { version: '16000', from: '20151209' }, // PiNK
  { version: '15000', from: '20150319' }, // ORANGE PLUS
  { version: '14000', from: '20140918' }, // ORANGE
  { version: '13000', from: '20140226' }, // GreeN PLUS
  { version: '12000', from: '20130313' }, // GreeN
  { version: '11000', from: '20121213' }, // maimai PLUS
  { version: '10000', from: '20120711' }, // maimai
]

function getVersionFromDate(dateStr: string | undefined): string {
  if (!dateStr) return '10000'
  const d = dateStr.replace(/-/g, '') // 支援 YYYYMMDD 和 YYYY-MM-DD
  for (const { version, from } of VERSION_DATE_RANGES) {
    if (d >= from) return version
  }
  return '10000'
}

// ==========================================
// 超時與重試
// ==========================================
const withTimeout = <T>(promise: Promise<T>, ms: number) => {
  let timeoutId: NodeJS.Timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('請求超時')), ms)
  })
  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    timeoutPromise,
  ])
}

async function executeBatchWithRetry(tasks: (() => Promise<void>)[]) {
  let retries = 5
  while (retries > 0) {
    try {
      await withTimeout(Promise.all(tasks.map(t => t())), 10000)
      return
    } catch (e) {
      retries--
      console.log(`\n⚠️ 寫入超時或斷線，等待 3 秒後重試... (剩餘: ${retries})`)
      await new Promise(r => setTimeout(r, 3000))
    }
  }
  throw new Error('批次寫入徹底失敗，請檢查網路狀態')
}

// ==========================================
// 主程式
// ==========================================
async function importCC() {
  await connectDB()

  console.log(`📝 正在同步最新資料庫結構 (Schema)...`)
  await initSchema()

  console.log(`🗑️ 清空舊資料...`)
  await query(`DELETE FROM song`)

  console.log(`🔥 正在下載國際服資料...`)
  const res = await fetch(INTL_DB_URL, { cache: 'no-store' })
  const songs = await res.json() as any[]

  console.log(`📊 共偵測到: ${songs.length} 首歌曲資料`)

  const chartIdentityCounts = new Map<string, number>()
  const chartIdentitySeen = new Map<string, number>()
  for (const song of songs) {
    if (!song.intl || song.intl === '0') continue
    for (const track of [
      { prefix: '',    type: 'STANDARD' },
      { prefix: 'dx_', type: 'DX'       },
    ]) {
      const hasTrack = DIFFS.some(d => song[`${track.prefix}lev_${d.key}_i`])
      if (!hasTrack) continue
      const identity = `${song.title}_${track.type}`
      chartIdentityCounts.set(identity, (chartIdentityCounts.get(identity) ?? 0) + 1)
    }
  }

  let songUpdated = 0
  const BATCH_SIZE = 20
  let tasks: (() => Promise<void>)[] = []

  for (const song of songs) {
    // 只匯入國際版有的曲子
    if (!song.intl || song.intl === '0') continue

    // 判斷是否同時有 STANDARD 和 DX 譜
    const hasStd = DIFFS.some(d => song[`lev_${d.key}_i`])
    const hasDx  = DIFFS.some(d => song[`dx_lev_${d.key}_i`])
    const hasBoth = hasStd && hasDx

    const versionNum = parseInt(song.version) || 0
    const isDxEra = versionNum >= 20000

    const tracks = [
      { prefix: '',    type: 'STANDARD' },
      { prefix: 'dx_', type: 'DX'       },
    ]

    for (const track of tracks) {
      const hasTrack = DIFFS.some(d => song[`${track.prefix}lev_${d.key}_i`])
      if (!hasTrack) continue

      const identity = `${song.title}_${track.type}`
      const duplicateIndex = chartIdentitySeen.get(identity) ?? 0
      chartIdentitySeen.set(identity, duplicateIndex + 1)
      const duplicateSuffix = (chartIdentityCounts.get(identity) ?? 0) > 1 && duplicateIndex > 0
        ? `_${song.sort || song.image_url || duplicateIndex}`
        : ''

      // 套用 overrides.json
      const overrideKey = `${song.title}_${track.type}`
      const override = overrides[overrideKey] ?? {}

      // 計算此 chart_type 的 date_intl_added / date_intl_updated
      let dateIntlAdded: string
      let dateIntlUpdated: string

      if (hasBoth) {
        if (isDxEra) {
          // DX 時代：DX 是原生（date_intl_added），STD 是後追加（date_intl_updated）
          if (track.type === 'DX') {
            dateIntlAdded   = song.date_intl_added   || ''
            dateIntlUpdated = song.date_intl_updated  || ''
          } else {
            dateIntlAdded   = song.date_intl_updated  || ''  // STD 後追加
            dateIntlUpdated = song.date_intl_updated  || ''
          }
        } else {
          // 舊時代：STD 是原生（date_intl_added），DX 是後追加（date_intl_updated）
          if (track.type === 'STANDARD') {
            dateIntlAdded   = song.date_intl_added   || ''
            dateIntlUpdated = song.date_intl_updated  || ''
          } else {
            dateIntlAdded   = song.date_intl_updated  || ''  // DX 後追加
            dateIntlUpdated = song.date_intl_updated  || ''
          }
        }
      } else {
        dateIntlAdded   = song.date_intl_added  || ''
        dateIntlUpdated = song.date_intl_updated || ''
      }

      // overrides 優先
      if (override.date_intl_added)   dateIntlAdded   = override.date_intl_added
      if (override.date_intl_updated) dateIntlUpdated = override.date_intl_updated

      // 用 date_intl_added 反推版本（給牌子系統用）
      const dateVersion = getVersionFromDate(dateIntlAdded)

      const common = {
        title:        song.title,
        artist:       song.artist      || '',
        genre:        song.catcode     || '',
        bpm:          parseInt(song.bpm) || 0,
        version:      dateVersion,           // 用日期反推的版本
        image_name:   song.image_url   || '00000.png',
        // 國際版日期
        date_intl_added:   dateIntlAdded,
        date_intl_updated: dateIntlUpdated,
        // 日版日期（原始欄位）
        date_added:   song.date_added   || undefined,
        date_updated: song.date_updated || undefined,
      }

      for (const diff of DIFFS) {
        const ccKey = `${track.prefix}lev_${diff.key}_i`
        if (!song[ccKey]) continue

        const finalCC    = parseFloat(song[ccKey])
        const songKey    = `${common.title}_${track.type}_${diff.name}${duplicateSuffix}`
        const levelString = song[`${track.prefix}lev_${diff.key}`] || ''
        const designer    = song[`${track.prefix}lev_${diff.key}_designer`] || ''

        const notes = {
          tap:   parseInt(song[`${track.prefix}lev_${diff.key}_notes_tap`])   || 0,
          hold:  parseInt(song[`${track.prefix}lev_${diff.key}_notes_hold`])  || 0,
          slide: parseInt(song[`${track.prefix}lev_${diff.key}_notes_slide`]) || 0,
          touch: track.type === 'DX' ? (parseInt(song[`dx_lev_${diff.key}_notes_touch`]) || 0) : 0,
          break: parseInt(song[`${track.prefix}lev_${diff.key}_notes_break`]) || 0,
        }

        tasks.push(async () => {
          await query(`
            INSERT INTO song (
              id, title, artist, genre, bpm, version, chart_constant, image_name,
              chart_type, difficulty, level, chart_designer,
              notes_tap, notes_hold, notes_slide, notes_touch, notes_break,
              date_intl_added, date_intl_updated, date_added, date_updated
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8,
              $9, $10, $11, $12,
              $13, $14, $15, $16, $17,
              $18, $19, $20, $21
            )
            ON CONFLICT (id) DO UPDATE SET
              title = EXCLUDED.title,
              artist = EXCLUDED.artist,
              genre = EXCLUDED.genre,
              bpm = EXCLUDED.bpm,
              version = EXCLUDED.version,
              chart_constant = EXCLUDED.chart_constant,
              image_name = EXCLUDED.image_name,
              chart_type = EXCLUDED.chart_type,
              difficulty = EXCLUDED.difficulty,
              level = EXCLUDED.level,
              chart_designer = EXCLUDED.chart_designer,
              notes_tap = EXCLUDED.notes_tap,
              notes_hold = EXCLUDED.notes_hold,
              notes_slide = EXCLUDED.notes_slide,
              notes_touch = EXCLUDED.notes_touch,
              notes_break = EXCLUDED.notes_break,
              date_intl_added = EXCLUDED.date_intl_added,
              date_intl_updated = EXCLUDED.date_intl_updated,
              date_added = EXCLUDED.date_added,
              date_updated = EXCLUDED.date_updated
          `, [
            songKey,
            common.title,
            common.artist,
            common.genre,
            common.bpm,
            common.version,
            finalCC,
            common.image_name,
            track.type,
            diff.name,
            levelString,
            designer,
            notes.tap,
            notes.hold,
            notes.slide,
            notes.touch,
            notes.break,
            common.date_intl_added,
            common.date_intl_updated,
            common.date_added ?? null,
            common.date_updated ?? null,
          ])

          songUpdated++

          await query(
            `UPDATE score SET chart_constant = $1 WHERE song_id = $2`,
            [finalCC, songKey],
          )
        })

        if (tasks.length >= BATCH_SIZE) {
          await executeBatchWithRetry(tasks)
          tasks = []
          await new Promise(r => setTimeout(r, 200))
          process.stdout.write(`\r🚀 進度: ${songUpdated} 筆譜面...`)
        }
      }
    }
  }

  if (tasks.length > 0) {
    await executeBatchWithRetry(tasks)
  }

  console.log(`\n✅ 歌曲資料庫更新完成，共更新 ${songUpdated} 筆譜面！`)
  process.exit(0)
}

importCC().catch(err => {
  console.error('\n❌ 導入失敗:', err)
  process.exit(1)
})
