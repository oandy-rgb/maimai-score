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

  console.log(`🗑️ 清空舊資料...`)
  await db.query(`DELETE song`)  // ← 移到這裡

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
      if (!ccString) continue

        const finalCC = parseFloat(ccString)
        if (isNaN(finalCC)) continue

          const levelString = song[`lev_${diff.key}`] || ''
          const designer = song[`lev_${diff.key}_designer`] || ''
          const songKey = `${title}_STANDARD_${diff.name}`
          const notes_tap    = parseInt(song[`lev_${diff.key}_notes_tap`]) || undefined
          const notes_hold   = parseInt(song[`lev_${diff.key}_notes_hold`]) || undefined
          const notes_slide  = parseInt(song[`lev_${diff.key}_notes_slide`]) || undefined
          const notes_touch  = undefined
          const notes_break  = parseInt(song[`lev_${diff.key}_notes_break`]) || undefined

          await db.query(`
          UPSERT $id SET
          title = $title,
          artist = $artist,
          genre = $genre,
          bpm = $bpm,
          version = $version,
          chart_constant = $cc,
          image_name = $image_name,
          chart_type = 'STANDARD',
          difficulty = $difficulty,
          level = $level,
          chart_designer = $chart_designer,
          notes_tap = $notes_tap,
          notes_hold = $notes_hold,
          notes_slide = $notes_slide,
          notes_touch = $notes_touch,
          notes_break = $notes_break
          `, {
            id: new RecordId('song', songKey),
                         title,
                         artist, // ✅ 補上 artist 變數
                         genre, bpm, version, cc: finalCC, image_name: finalImageName,
                         difficulty: diff.name, level: levelString, chart_designer: designer,notes_tap, notes_hold, notes_slide, notes_touch, notes_break
          })
          songUpdated++

          await db.query(`
          UPDATE score SET chart_constant = $cc, version = $version WHERE song = $song
          `, { cc: finalCC, version, song: new RecordId('song', songKey) })
          scoreUpdated++
    }

    // 🌟 軌道 2：解析 DX (でらっくす) 譜面
    for (const diff of DIFFS) {
      const ccString = song[`dx_lev_${diff.key}_i`]
      if (!ccString) continue

        const finalCC = parseFloat(ccString)
        if (isNaN(finalCC)) continue

          const levelString = song[`dx_lev_${diff.key}`] || ''
          const designer = song[`dx_lev_${diff.key}_designer`] || ''
          const songKey = `${title}_DX_${diff.name}`
          const notes_tap    = parseInt(song[`dx_lev_${diff.key}_notes_tap`]) || undefined
          const notes_hold   = parseInt(song[`dx_lev_${diff.key}_notes_hold`]) || undefined
          const notes_slide  = parseInt(song[`dx_lev_${diff.key}_notes_slide`]) || undefined
          const notes_touch  = parseInt(song[`dx_lev_${diff.key}_notes_touch`]) || undefined
          const notes_break  = parseInt(song[`dx_lev_${diff.key}_notes_break`]) || undefined

          await db.query(`
          UPSERT $id SET
          title = $title,
          artist = $artist,
          genre = $genre,
          bpm = $bpm,
          version = $version,
          chart_constant = $cc,
          image_name = $image_name,
          chart_type = 'DX',
          difficulty = $difficulty,
          level = $level,
          chart_designer = $chart_designer,
          notes_tap = $notes_tap,
          notes_hold = $notes_hold,
          notes_slide = $notes_slide,
          notes_touch = $notes_touch,
          notes_break = $notes_break
          `, {
            id: new RecordId('song', songKey),
                         title,
                         artist, // ✅ 補上 artist 變數
                         genre, bpm, version, cc: finalCC, image_name: finalImageName,
                         difficulty: diff.name, level: levelString, chart_designer: designer,notes_tap, notes_hold, notes_slide, notes_touch, notes_break
          })
          songUpdated++

          await db.query(`
          UPDATE score SET chart_constant = $cc, version = $version WHERE song = $song
          `, { cc: finalCC, version, song: new RecordId('song', songKey) })
          scoreUpdated++
    }
  }

  console.log(`✅ 歌曲基礎資料庫 (song) 更新：${songUpdated} 筆`)
  console.log(`✅ 玩家成績對應表 (score) 更新：${scoreUpdated} 筆`)
  process.exit(0)
}

importCC().catch(console.error)
