import { Database, type SQLQueryBindings } from "bun:sqlite";
import { all, get, immediately, requireRow, run } from "./query.ts";
import { migrations } from "./schema.ts";
import {
  type Channel,
  type NewVideo,
  NotFoundError,
  type Page,
  type Removal,
  type Store,
  type Video,
  type VideoPage,
} from "./types.ts";

export * from "./types.ts";

interface VideoRow {
  youtube_id: string;
  channel_yt_id: string;
  channel_name: string;
  title: string;
  duration: number;
  rule: Video["rule"];
  pinned: number;
  file_path: string;
  download_status: Video["downloadStatus"];
  download_error: string;
  cache_status: Video["cacheStatus"];
  cache_path: string;
  cache_error: string;
  last_played_at: number;
  play_count: number;
  published_at: number;
  channel_allowed: number;
  watchable: number;
}

interface ChannelRow {
  id: number;
  youtube_id: string;
  name: string;
  last_synced_at: number;
  video_count: number;
}

function toVideo(row: VideoRow): Video {
  return {
    youtubeId: row.youtube_id,
    channelYoutubeId: row.channel_yt_id,
    channelName: row.channel_name,
    title: row.title,
    duration: row.duration,
    rule: row.rule,
    pinned: row.pinned === 1,
    filePath: row.file_path,
    downloadStatus: row.download_status,
    downloadError: row.download_error,
    cacheStatus: row.cache_status,
    cachePath: row.cache_path,
    cacheError: row.cache_error,
    lastPlayedAt: row.last_played_at,
    playCount: row.play_count,
    publishedAt: row.published_at,
    channelAllowed: row.channel_allowed === 1,
    watchable: row.watchable === 1,
  };
}

/**
 * The SQL condition for "the child may watch this video": explicitly allowed, or inheriting
 * from an allowed channel (so blocked videos are excluded). `qualifier` is the table alias
 * to prefix columns with; UPDATE ... RETURNING needs none.
 */
function watchableFor(qualifier: string): string {
  const prefix = qualifier === "" ? "" : `${qualifier}.`;
  return `(${prefix}rule = 'allow' OR (${prefix}rule = 'inherit' AND EXISTS (SELECT 1 FROM channels c WHERE c.youtube_id = ${prefix}channel_yt_id)))`;
}

const channelAllowedExpression = "EXISTS (SELECT 1 FROM channels c WHERE c.youtube_id = v.channel_yt_id)";
const watchableExpression = watchableFor("v");

const videoColumns = `v.youtube_id, v.channel_yt_id, v.channel_name, v.title, v.duration, v.rule, v.pinned,
  v.file_path, v.download_status, v.download_error, v.cache_status, v.cache_path, v.cache_error,
  v.last_played_at, v.play_count, v.published_at,
  ${channelAllowedExpression} AS channel_allowed, ${watchableExpression} AS watchable`;

// Videos with a known publish date come first, newest first; the rest follow in the order they were added.
const newestFirst = "ORDER BY v.published_at DESC, v.id DESC";

const unixSeconds = () => Math.floor(Date.now() / 1000);

export function openStore(path: string, now: () => number = unixSeconds): Store {
  const database = new Database(path, { create: true, strict: true });
  database.run("PRAGMA busy_timeout = 5000");
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA foreign_keys = ON");
  migrate(database);
  return { database, now };
}

export function closeStore(store: Store): void {
  store.database.close();
}

function migrate(database: Database): void {
  const row = database.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const version = row?.user_version ?? 0;
  if (version > migrations.length) {
    throw new Error(
      `database schema version ${version} is newer than this build supports (${migrations.length})`,
    );
  }
  migrations.slice(version).forEach((migration, index) => {
    const number = version + index + 1;
    database
      .transaction(() => {
        database.run(migration);
        database.run(`PRAGMA user_version = ${number}`);
      })
      .immediate();
  });
}

// ---- channels ----

/** Allows a channel, or renames it if it is already allowed. */
export function insertChannel(store: Store, youtubeId: string, name: string): void {
  run(
    store,
    `INSERT INTO channels (youtube_id, name) VALUES (?, ?)
     ON CONFLICT(youtube_id) DO UPDATE SET name = excluded.name`,
    youtubeId,
    name,
  );
}

