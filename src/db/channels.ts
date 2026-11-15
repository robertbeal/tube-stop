import { database } from "./database.ts";
import { type Channel, NotFoundError } from "./types.ts";
import { watchableExpression } from "./videos.ts";

type ChannelRow = {
    id: number;
    youtube_id: string;
    name: string;
    last_synced_at: number;
    video_count: number;
};

/** Allows a channel, or renames it if it is already allowed. */
export function insertChannel(youtubeId: string, name: string): void {
    database.run(
        `INSERT INTO channels (youtube_id, name) VALUES (?, ?)
     ON CONFLICT(youtube_id) DO UPDATE SET name = excluded.name`,
        [youtubeId, name],
    );
}

/** Allowed channels by name, with the number of non-blocked videos known for each. */
export function getChannels(): Channel[] {
    return database
        .query<ChannelRow, []>(`SELECT c.id, c.youtube_id, c.name, c.last_synced_at,
       (SELECT COUNT(*) FROM videos v WHERE v.channel_yt_id = c.youtube_id AND v.rule != 'block') AS video_count
     FROM channels c ORDER BY c.name COLLATE NOCASE`)
        .all()
        .map((row) => ({
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
export function deleteChannel(id: number): string[] {
    return database
        .transaction(() => {
            const channel = database
                .query<{ youtube_id: string }, [number]>("SELECT youtube_id FROM channels WHERE id = ?")
                .get(id);
            if (channel === null) {
                throw new NotFoundError();
            }
            const cachePaths = database
                .query<{ cache_path: string }, [string]>(
                    `SELECT cache_path FROM videos WHERE channel_yt_id = ? AND rule = 'inherit' AND cache_path != ''`,
                )
                .all(channel.youtube_id)
                .map((row) => row.cache_path);
            database.run(
                `UPDATE videos SET cache_path = '', cache_error = '',
         cache_status = CASE WHEN cache_status = 'downloading' THEN 'downloading' ELSE 'none' END
       WHERE channel_yt_id = ? AND rule = 'inherit'`,
                [channel.youtube_id],
            );
            database.run("DELETE FROM channels WHERE id = ?", [id]);
            return cachePaths;
        })
        .immediate();
}

export function markChannelSynced(youtubeId: string): void {
    database.run("UPDATE channels SET last_synced_at = ? WHERE youtube_id = ?", [
        Math.floor(Date.now() / 1000),
        youtubeId,
    ]);
}

/** Channels that have at least one watchable video. */
export function getWatchableChannels(): Pick<Channel, "youtubeId" | "name">[] {
    return database
        .query<
            { channel_yt_id: string; channel_name: string },
            []
        >(`SELECT DISTINCT v.channel_yt_id, v.channel_name FROM videos v
     WHERE ${watchableExpression} AND v.channel_yt_id != '' ORDER BY v.channel_name COLLATE NOCASE`)
        .all()
        .map((row) => ({ youtubeId: row.channel_yt_id, name: row.channel_name }));
}
