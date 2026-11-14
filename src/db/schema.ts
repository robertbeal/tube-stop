const schema = `
CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  youtube_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  last_synced_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE videos (
  id INTEGER PRIMARY KEY,
  youtube_id TEXT NOT NULL UNIQUE,
  channel_yt_id TEXT NOT NULL DEFAULT '',
  channel_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 0,
  rule TEXT NOT NULL DEFAULT 'inherit' CHECK (rule IN ('allow','block','inherit')),
  pinned INTEGER NOT NULL DEFAULT 0,
  file_path TEXT NOT NULL DEFAULT '',
  download_status TEXT NOT NULL DEFAULT 'none' CHECK (download_status IN ('none','queued','downloading','ready','failed')),
  download_error TEXT NOT NULL DEFAULT '',
  cache_status TEXT NOT NULL DEFAULT 'none' CHECK (cache_status IN ('none','queued','downloading','ready','failed')),
  cache_path TEXT NOT NULL DEFAULT '',
  cache_error TEXT NOT NULL DEFAULT '',
  last_played_at INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX videos_channel ON videos(channel_yt_id);

-- AUTOINCREMENT guarantees an id is never reused after accounts are deleted: otherwise a
-- session left over from a deleted account would silently belong to the next account created.
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * Applied in order; the number applied is kept in PRAGMA user_version. Never edit an existing
 * entry: append a new one instead.
 */
export const migrations: readonly string[] = [schema];