/** Allowed channels by name, with the number of non-blocked videos known for each. */
export function getChannels(store: Store): Channel[] {
  return all<ChannelRow>(
    store,
    `SELECT c.id, c.youtube_id, c.name, c.last_synced_at,
       (SELECT COUNT(*) FROM videos v WHERE v.channel_yt_id = c.youtube_id AND v.rule != 'block') AS video_count
     FROM channels c ORDER BY c.name COLLATE NOCASE`,
  ).map((row) => ({
    id: row.id,
    youtubeId: row.youtube_id,
    name: row.name,
    lastSyncedAt: row.last_synced_at,
    videoCount: row.video_count,
  }));
}

/**
 * Stops allowing a channel. Its videos become hidden unless individually allowed, and their
 * watch-once cache entries are cleared: the returned paths are the cache files for the
 * caller to delete. Pinned files are left alone.
 */
export function deleteChannel(store: Store, id: number): string[] {
  return immediately(store, () => {
    const channel = get<{ youtube_id: string }>(store, "SELECT youtube_id FROM channels WHERE id = ?", id);
    if (channel === null) {
      throw new NotFoundError();
    }
    const cachePaths = all<{ cache_path: string }>(
      store,
      `SELECT cache_path FROM videos WHERE channel_yt_id = ? AND rule = 'inherit' AND cache_path != ''`,
      channel.youtube_id,
    ).map((row) => row.cache_path);
    run(
      store,
      `UPDATE videos SET cache_path = '', cache_error = '',
         cache_status = CASE WHEN cache_status = 'downloading' THEN 'downloading' ELSE 'none' END
       WHERE channel_yt_id = ? AND rule = 'inherit'`,
      channel.youtube_id,
    );
    run(store, "DELETE FROM channels WHERE id = ?", id);
    return cachePaths;
  });
}

export function markChannelSynced(store: Store, youtubeId: string): void {
  run(store, "UPDATE channels SET last_synced_at = ? WHERE youtube_id = ?", store.now(), youtubeId);
}

/** Channels that have at least one watchable video. */
export function getWatchableChannels(store: Store): Pick<Channel, "youtubeId" | "name">[] {
  return all<{ channel_yt_id: string; channel_name: string }>(
    store,
    `SELECT DISTINCT v.channel_yt_id, v.channel_name FROM videos v
     WHERE ${watchableExpression} AND v.channel_yt_id != '' ORDER BY v.channel_name COLLATE NOCASE`,
  ).map((row) => ({ youtubeId: row.channel_yt_id, name: row.channel_name }));
}

// ---- videos ----

/** Adds a video found by channel sync. An existing video keeps its rule and details; only a previously unknown publish date is filled in. */
export function insertVideo(store: Store, video: NewVideo): void {
  run(
    store,
    `INSERT INTO videos (youtube_id, channel_yt_id, channel_name, title, duration, published_at, rule)
     VALUES (?, ?, ?, ?, ?, ?, 'inherit')
     ON CONFLICT(youtube_id) DO UPDATE SET published_at = excluded.published_at
       WHERE excluded.published_at > 0`,
    video.youtubeId,
    video.channelYoutubeId,
    video.channelName,
    video.title,
    video.duration,
    video.publishedAt,
  );
}

/** Explicitly allows a single video, regardless of its channel. */
export function allowVideo(store: Store, video: NewVideo): void {
  run(
    store,
    `INSERT INTO videos (youtube_id, channel_yt_id, channel_name, title, duration, published_at, rule)
     VALUES (?, ?, ?, ?, ?, ?, 'allow')
     ON CONFLICT(youtube_id) DO UPDATE SET rule = 'allow', title = excluded.title,
       channel_yt_id = excluded.channel_yt_id, channel_name = excluded.channel_name, duration = excluded.duration,
       published_at = CASE WHEN excluded.published_at > 0 THEN excluded.published_at ELSE videos.published_at END`,
    video.youtubeId,
    video.channelYoutubeId,
    video.channelName,
    video.title,
    video.duration,
    video.publishedAt,
  );
}

/** Hides a video from the child, even if its channel is allowed. */
export function blockVideo(store: Store, youtubeId: string): void {
  requireRow(run(store, "UPDATE videos SET rule = 'block' WHERE youtube_id = ?", youtubeId));
}

/** Reverses `block`: back to the channel's rule, or to an explicit allow if its channel is not allowed. */
export function unblockVideo(store: Store, youtubeId: string): void {
  run(
    store,
    `UPDATE videos SET rule = CASE
       WHEN EXISTS (SELECT 1 FROM channels c WHERE c.youtube_id = videos.channel_yt_id) THEN 'inherit' ELSE 'allow' END
     WHERE youtube_id = ? AND rule = 'block'`,
    youtubeId,
  );
}

