import { db } from './db'

export async function initSchema() {
    await db.query(`
    -- 玩家資料
    DEFINE TABLE IF NOT EXISTS player SCHEMAFULL
    PERMISSIONS
    FOR select WHERE id = $auth.id
    FOR update WHERE id = $auth.id
    FOR create, delete NONE;
    DEFINE FIELD IF NOT EXISTS email ON player TYPE string;
    DEFINE FIELD IF NOT EXISTS username ON player TYPE string;
    DEFINE FIELD IF NOT EXISTS created_at ON player TYPE datetime DEFAULT time::now();
    DEFINE INDEX IF NOT EXISTS idx_email ON player FIELDS email UNIQUE;

    -- 歌曲資料 (ID 為 song:internalId)
    DEFINE TABLE IF NOT EXISTS song SCHEMAFULL
    PERMISSIONS
    FOR select FULL
    FOR create, update, delete NONE;
    DEFINE FIELD IF NOT EXISTS internalId ON song TYPE number;
    DEFINE FIELD IF NOT EXISTS title ON song TYPE string;
    DEFINE FIELD IF NOT EXISTS genre ON song TYPE string;
    DEFINE FIELD IF NOT EXISTS bpm ON song TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS version ON song TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS embedding ON song TYPE option<array<float>>;
    DEFINE FIELD IF NOT EXISTS chart_constant ON song TYPE array<float>; -- 儲存各難度的 CC
    DEFINE INDEX IF NOT EXISTS song_vector ON song FIELDS embedding HNSW DIMENSION 768;

    -- 分數資料 (核心邏輯：連結 song 而非自己維護 CC)
    DEFINE TABLE IF NOT EXISTS score SCHEMAFULL
    PERMISSIONS
    FOR select WHERE player = $auth.id
    FOR create WHERE player = $auth.id
    FOR update WHERE player = $auth.id
    FOR delete NONE;
    DEFINE FIELD IF NOT EXISTS player ON score TYPE record<player>;
    DEFINE FIELD IF NOT EXISTS song ON score TYPE record<song>;
    DEFINE FIELD IF NOT EXISTS difficulty ON score TYPE string
    ASSERT $value IN ['BASIC', 'ADVANCED', 'EXPERT', 'MASTER', 'REMASTER'];
    DEFINE FIELD IF NOT EXISTS chart_type ON score TYPE string
    ASSERT $value IN ['STANDARD', 'DX'];
    DEFINE FIELD IF NOT EXISTS level ON score TYPE string;
    DEFINE FIELD IF NOT EXISTS achievement ON score TYPE number;
    DEFINE FIELD IF NOT EXISTS updated_at ON score TYPE datetime DEFAULT time::now();

    -- 唯一約束：同一個玩家、同一首歌、同一個難度、同一種類型只能有一筆分數
    DEFINE INDEX IF NOT EXISTS score_unique ON score FIELDS player, song, difficulty, chart_type UNIQUE;
    `)
    console.log('✅ Schema 初始化完成 (已改用 internalId 為核心)')
}
