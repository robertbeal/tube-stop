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

const topics = `
CREATE TABLE topics (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'primary',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE channel_topics (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, topic_id)
);

-- Keyed by YouTube id, like the rest of the video's links: a deleted video takes its tags with it.
CREATE TABLE video_topics (
  video_youtube_id TEXT NOT NULL REFERENCES videos(youtube_id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (video_youtube_id, topic_id)
);
`;

const starterTopics = `
INSERT INTO topics (slug, name, emoji, color, position) VALUES
  ('nature', 'Nature', '🌿', 'success', 1),
  ('animals', 'Animals', '🐾', 'warning', 2),
  ('science', 'Science', '🔬', 'info', 3),
  ('music', 'Music', '🎵', 'danger', 4),
  ('stories', 'Stories', '📚', 'primary', 5),
  ('art-and-making', 'Art & Making', '🎨', 'secondary', 6);
`;

/**
 * Applied in order; the number applied is kept in PRAGMA user_version. Never edit an existing
 * entry: append a new one instead.
 */
export const migrations: readonly string[] = [schema, topics, starterTopics];
