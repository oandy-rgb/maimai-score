import { connectDB, db } from './db'
import { RecordId } from 'surrealdb'

// 🌟 直接鎖定你找到的國際服專屬 JSON
const INTL_DB_URL = 'https://raw.githubusercontent.com/zvuc/otoge-db/refs/heads/master/maimai/data/music-ex-intl.json'

// 對應扁平化 JSON 裡的難度 key (bas, adv, exp, mas, remas)
const DIFFS = [
  { key: 'bas', name: 'BASIC' },
{ key: 'adv', name: 'ADVANCED' },
{ key: 'exp', name: 'EXPERT' },
{ key: 'mas', name: 'MASTER' },
{ key: 'remas', name: 'REMASTER' },
]

async function importCC() {
  await connectDB()

  console.log(`🔥 正在從 otoge-db 下載最強國際服扁平化資料...`)
  const res = await fetch(INTL_DB_URL, { cache: "no-store" })
  const songs = await res.json() as any[]

  console.log(`📊 共偵測到: ${songs.length} 筆譜面資料`)

  let songUpdated = 0
  let scoreUpdated = 0

  for (const song of songs) {
    // 💡 otoge-db 在這種格式通常用 type 欄位標示 DX 譜面
    // 如果沒有這個欄位，我們就預設它是 STANDARD 標譜
    const chartType = song.type === 'DX' ? 'DX' : 'STANDARD'

    const title = song.title
    const genre = song.catcode || ''
    // JSON 裡的 bpm 是字串 "150"，需要轉成數字
    const bpm = parseInt(song.bpm) || 0
    const version = song.version || ''
    const finalImageName = song.image_url || '00000.png'

    // 把五個難度掃過一遍
    for (const diff of DIFFS) {
      // 動態組裝 key，例如 'lev_bas_i' 就是 Basic 的定數
      const ccString = song[`lev_${diff.key}_i`]

      // 如果這首歌沒有這個難度 (例如沒有 Re:Master)，就直接跳過
      if (!ccString) continue

        const finalCC = parseFloat(ccString)
        if (isNaN(finalCC)) continue

          // 組裝 SurrealDB 的 Primary Key
          const songKey = `${title}_${chartType}_${diff.name}`

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
                         title,
                         genre,
                         bpm,
                         version,
                         cc: finalCC,
                         image_name: finalImageName // 寫入官方 Hash 碼
          })
          songUpdated++

          // UPDATE score 表
          await db.query(`
          UPDATE score SET
          chart_constant = $cc,
          version = $version
          WHERE song = $song
          `, {
            cc: finalCC,
            version,
            song: new RecordId('song', songKey)
          })
          scoreUpdated++
    }
  }

  console.log(`✅ 歌曲基礎資料庫 (song) 更新：${songUpdated} 筆`)
  console.log(`✅ 玩家成績對應表 (score) 更新：${scoreUpdated} 筆`)
  process.exit(0)
}

importCC().catch(console.error)
