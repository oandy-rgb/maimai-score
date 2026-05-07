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
    DEFINE INDEX IF NOT EXISTS player_username ON player FIELDS username UNIQUE;


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
    DEFINE FIELD IF NOT EXISTS notes_tap ON song TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS notes_hold ON song TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS notes_slide ON song TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS notes_touch ON song TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS notes_break ON song TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS aliases ON song TYPE option<array<string>>;

    DEFINE INDEX IF NOT EXISTS song_title ON song FIELDS title;
    DEFINE INDEX IF NOT EXISTS song_vector ON song FIELDS embedding HNSW DIMENSION 768;




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

    DEFINE INDEX IF NOT EXISTS score_player ON score FIELDS player;
    DEFINE INDEX IF NOT EXISTS score_unique ON score FIELDS player, song UNIQUE;

    -- ==========================================
    -- 📝 待打清單 (Todo)
    -- ==========================================
    DEFINE TABLE IF NOT EXISTS todo SCHEMAFULL
    PERMISSIONS
    FOR select WHERE player = $auth.id
    FOR create WHERE player = $auth.id
    FOR update WHERE player = $auth.id
    FOR delete WHERE player = $auth.id;

    DEFINE FIELD IF NOT EXISTS player ON todo TYPE record<player>;
    DEFINE FIELD IF NOT EXISTS song_key ON todo TYPE string;
    DEFINE FIELD IF NOT EXISTS title ON todo TYPE string;
    DEFINE FIELD IF NOT EXISTS chart_type ON todo TYPE string;
    DEFINE FIELD IF NOT EXISTS image_name ON todo TYPE string;
    DEFINE FIELD IF NOT EXISTS difficulty ON todo TYPE string;
    DEFINE FIELD IF NOT EXISTS target_achievement ON todo TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS target_fc ON todo TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS source ON todo TYPE string DEFAULT 'manual';
    DEFINE FIELD IF NOT EXISTS done ON todo TYPE bool DEFAULT false;
    DEFINE FIELD IF NOT EXISTS created_at ON todo TYPE datetime DEFAULT time::now();

    DEFINE INDEX IF NOT EXISTS todo_unique ON todo FIELDS player, song_key UNIQUE;

    -- ==========================================
    -- 👥 好友關係 (Friendship)
    -- ==========================================
    DEFINE TABLE IF NOT EXISTS friendship SCHEMAFULL
    PERMISSIONS
    FOR select WHERE from_player = $auth.id OR to_player = $auth.id
    FOR create WHERE from_player = $auth.id
    FOR update WHERE from_player = $auth.id OR to_player = $auth.id
    FOR delete WHERE from_player = $auth.id;

    DEFINE FIELD IF NOT EXISTS from_player ON friendship TYPE record<player>;
    DEFINE FIELD IF NOT EXISTS to_player ON friendship TYPE record<player>;
    DEFINE FIELD IF NOT EXISTS status ON friendship TYPE string
    ASSERT $value IN ['pending', 'accepted'];
    DEFINE FIELD IF NOT EXISTS created_at ON friendship TYPE datetime DEFAULT time::now();

    DEFINE INDEX IF NOT EXISTS friendship_unique ON friendship FIELDS from_player, to_player UNIQUE;
    `)

    console.log('✅ Schema 初始化完成')
}