export function getVideo(store: Store, youtubeId: string): Video | null {
  const row = get<VideoRow>(store, `SELECT ${videoColumns} FROM videos v WHERE v.youtube_id = ?`, youtubeId);
  return row === null ? null : toVideo(row);
}

function queryPage(store: Store, where: string, parameters: SQLQueryBindings[], page: Page): VideoPage {
  const total = get<{ total: number }>(
    store,
    `SELECT COUNT(*) AS total FROM videos v WHERE ${where}`,
    ...parameters,
  );
  const rows = all<VideoRow>(
    store,
    `SELECT ${videoColumns} FROM videos v WHERE ${where} ${newestFirst} LIMIT ? OFFSET ?`,
    ...parameters,
    page.limit,
    page.offset,
  );
  return { videos: rows.map(toVideo), total: total?.total ?? 0 };
}

/** One page of the videos the child may watch, newest published first, optionally for one channel. */
export function getWatchableVideos(store: Store, channelYoutubeId: string, page: Page): VideoPage {
  return channelYoutubeId === ""
    ? queryPage(store, watchableExpression, [], page)
    : queryPage(store, `${watchableExpression} AND v.channel_yt_id = ?`, [channelYoutubeId], page);
}

/**
 * One page of the videos an admin needs to see. Without a channel filter these are videos
 * that are explicitly allowed, blocked, pinned or downloading; with one, every video of that channel.
 */
export function getAdminVideos(store: Store, channelYoutubeId: string, page: Page): VideoPage {
  return channelYoutubeId === ""
    ? queryPage(store, "(v.rule != 'inherit' OR v.pinned = 1 OR v.download_status != 'none')", [], page)
    : queryPage(store, "v.channel_yt_id = ?", [channelYoutubeId], page);
}

/** Counts a play and stamps the last-played time used for cache eviction. */
export function recordPlay(store: Store, youtubeId: string): void {
  run(
    store,
    "UPDATE videos SET play_count = play_count + 1, last_played_at = ? WHERE youtube_id = ?",
    store.now(),
    youtubeId,
  );
}

// ---- pinning and downloads ----

/** Marks a video to be kept, and queues a download if no file is ready. */
export function pinVideo(store: Store, youtubeId: string): void {
  requireRow(
    run(
      store,
      `UPDATE videos SET pinned = 1,
         download_status = CASE WHEN download_status = 'ready' THEN 'ready' WHEN download_status = 'downloading' THEN 'downloading' ELSE 'queued' END,
         download_error = ''
       WHERE youtube_id = ?`,
      youtubeId,
    ),
  );
}

/**
 * Clears the pin and returns the file path to delete. If a download is in flight the status
 * stays 'downloading' so the worker can finish and discard it.
 */
export function unpinVideo(store: Store, youtubeId: string): string {
  return immediately(store, () => {
    const video = get<{ file_path: string }>(
      store,
      "SELECT file_path FROM videos WHERE youtube_id = ?",
      youtubeId,
    );
    if (video === null) {
      throw new NotFoundError();
    }
    run(
      store,
      `UPDATE videos SET pinned = 0, file_path = '', download_error = '',
         download_status = CASE WHEN download_status = 'downloading' THEN 'downloading' ELSE 'none' END
       WHERE youtube_id = ?`,
      youtubeId,
    );
    return video.file_path;
  });
}

/**
 * Takes a video away from the child for good. A video of an allowed channel is blocked (and
 * its files cleared) so channel sync cannot bring it back; any other video is deleted
 * outright. A download in flight is discarded by the worker when it finishes.
 */
export function deleteVideo(store: Store, youtubeId: string): Removal {
  return immediately(store, () => {
    const row = get<{ file_path: string; cache_path: string; channel_allowed: number }>(
      store,
      `SELECT file_path, cache_path,
         EXISTS (SELECT 1 FROM channels c WHERE c.youtube_id = videos.channel_yt_id) AS channel_allowed
       FROM videos WHERE youtube_id = ?`,
      youtubeId,
    );
    if (row === null) {
      throw new NotFoundError();
    }
    const blocked = row.channel_allowed === 1;
    if (blocked) {
      run(
        store,
        `UPDATE videos SET rule = 'block', pinned = 0,
           file_path = '', download_error = '', cache_path = '', cache_error = '',
           download_status = CASE WHEN download_status = 'downloading' THEN 'downloading' ELSE 'none' END,
           cache_status = CASE WHEN cache_status = 'downloading' THEN 'downloading' ELSE 'none' END
         WHERE youtube_id = ?`,
        youtubeId,
      );
    } else {
      run(store, "DELETE FROM videos WHERE youtube_id = ?", youtubeId);
    }
    return { filePath: row.file_path, cachePath: row.cache_path, blocked };
  });
}

