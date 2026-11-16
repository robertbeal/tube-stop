import type { SQLQueryBindings } from "bun:sqlite";
import type { VideoId } from "../ytdlp/types.ts";
import { database } from "./database.ts";
import { type NewVideo, NotFoundError, type Page, type Removal, type Video, type VideoPage } from "./types.ts";

export type VideoRow = {
    youtube_id: VideoId;
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
};

export function toVideo(row: VideoRow): Video {
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
export function watchableFor(qualifier: string): string {
    const prefix = qualifier === "" ? "" : `${qualifier}.`;
    return `(${prefix}rule = 'allow' OR (${prefix}rule = 'inherit' AND EXISTS (SELECT 1 FROM channels c WHERE c.youtube_id = ${prefix}channel_yt_id)))`;
}

const channelAllowedExpression = "EXISTS (SELECT 1 FROM channels c WHERE c.youtube_id = v.channel_yt_id)";

export const watchableExpression = watchableFor("v");

export const videoColumns = `v.youtube_id, v.channel_yt_id, v.channel_name, v.title, v.duration, v.rule, v.pinned,
  v.file_path, v.download_status, v.download_error, v.cache_status, v.cache_path, v.cache_error,
  v.last_played_at, v.play_count, v.published_at,
  ${channelAllowedExpression} AS channel_allowed, ${watchableExpression} AS watchable`;

// Videos with a known publish date come first, newest first; the rest follow in the order they were added.
const newestFirst = "ORDER BY v.published_at DESC, v.id DESC";

/** Adds a video found by channel sync. An existing video keeps its rule and details; only a previously unknown publish date is filled in. */
export function insertVideo(video: NewVideo): void {
    database.run(
        `INSERT INTO videos (youtube_id, channel_yt_id, channel_name, title, duration, published_at, rule)
     VALUES (?, ?, ?, ?, ?, ?, 'inherit')
     ON CONFLICT(youtube_id) DO UPDATE SET published_at = excluded.published_at
       WHERE excluded.published_at > 0`,
        [video.youtubeId, video.channelYoutubeId, video.channelName, video.title, video.duration, video.publishedAt],
    );
}

/** Explicitly allows a single video, regardless of its channel. */
export function allowVideo(video: NewVideo): void {
    database.run(
        `INSERT INTO videos (youtube_id, channel_yt_id, channel_name, title, duration, published_at, rule)
     VALUES (?, ?, ?, ?, ?, ?, 'allow')
     ON CONFLICT(youtube_id) DO UPDATE SET rule = 'allow', title = excluded.title,
       channel_yt_id = excluded.channel_yt_id, channel_name = excluded.channel_name, duration = excluded.duration,
       published_at = CASE WHEN excluded.published_at > 0 THEN excluded.published_at ELSE videos.published_at END`,
        [video.youtubeId, video.channelYoutubeId, video.channelName, video.title, video.duration, video.publishedAt],
    );
}

/** Hides a video from the child, even if its channel is allowed. */
export function blockVideo(youtubeId: VideoId): void {
    const changes = database.run("UPDATE videos SET rule = 'block' WHERE youtube_id = ?", [youtubeId]).changes;
    if (changes === 0) {
        throw new NotFoundError();
    }
}

/** Reverses `block`: back to the channel's rule, or to an explicit allow if its channel is not allowed. */
export function unblockVideo(youtubeId: VideoId): void {
    database.run(
        `UPDATE videos SET rule = CASE
       WHEN EXISTS (SELECT 1 FROM channels c WHERE c.youtube_id = videos.channel_yt_id) THEN 'inherit' ELSE 'allow' END
     WHERE youtube_id = ? AND rule = 'block'`,
        [youtubeId],
    );
}

export function getVideo(youtubeId: VideoId): Video | null {
    const row = database
        .query<VideoRow, [VideoId]>(`SELECT ${videoColumns} FROM videos v WHERE v.youtube_id = ?`)
        .get(youtubeId);
    return row === null ? null : toVideo(row);
}

export function queryPage(where: string, parameters: SQLQueryBindings[], page: Page): VideoPage {
    const total = database
        .query<{ total: number }, SQLQueryBindings[]>(`SELECT COUNT(*) AS total FROM videos v WHERE ${where}`)
        .get(...parameters);
    const rows = database
        .query<VideoRow, SQLQueryBindings[]>(
            `SELECT ${videoColumns} FROM videos v WHERE ${where} ${newestFirst} LIMIT ? OFFSET ?`,
        )
        .all(...parameters, page.limit, page.offset);
    return { videos: rows.map(toVideo), total: total?.total ?? 0 };
}

/** One page of the videos the child may watch, newest published first, optionally for one channel. */
export function getWatchableVideos(channelYoutubeId: string, page: Page): VideoPage {
    return channelYoutubeId === ""
        ? queryPage(watchableExpression, [], page)
        : queryPage(`${watchableExpression} AND v.channel_yt_id = ?`, [channelYoutubeId], page);
}

/**
 * One page of the videos an admin needs to see. Without a channel filter these are videos
 * that are explicitly allowed, blocked, pinned or downloading; with one, every video of that channel.
 */
export function getAdminVideos(channelYoutubeId: string, page: Page): VideoPage {
    return channelYoutubeId === ""
        ? queryPage("(v.rule != 'inherit' OR v.pinned = 1 OR v.download_status != 'none')", [], page)
        : queryPage("v.channel_yt_id = ?", [channelYoutubeId], page);
}

/** Counts a play and stamps the last-played time used for cache eviction. */
export function recordPlay(youtubeId: VideoId): void {
    database.run("UPDATE videos SET play_count = play_count + 1, last_played_at = ? WHERE youtube_id = ?", [
        Math.floor(Date.now() / 1000),
        youtubeId,
    ]);
}

/**
 * Takes a video away from the child for good. A video of an allowed channel is blocked (and
 * its files cleared) so channel sync cannot bring it back; any other video is deleted
 * outright. A download in flight is discarded by the worker when it finishes.
 */
export function deleteVideo(youtubeId: VideoId): Removal {
    return database
        .transaction(() => {
            const row = database
                .query<
                    { file_path: string; cache_path: string; channel_allowed: number },
                    [string]
                >(`SELECT file_path, cache_path,
         EXISTS (SELECT 1 FROM channels c WHERE c.youtube_id = videos.channel_yt_id) AS channel_allowed
       FROM videos WHERE youtube_id = ?`)
                .get(youtubeId);
            if (row === null) {
                throw new NotFoundError();
            }
            const blocked = row.channel_allowed === 1;
            if (blocked) {
                database.run(
                    `UPDATE videos SET rule = 'block', pinned = 0,
           file_path = '', download_error = '', cache_path = '', cache_error = '',
           download_status = CASE WHEN download_status = 'downloading' THEN 'downloading' ELSE 'none' END,
           cache_status = CASE WHEN cache_status = 'downloading' THEN 'downloading' ELSE 'none' END
         WHERE youtube_id = ?`,
                    [youtubeId],
                );
            } else {
                database.run("DELETE FROM videos WHERE youtube_id = ?", [youtubeId]);
            }
            return { filePath: row.file_path, cachePath: row.cache_path, blocked };
        })
        .immediate();
}
