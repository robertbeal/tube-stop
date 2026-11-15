import type { VideoId } from "../ytdlp/types.ts";
import { database } from "./database.ts";
import { NotFoundError, type Video } from "./types.ts";
import { toVideo, type VideoRow, videoColumns, watchableFor } from "./videos.ts";

/** Marks a video to be kept, and queues a download if no file is ready. */
export function pinVideo(youtubeId: VideoId): void {
    const changes = database.run(
        `UPDATE videos SET pinned = 1,
       download_status = CASE WHEN download_status = 'ready' THEN 'ready' WHEN download_status = 'downloading' THEN 'downloading' ELSE 'queued' END,
       download_error = ''
     WHERE youtube_id = ?`,
        [youtubeId],
    ).changes;
    if (changes === 0) {
        throw new NotFoundError();
    }
}

/**
 * Clears the pin and returns the file path to delete. If a download is in flight the status
 * stays 'downloading' so the worker can finish and discard it.
 */
export function unpinVideo(youtubeId: VideoId): string {
    return database
        .transaction(() => {
            const video = database
                .query<{ file_path: string }, [string]>("SELECT file_path FROM videos WHERE youtube_id = ?")
                .get(youtubeId);
            if (video === null) {
                throw new NotFoundError();
            }
            database.run(
                `UPDATE videos SET pinned = 0, file_path = '', download_error = '',
         download_status = CASE WHEN download_status = 'downloading' THEN 'downloading' ELSE 'none' END
       WHERE youtube_id = ?`,
                [youtubeId],
            );
            return video.file_path;
        })
        .immediate();
}

/** Requeues downloads that were interrupted by a restart. */
export function resetDownloading(): void {
    database.run("UPDATE videos SET download_status = 'queued' WHERE download_status = 'downloading'");
    database.run("UPDATE videos SET cache_status = 'queued' WHERE cache_status = 'downloading'");
}

/** Atomically moves the oldest queued pinned video to 'downloading'. Null if none is queued. */
export function claimDownload(): VideoId | null {
    const row = database
        .query<{ youtube_id: VideoId }, []>(`UPDATE videos SET download_status = 'downloading'
     WHERE id = (SELECT id FROM videos WHERE download_status = 'queued' AND pinned = 1 ORDER BY id LIMIT 1)
     RETURNING youtube_id`)
        .get();
    return row?.youtube_id ?? null;
}

/** Records a completed pin download. False when the video was unpinned or removed meanwhile: the caller must then delete the file. */
export function finishDownload(youtubeId: VideoId, path: string): boolean {
    const row = database
        .query<{ pinned: number }, [string, string]>(`UPDATE videos SET
       download_status = CASE WHEN pinned = 1 THEN 'ready' ELSE 'none' END,
       file_path = CASE WHEN pinned = 1 THEN ? ELSE '' END, download_error = ''
     WHERE youtube_id = ? RETURNING pinned`)
        .get(path, youtubeId);
    return row?.pinned === 1;
}

export function failDownload(youtubeId: VideoId, message: string): void {
    database.run("UPDATE videos SET download_status = 'failed', download_error = ? WHERE youtube_id = ?", [
        message,
        youtubeId,
    ]);
}

/**
 * Queues a cache download unless one is already queued, running or ready. It also stamps the
 * video as just used, so a copy that is fetched but not yet played is not evicted as stale.
 */
export function requestCache(youtubeId: VideoId): void {
    database.run(
        `UPDATE videos SET cache_status = 'queued', cache_error = '', last_played_at = ?
     WHERE youtube_id = ? AND cache_status IN ('none','failed')`,
        [Math.floor(Date.now() / 1000), youtubeId],
    );
}

/** Atomically moves the most recently played queued cache request to 'downloading'. Null if none is queued. */
export function claimCache(): VideoId | null {
    const row = database
        .query<{ youtube_id: VideoId }, []>(`UPDATE videos SET cache_status = 'downloading'
     WHERE id = (SELECT id FROM videos WHERE cache_status = 'queued' ORDER BY last_played_at DESC, id LIMIT 1)
     RETURNING youtube_id`)
        .get();
    return row?.youtube_id ?? null;
}

/**
 * Records a completed cache download. False when the video was removed, blocked, or otherwise
 * stopped being watchable while downloading: the caller must then delete the file.
 */
export function finishCache(youtubeId: VideoId, path: string): boolean {
    const watchable = watchableFor("");
    const row = database
        .query<{ watchable: number }, [string, string]>(`UPDATE videos SET
       cache_status = CASE WHEN ${watchable} THEN 'ready' ELSE 'none' END,
       cache_path = CASE WHEN ${watchable} THEN ? ELSE '' END, cache_error = ''
     WHERE youtube_id = ? RETURNING ${watchable} AS watchable`)
        .get(path, youtubeId);
    return row?.watchable === 1;
}

export function failCache(youtubeId: VideoId, message: string): void {
    database.run("UPDATE videos SET cache_status = 'failed', cache_error = ? WHERE youtube_id = ?", [
        message,
        youtubeId,
    ]);
}

/** Forgets a cached file (the caller deletes it from disk). */
export function clearCache(youtubeId: VideoId): void {
    database.run("UPDATE videos SET cache_status = 'none', cache_path = '', cache_error = '' WHERE youtube_id = ?", [
        youtubeId,
    ]);
}

/** Ready cache files, least recently played first. */
export function getCacheEntries(): Video[] {
    return database
        .query<VideoRow, []>(
            `SELECT ${videoColumns} FROM videos v WHERE v.cache_status = 'ready' ORDER BY v.last_played_at`,
        )
        .all()
        .map(toVideo);
}