/** Requeues downloads that were interrupted by a restart. */
export function resetDownloading(store: Store): void {
  run(store, "UPDATE videos SET download_status = 'queued' WHERE download_status = 'downloading'");
  run(store, "UPDATE videos SET cache_status = 'queued' WHERE cache_status = 'downloading'");
}

/** Atomically moves the oldest queued pinned video to 'downloading'. Null if none is queued. */
export function claimDownload(store: Store): string | null {
  const row = get<{ youtube_id: string }>(
    store,
    `UPDATE videos SET download_status = 'downloading'
     WHERE id = (SELECT id FROM videos WHERE download_status = 'queued' AND pinned = 1 ORDER BY id LIMIT 1)
     RETURNING youtube_id`,
  );
  return row?.youtube_id ?? null;
}

/** Records a completed pin download. False when the video was unpinned or removed meanwhile: the caller must then delete the file. */
export function finishDownload(store: Store, youtubeId: string, path: string): boolean {
  const row = get<{ pinned: number }>(
    store,
    `UPDATE videos SET
       download_status = CASE WHEN pinned = 1 THEN 'ready' ELSE 'none' END,
       file_path = CASE WHEN pinned = 1 THEN ? ELSE '' END, download_error = ''
     WHERE youtube_id = ? RETURNING pinned`,
    path,
    youtubeId,
  );
  return row?.pinned === 1;
}

export function failDownload(store: Store, youtubeId: string, message: string): void {
  run(
    store,
    "UPDATE videos SET download_status = 'failed', download_error = ? WHERE youtube_id = ?",
    message,
    youtubeId,
  );
}

// ---- cache (watch-once copies) ----

/**
 * Queues a cache download unless one is already queued, running or ready. It also stamps the
 * video as just used, so a copy that is fetched but not yet played is not evicted as stale.
 */
export function requestCache(store: Store, youtubeId: string): void {
  run(
    store,
    `UPDATE videos SET cache_status = 'queued', cache_error = '', last_played_at = ?
     WHERE youtube_id = ? AND cache_status IN ('none','failed')`,
    store.now(),
    youtubeId,
  );
}

/** Atomically moves the most recently played queued cache request to 'downloading'. Null if none is queued. */
export function claimCache(store: Store): string | null {
  const row = get<{ youtube_id: string }>(
    store,
    `UPDATE videos SET cache_status = 'downloading'
     WHERE id = (SELECT id FROM videos WHERE cache_status = 'queued' ORDER BY last_played_at DESC, id LIMIT 1)
     RETURNING youtube_id`,
  );
  return row?.youtube_id ?? null;
}

/**
 * Records a completed cache download. False when the video was removed, blocked, or otherwise
 * stopped being watchable while downloading: the caller must then delete the file.
 */
export function finishCache(store: Store, youtubeId: string, path: string): boolean {
  const watchable = watchableFor("");
  const row = get<{ watchable: number }>(
    store,
    `UPDATE videos SET
       cache_status = CASE WHEN ${watchable} THEN 'ready' ELSE 'none' END,
       cache_path = CASE WHEN ${watchable} THEN ? ELSE '' END, cache_error = ''
     WHERE youtube_id = ? RETURNING ${watchable} AS watchable`,
    path,
    youtubeId,
  );
  return row?.watchable === 1;
}

export function failCache(store: Store, youtubeId: string, message: string): void {
  run(
    store,
    "UPDATE videos SET cache_status = 'failed', cache_error = ? WHERE youtube_id = ?",
    message,
    youtubeId,
  );
}

/** Forgets a cached file (the caller deletes it from disk). */
export function clearCache(store: Store, youtubeId: string): void {
  run(
    store,
    "UPDATE videos SET cache_status = 'none', cache_path = '', cache_error = '' WHERE youtube_id = ?",
    youtubeId,
  );
}

/** Ready cache files, least recently played first. */
export function getCacheEntries(store: Store): Video[] {
  return all<VideoRow>(
    store,
    `SELECT ${videoColumns} FROM videos v WHERE v.cache_status = 'ready' ORDER BY v.last_played_at`,
  ).map(toVideo);
}
