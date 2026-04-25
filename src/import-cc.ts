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

async function importCC() {
    await connectDB()

    console.log('📥 下載 dxdata.json...')
    const res = await fetch(DXDATA_URL)
    const data = await res.json() as { songs: any[] }

    console.log(`📊 共 ${data.songs.length} 首歌`)

    let updated = 0
    let notFound = 0

    for (const song of data.songs) {
        for (const sheet of song.sheets) {
            const type = TYPE_MAP[sheet.type]
            const difficulty = DIFFICULTY_MAP[sheet.difficulty]
            if (!type || !difficulty) continue

                const songKey = `${song.title}_${type}`
                const cc = sheet.internalLevelValue

                const result = await db.query(`
                UPDATE song SET chart_constant = $cc
                WHERE title = $title AND id = $id
                `, {
                    cc,
                    title: song.title,
                    id: new RecordId('song', songKey),
                })

                // 也更新 score 表的 chart_constant
                // 也更新 score 表的 chart_constant 和 version
                await db.query(`
                UPDATE score SET
                chart_constant = $cc,
                version = $version
                WHERE song = $song AND difficulty = $difficulty
                `, {
                    cc,
                    version: sheet.version ?? '',
                    song: new RecordId('song', songKey),
                               difficulty,
                })

                updated++
        }
    }

    console.log(`✅ 更新完成：${updated} 筆`)
    process.exit(0)
}

importCC().catch(console.error)
