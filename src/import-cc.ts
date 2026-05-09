import { connectDB, db } from './db'
import { initSchema } from './schema'
import { RecordId } from 'surrealdb'

const INTL_DB_URL = 'https://raw.githubusercontent.com/zvuc/otoge-db/refs/heads/master/maimai/data/music-ex-intl.json'

const DIFFS = [
  { key: 'bas', name: 'BASIC' },
{ key: 'adv', name: 'ADVANCED' },
{ key: 'exp', name: 'EXPERT' },
{ key: 'mas', name: 'MASTER' },
{ key: 'remas', name: 'REMASTER' },
]

// 🌟 新增：具備防錯與自動重試機制的批次執行器
// 🌟 新增：強制超時工具，解決 SDK 斷線無限期等待的 Bug
const withTimeout = <T>(promise: Promise<T>, ms: number) => {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('請求超時')), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
                      timeoutPromise
  ]);
};

async function executeBatchWithRetry(tasks: (() => Promise<void>)[]) {
  let retries = 5; // 放寬重試次數到 5 次
  while (retries > 0) {
    try {
      // 🌟 將批次請求包上 10 秒超時限制
      await withTimeout(Promise.all(tasks.map(t => t())), 10000);
      return; // 成功就跳出
    } catch (e) {
      retries--;
      console.log(`\n⚠️ 寫入超時或斷線，等待 3 秒後重試... (剩餘: ${retries})`);
      await new Promise(r => setTimeout(r, 3000)); // 等待 db.ts 的背景重連
    }
  }
  throw new Error("批次寫入徹底失敗，請檢查網路狀態");
}

async function importCC() {
  await connectDB()

  console.log(`📝 正在同步最新資料庫結構 (Schema)...`)
  await initSchema()

  console.log(`🗑️ 清空舊資料...`)
  await db.query(`DELETE song`)

  console.log(`🔥 正在下載國際服資料...`)
  const res = await fetch(INTL_DB_URL, { cache: "no-store" })
  const songs = await res.json() as any[]

  console.log(`📊 共偵測到: ${songs.length} 首歌曲資料`)

  let songUpdated = 0
  const BATCH_SIZE = 20 // 降低併發量，保護 port-forward
  let tasks: (() => Promise<void>)[] = []

  for (const song of songs) {
    const common = {
      title: song.title,
      artist: song.artist || '',
      genre: song.catcode || '',
      bpm: parseInt(song.bpm) || 0,
      version: song.version || '',
      image_name: song.image_url || '00000.png',
      date_added: song.date_intl_added || undefined,
      date_updated: song.date_intl_updated || undefined
    }

    const tracks = [
      { prefix: '', type: 'STANDARD' },
      { prefix: 'dx_', type: 'DX' }
    ]

    for (const track of tracks) {
      for (const diff of DIFFS) {
        const ccKey = `${track.prefix}lev_${diff.key}_i`
        if (!song[ccKey]) continue

          const finalCC = parseFloat(song[ccKey])
          const songKey = `${common.title}_${track.type}_${diff.name}`
          const levelString = song[`${track.prefix}lev_${diff.key}`] || ''
          const designer = song[`${track.prefix}lev_${diff.key}_designer`] || ''

          const notes = {
            tap: parseInt(song[`${track.prefix}lev_${diff.key}_notes_tap`]) || 0,
            hold: parseInt(song[`${track.prefix}lev_${diff.key}_notes_hold`]) || 0,
            slide: parseInt(song[`${track.prefix}lev_${diff.key}_notes_slide`]) || 0,
            touch: track.type === 'DX' ? (parseInt(song[`dx_lev_${diff.key}_notes_touch`]) || 0) : 0,
            break: parseInt(song[`${track.prefix}lev_${diff.key}_notes_break`]) || 0,
          }

          // 🌟 關鍵修正：包裝成非同步函數，不要立刻執行
          tasks.push(async () => {
            await db.query(`
            UPSERT $id SET
            title = $title, artist = $artist, genre = $genre, bpm = $bpm,
            version = $version, chart_constant = $cc, image_name = $image_name,
            chart_type = $type, difficulty = $diff, level = $level,
            chart_designer = $designer,
            notes_tap = $tap, notes_hold = $hold, notes_slide = $slide,
            notes_touch = $touch, notes_break = $break,
            date_added = $date_added, date_updated = $date_updated
            `, {
              id: new RecordId('song', songKey),
                           ...common,
                           cc: finalCC,
                           type: track.type,
                           diff: diff.name,
                           level: levelString,
                           designer: designer,
                           ...notes
            })

            songUpdated++

            await db.query(`UPDATE score SET chart_constant = $cc, version = $version WHERE song = $song`, {
              cc: finalCC, version: common.version, song: new RecordId('song', songKey)
            })
          })

          // 當任務池滿了，執行並清空
          if (tasks.length >= BATCH_SIZE) {
            await executeBatchWithRetry(tasks)
            tasks = []

            // 🌟 讓 port-forward 隧道休息 0.2 秒
            await new Promise(r => setTimeout(r, 200))
            process.stdout.write(`\r🚀 進度: ${songUpdated} 筆譜面...`)
          }
      }
    }
  }

  // 執行剩下的任務
  if (tasks.length > 0) {
    await executeBatchWithRetry(tasks)
  }

  console.log(`\n✅ 歌曲資料庫更新完成，共更新 ${songUpdated} 筆譜面！`)
  process.exit(0)
}

importCC().catch(err => {
  console.error("\n❌ 導入失敗:", err)
  process.exit(1)
})
