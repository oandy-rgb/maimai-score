import { db } from './db'
export async function initSchema() {
    await db.query(`
    DEFINE TABLE IF NOT EXISTS player SCHEMAFULL
    PERMISSIONS
    FOR select WHERE id = $auth.id
    FOR update WHERE id = $auth.id
    FOR create, delete NONE;
    DEFINE FIELD IF NOT EXISTS email ON player TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS username ON player TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS created_at ON player TYPE datetime DEFAULT time::now();
    DEFINE TABLE IF NOT EXISTS song SCHEMAFULL
    PERMISSIONS
    FOR select FULL
    FOR create, update, delete NONE;
    DEFINE FIELD IF NOT EXISTS image_name ON song TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS internal_id ON song TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS chart_type ON song TYPE option<string>;
    DEFINE INDEX IF NOT EXISTS song_title_type ON song FIELDS title, chart_type;
    DEFINE FIELD IF NOT EXISTS title ON song TYPE string;
    DEFINE FIELD IF NOT EXISTS genre ON song TYPE string;
    DEFINE FIELD IF NOT EXISTS bpm ON song TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS version ON song TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS embedding ON song TYPE option<array<float>>;
    DEFINE FIELD IF NOT EXISTS chart_constant ON song TYPE option<number>;
    DEFINE INDEX IF NOT EXISTS song_title ON song FIELDS title;
    DEFINE INDEX IF NOT EXISTS song_vector ON song FIELDS embedding HNSW DIMENSION 768;
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
    DEFINE FIELD IF NOT EXISTS updated_at ON score TYPE datetime DEFAULT time::now();
    DEFINE INDEX IF NOT EXISTS score_player ON score FIELDS player;
    DEFINE INDEX IF NOT EXISTS score_unique ON score FIELDS player, song, difficulty, chart_type UNIQUE;
    `)
    console.log('✅ Schema 初始化完成')
}
