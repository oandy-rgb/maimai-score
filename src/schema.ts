import { db } from './db'

export async function initSchema() {
    await db.query(`
    -- ==========================================
    -- 👤 玩家資料表 (Player)
    -- ==========================================
    DEFINE TABLE IF NOT EXISTS player SCHEMAFULL
    PERMISSIONS
    FOR select WHERE id = $auth.id
    FOR update WHERE id = $auth.id
    FOR create, delete NONE;

    DEFINE FIELD IF NOT EXISTS email ON player TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS username ON player TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS created_at ON player TYPE datetime DEFAULT time::now();

    -- ==========================================
    -- 🎵 歌曲與譜面資料表 (Song)
    -- ==========================================
    DEFINE TABLE IF NOT EXISTS song SCHEMAFULL
    PERMISSIONS
    FOR select FULL
    FOR create, update, delete NONE;

    DEFINE FIELD IF NOT EXISTS title ON song TYPE string;
    DEFINE FIELD IF NOT EXISTS genre ON song TYPE string;
    DEFINE FIELD IF NOT EXISTS bpm ON song TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS version ON song TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS embedding ON song TYPE option<array<float>>;
    DEFINE FIELD IF NOT EXISTS chart_constant ON song TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS custom_chart_constant ON song TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS image_name ON song TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS artist ON song TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS chart_type ON song TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS difficulty ON song TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS level ON song TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS chart_designer ON song TYPE option<string>;
    // 在 song table 的 DEFINE FIELD 區塊加上：
    DEFINE FIELD IF NOT EXISTS notes_tap ON song TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS notes_hold ON song TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS notes_slide ON song TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS notes_touch ON song TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS notes_break ON song TYPE option<number>;

    -- [一般索引] 加速精確比對
    DEFINE INDEX IF NOT EXISTS song_title ON song FIELDS title;

    -- [向量索引] 為了未來 AI 推薦系統預留的 Embedding 相似度搜尋
    DEFINE INDEX IF NOT EXISTS song_vector ON song FIELDS embedding HNSW DIMENSION 768;

    -- 🌟 [新增] 全文檢索分析器 (Analyzer)
    -- tokenizers: 遇到空白、大小寫轉換(camel)、標點符號時拆分單字
    -- filters: 全部轉小寫，處理特殊字元
    DEFINE ANALYZER IF NOT EXISTS song_search_analyzer
    TOKENIZERS blank, camel, class, punct
    FILTERS lowercase, ascii;

    // 2. Define the Index using the analyzer
    // In SurrealDB 3.0, the SEARCH keyword is used within the DEFINE INDEX statement.
    DEFINE INDEX IF NOT EXISTS song_fts_idx ON TABLE song
    FIELDS title, artist
    SEARCH ANALYZER song_search_analyzer BM25;

    -- ==========================================
    -- 🏆 玩家成績資料表 (Score)
    -- ==========================================
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
    DEFINE FIELD IF NOT EXISTS chart_constant ON score TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS version ON score TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS fc ON score TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS sync ON score TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS updated_at ON score TYPE datetime DEFAULT time::now();

    -- 確保同一個玩家在同一張譜面只會有一筆成績紀錄
    DEFINE INDEX IF NOT EXISTS score_player ON score FIELDS player;
    DEFINE INDEX IF NOT EXISTS score_unique ON score FIELDS player, song UNIQUE;
    `)

    console.log('✅ Schema 初始化完成 (已啟用 Analyzer 與全文檢索索引)')
}
