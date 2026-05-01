import { connectDB, db } from './db'
import { RecordId } from 'surrealdb'

const INTL_DB_URL = 'https://raw.githubusercontent.com/zvuc/otoge-db/refs/heads/master/maimai/data/music-ex-intl.json'

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

  console.log(`📊 共偵測到: ${songs.length} 首歌曲資料`)

  let songUpdated = 0
  let scoreUpdated = 0

  for (const song of songs) {
    const title = song.title
    const genre = song.catcode || ''
    const bpm = parseInt(song.bpm) || 0
    const version = song.version || ''
    const finalImageName = song.image_url || '00000.png'
    const artist = song.artist || ''
    // 🌟 軌道 1：解析 STANDARD (標準) 譜面
    for (const diff of DIFFS) {
      const ccString = song[`lev_${diff.key}_i`]
      if (!ccString) continue // 如果沒有這個難度，就跳過

        const finalCC = parseFloat(ccString)
        if (isNaN(finalCC)) continue

          const songKey = `${title}_STANDARD_${diff.name}`

          // 更新歌曲資料 (寫入圖片 Hash 碼)
          await db.query(`
          UPSERT $id SET
          title = $title,
          artist = $artist,
          genre = $genre,
          bpm = $bpm,
          version = $version,
          chart_constant = $cc,
          image_name = $image_name,
          chart_type = 'STANDARD'
          `, {
            id: new RecordId('song', songKey),
                         title, genre, bpm, version, cc: finalCC, image_name: finalImageName
          })
          songUpdated++

          // 將最新的定數同步給使用者的成績
          await db.query(`
          UPDATE score SET
          chart_constant = $cc,
          version = $version
          WHERE song = $song
          `, {
            cc: finalCC, version, song: new RecordId('song', songKey)
          })
          scoreUpdated++
    }

    // 🌟 軌道 2：解析 DX (でらっくす) 譜面
    for (const diff of DIFFS) {
      // 關鍵！尋找 dx_lev_ 開頭的屬性
      const ccString = song[`dx_lev_${diff.key}_i`]
      if (!ccString) continue

        const finalCC = parseFloat(ccString)
        if (isNaN(finalCC)) continue

          const songKey = `${title}_DX_${diff.name}`

          // 更新歌曲資料 (寫入圖片 Hash 碼)
          await db.query(`
          UPSERT $id SET
          title = $title,
          artist = $artist,
          genre = $genre,
          bpm = $bpm,
          version = $version,
          chart_constant = $cc,
          image_name = $image_name,
          chart_type = 'DX'
          `, {
            id: new RecordId('song', songKey),
                         title, genre, bpm, version, cc: finalCC, image_name: finalImageName
          })
          songUpdated++

          // 將最新的定數同步給使用者的成績
          await db.query(`
          UPDATE score SET
          chart_constant = $cc,
          version = $version
          WHERE song = $song
          `, {
            cc: finalCC, version, song: new RecordId('song', songKey)
          })
          scoreUpdated++
    }
  }

  console.log(`✅ 歌曲基礎資料庫 (song) 更新：${songUpdated} 筆`)
  console.log(`✅ 玩家成績對應表 (score) 更新：${scoreUpdated} 筆`)
  process.exit(0)
}

importCC().catch(console.error)
