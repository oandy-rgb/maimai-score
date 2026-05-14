import { db } from './db'

export async function initSchema() {
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS player (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      email text UNIQUE,
      username text UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      dan_img_url text,
      icon_img_url text,
      in_game_name text
    );

    CREATE TABLE IF NOT EXISTS song (
      id text PRIMARY KEY,
      title text NOT NULL,
      genre text NOT NULL DEFAULT '',
      bpm double precision,
      version text,
      embedding double precision[],
      chart_constant double precision,
      custom_chart_constant double precision,
      image_name text,
      artist text,
      chart_type text,
      difficulty text,
      level text,
      chart_designer text,
      notes_tap integer,
      notes_hold integer,
      notes_slide integer,
      notes_touch integer,
      notes_break integer,
      aliases text[],
      date_added text,
      date_updated text,
      date_intl_added text,
      date_intl_updated text
    );

    CREATE INDEX IF NOT EXISTS song_title_idx ON song (title);
    CREATE INDEX IF NOT EXISTS song_chart_lookup_idx ON song (title, chart_type, difficulty);

    CREATE TABLE IF NOT EXISTS song_alias_suggestion (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      title text NOT NULL,
      chart_type text NOT NULL CHECK (chart_type IN ('STANDARD', 'DX')),
      alias text NOT NULL,
      suggested_by_player_id text REFERENCES player(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      reviewed_by_player_id text REFERENCES player(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      reviewed_at timestamptz,
      UNIQUE (title, chart_type, alias)
    );

    CREATE INDEX IF NOT EXISTS song_alias_suggestion_status_idx
      ON song_alias_suggestion (status, created_at DESC);

    CREATE TABLE IF NOT EXISTS score (
      id text PRIMARY KEY,
      player_id text NOT NULL REFERENCES player(id) ON DELETE CASCADE,
      song_id text NOT NULL,
      difficulty text NOT NULL CHECK (difficulty IN ('BASIC', 'ADVANCED', 'EXPERT', 'MASTER', 'REMASTER')),
      chart_type text NOT NULL CHECK (chart_type IN ('STANDARD', 'DX')),
      level text NOT NULL DEFAULT '',
      achievement double precision,
      chart_constant double precision,
      version text,
      fc text,
      sync text,
      dx_score integer,
      dx_total integer,
      dx_stars integer,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (player_id, song_id)
    );

    CREATE INDEX IF NOT EXISTS score_player_idx ON score (player_id);
    CREATE INDEX IF NOT EXISTS score_song_idx ON score (song_id);

    CREATE TABLE IF NOT EXISTS todo (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      player_id text NOT NULL REFERENCES player(id) ON DELETE CASCADE,
      song_key text NOT NULL,
      title text NOT NULL,
      chart_type text NOT NULL,
      image_name text NOT NULL,
      difficulty text NOT NULL,
      target_achievement double precision CHECK (target_achievement IS NULL OR (target_achievement >= 0 AND target_achievement <= 101)),
      target_fc text,
      source text NOT NULL DEFAULT 'manual',
      done boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (player_id, song_key)
    );

    CREATE INDEX IF NOT EXISTS todo_player_idx ON todo (player_id);

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'todo_target_achievement_range'
      ) THEN
        ALTER TABLE todo
          ADD CONSTRAINT todo_target_achievement_range
          CHECK (target_achievement IS NULL OR (target_achievement >= 0 AND target_achievement <= 101));
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS friendship (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      from_player_id text NOT NULL REFERENCES player(id) ON DELETE CASCADE,
      to_player_id text NOT NULL REFERENCES player(id) ON DELETE CASCADE,
      status text NOT NULL CHECK (status IN ('pending', 'accepted')),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (from_player_id, to_player_id)
    );

    CREATE INDEX IF NOT EXISTS friendship_from_idx ON friendship (from_player_id);
    CREATE INDEX IF NOT EXISTS friendship_to_idx ON friendship (to_player_id);

    CREATE TABLE IF NOT EXISTS maimai_friend_identity (
      friend_idx text PRIMARY KEY,
      friend_code_hash text UNIQUE,
      anonymous_number integer UNIQUE,
      display_name text,
      rating integer,
      dan_img_url text,
      icon_img_url text,
      last_seen_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS maimai_friend_observed_score (
      friend_idx text NOT NULL REFERENCES maimai_friend_identity(friend_idx) ON DELETE CASCADE,
      observer_player_id text NOT NULL REFERENCES player(id) ON DELETE CASCADE,
      song_id text NOT NULL,
      difficulty text NOT NULL CHECK (difficulty IN ('BASIC', 'ADVANCED', 'EXPERT', 'MASTER', 'REMASTER')),
      chart_type text NOT NULL CHECK (chart_type IN ('STANDARD', 'DX')),
      level text NOT NULL DEFAULT '',
      achievement double precision NOT NULL,
      fc text,
      sync text,
      source text NOT NULL DEFAULT 'friend_battle',
      observed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (friend_idx, song_id)
    );

    CREATE INDEX IF NOT EXISTS maimai_friend_observed_score_observer_idx
      ON maimai_friend_observed_score (observer_player_id);
    CREATE INDEX IF NOT EXISTS maimai_friend_observed_score_song_idx
      ON maimai_friend_observed_score (song_id);

    ALTER TABLE maimai_friend_identity
      ADD COLUMN IF NOT EXISTS friend_code_hash text;
    ALTER TABLE maimai_friend_identity
      ADD COLUMN IF NOT EXISTS anonymous_number integer;
    ALTER TABLE maimai_friend_identity
      DROP COLUMN IF EXISTS friend_code;

    CREATE UNIQUE INDEX IF NOT EXISTS maimai_friend_identity_code_hash_idx
      ON maimai_friend_identity (friend_code_hash)
      WHERE friend_code_hash IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS maimai_friend_identity_anonymous_number_idx
      ON maimai_friend_identity (anonymous_number)
      WHERE anonymous_number IS NOT NULL;

    CREATE TABLE IF NOT EXISTS recommend_model (
      id text PRIMARY KEY,
      status text NOT NULL CHECK (status IN ('ready', 'failed')),
      factors integer NOT NULL,
      trained_at timestamptz NOT NULL DEFAULT now(),
      input_score_count integer NOT NULL DEFAULT 0,
      input_player_count integer NOT NULL DEFAULT 0,
      input_song_count integer NOT NULL DEFAULT 0,
      model jsonb NOT NULL,
      error text
    );

    CREATE INDEX IF NOT EXISTS recommend_model_trained_at_idx
      ON recommend_model (trained_at DESC);
  `)

  console.log('Schema initialized')
}
