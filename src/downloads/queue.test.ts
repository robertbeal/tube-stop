import { describe, expect, test } from "bun:test";
import { randomVideoId, testStartSeconds } from "../../tests/helpers.ts";
import { cacheFile, idsOf, keepFile, newVideo, openTestDatabase, videoOf } from "../db/test-helpers.ts";
import { NotFoundError } from "../db/types.ts";
import { allowVideo, blockVideo, deleteVideo } from "../db/videos.ts";
import {
    claimCache,
    claimDownload,
    clearCache,
    failCache,
    failDownload,
    finishCache,
    finishDownload,
    getCacheEntries,
    pinVideo,
    requestCache,
    resetDownloading,
    unpinVideo,
} from "./queue.ts";

describe("pinning", () => {
    test("pinning queues a download for a video without a file", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        pinVideo(database, video.youtubeId);
        const pinned = videoOf(database, video.youtubeId);
        expect([pinned.pinned, pinned.downloadStatus]).toEqual([true, "queued"]);
    });

    test("pinning a downloaded video leaves it ready", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        keepFile(database, video.youtubeId, "/media/x.mp4");
        pinVideo(database, video.youtubeId);
        expect(videoOf(database, video.youtubeId).downloadStatus).toBe("ready");
    });

    test("pinning a video that is downloading leaves it downloading", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        pinVideo(database, video.youtubeId);
        claimDownload(database);
        pinVideo(database, video.youtubeId);
        expect(videoOf(database, video.youtubeId).downloadStatus).toBe("downloading");
    });

    test("pinning an unknown video reports not found", async () => {
        const { database } = await openTestDatabase();
        expect(() => pinVideo(database, randomVideoId())).toThrow(NotFoundError);
    });

    test("unpinning returns the file path and clears the state", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        keepFile(database, video.youtubeId, "/media/chan/video.mp4");
        const path = unpinVideo(database, video.youtubeId);
        const unpinned = videoOf(database, video.youtubeId);
        expect([path, unpinned.pinned, unpinned.filePath, unpinned.downloadStatus]).toEqual([
            "/media/chan/video.mp4",
            false,
            "",
            "none",
        ]);
    });

    test("unpinning while downloading stops keeping the video", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        pinVideo(database, video.youtubeId);
        claimDownload(database);
        unpinVideo(database, video.youtubeId);
        const unpinned = videoOf(database, video.youtubeId);
        expect([unpinned.pinned, unpinned.downloadStatus]).toEqual([false, "downloading"]);
    });

    test("unpinning an unknown video reports not found", async () => {
        const { database } = await openTestDatabase();
        expect(() => unpinVideo(database, randomVideoId())).toThrow(NotFoundError);
    });

    test("finishing a download discards the file when unpinned mid-download", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        pinVideo(database, video.youtubeId);
        claimDownload(database);
        unpinVideo(database, video.youtubeId);
        const kept = finishDownload(database, video.youtubeId, "/media/late.mp4");
        const finished = videoOf(database, video.youtubeId);
        expect([kept, finished.filePath, finished.downloadStatus]).toEqual([false, "", "none"]);
    });

    test("finishing a download discards the file when the video was removed", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        pinVideo(database, video.youtubeId);
        claimDownload(database);
        deleteVideo(database, video.youtubeId);
        expect(finishDownload(database, video.youtubeId, "/media/late.mp4")).toBe(false);
    });

    test("finishing a download keeps the file when still pinned", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        pinVideo(database, video.youtubeId);
        claimDownload(database);
        const kept = finishDownload(database, video.youtubeId, "/media/ok.mp4");
        const finished = videoOf(database, video.youtubeId);
        expect([kept, finished.filePath, finished.downloadStatus]).toEqual([true, "/media/ok.mp4", "ready"]);
    });
});

describe("download queue", () => {
    test("claiming only takes pinned queued videos, each once", async () => {
        const { database } = await openTestDatabase();
        const [plain, pinned] = [newVideo(randomVideoId()), newVideo(randomVideoId())];
        allowVideo(database, plain);
        allowVideo(database, pinned);
        pinVideo(database, pinned.youtubeId);
        expect(claimDownload(database)).toBe(pinned.youtubeId);
        expect(claimDownload(database)).toBeNull();
    });

    test("queued videos are claimed oldest first, each exactly once", async () => {
        const { database } = await openTestDatabase();
        const videos = Array.from({ length: 12 }, () => newVideo(randomVideoId()));
        for (const video of videos) {
            allowVideo(database, video);
            pinVideo(database, video.youtubeId);
        }
        const claimed = videos.map(() => claimDownload(database));
        expect(claimed).toEqual(idsOf(videos));
        expect(claimDownload(database)).toBeNull();
    });

    test("resetting requeues interrupted downloads and cache copies", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        pinVideo(database, video.youtubeId);
        claimDownload(database);
        requestCache(database, video.youtubeId);
        claimCache(database);
        resetDownloading(database);
        const reset = videoOf(database, video.youtubeId);
        expect([reset.downloadStatus, reset.cacheStatus]).toEqual(["queued", "queued"]);
    });

    test("a failed download records its error and retrying requeues it", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        pinVideo(database, video.youtubeId);
        claimDownload(database);
        failDownload(database, video.youtubeId, "boom");
        const failed = videoOf(database, video.youtubeId);
        expect([failed.downloadStatus, failed.downloadError]).toEqual(["failed", "boom"]);

        pinVideo(database, video.youtubeId);
        const retried = videoOf(database, video.youtubeId);
        expect([retried.downloadStatus, retried.downloadError]).toEqual(["queued", ""]);
    });
});

describe("watch-once cache", () => {
    test("requesting queues only when nothing is in progress", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        requestCache(database, video.youtubeId);
        expect(videoOf(database, video.youtubeId).cacheStatus).toBe("queued");
        claimCache(database);
        requestCache(database, video.youtubeId);
        expect(videoOf(database, video.youtubeId).cacheStatus).toBe("downloading");
    });

    test("requesting retries after a failure", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        requestCache(database, video.youtubeId);
        claimCache(database);
        failCache(database, video.youtubeId, "network");
        expect(videoOf(database, video.youtubeId).cacheError).toBe("network");
        requestCache(database, video.youtubeId);
        const retried = videoOf(database, video.youtubeId);
        expect([retried.cacheStatus, retried.cacheError]).toEqual(["queued", ""]);
    });

    test("requesting stamps the video as just used without counting a play", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        requestCache(database, video.youtubeId);
        const requested = videoOf(database, video.youtubeId);
        expect([requested.lastPlayedAt, requested.playCount]).toEqual([testStartSeconds, 0]);
    });

    test("claiming serves the most recently played first", async () => {
        const { database, raw } = await openTestDatabase();
        const [older, newer] = [newVideo(randomVideoId()), newVideo(randomVideoId())];
        allowVideo(database, older);
        allowVideo(database, newer);
        requestCache(database, older.youtubeId);
        requestCache(database, newer.youtubeId);
        raw.query("UPDATE videos SET last_played_at = 100 WHERE youtube_id = ?").run(older.youtubeId);
        raw.query("UPDATE videos SET last_played_at = 200 WHERE youtube_id = ?").run(newer.youtubeId);
        expect(claimCache(database)).toBe(newer.youtubeId);
        expect(claimCache(database)).toBe(older.youtubeId);
        expect(claimCache(database)).toBeNull();
    });

    test("finishing discards the file when the video was removed", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        requestCache(database, video.youtubeId);
        claimCache(database);
        deleteVideo(database, video.youtubeId);
        expect(finishCache(database, video.youtubeId, "/cache/late.mp4")).toBe(false);
    });

    test("finishing discards the file for a video blocked meanwhile", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        requestCache(database, video.youtubeId);
        claimCache(database);
        blockVideo(database, video.youtubeId);
        const stored = finishCache(database, video.youtubeId, "/cache/late.mp4");
        const finished = videoOf(database, video.youtubeId);
        expect([stored, finished.cacheStatus, finished.cachePath]).toEqual([false, "none", ""]);
    });

    test("finishing stores the file for a watchable video", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        requestCache(database, video.youtubeId);
        claimCache(database);
        expect(finishCache(database, video.youtubeId, "/cache/ok.mp4")).toBe(true);
        const finished = videoOf(database, video.youtubeId);
        expect([finished.cacheStatus, finished.cachePath]).toEqual(["ready", "/cache/ok.mp4"]);
    });

    test("cache entries list ready files least recently played first", async () => {
        const { database, raw } = await openTestDatabase();
        const [firstVideo, secondVideo, notReady] = [
            newVideo(randomVideoId()),
            newVideo(randomVideoId()),
            newVideo(randomVideoId()),
        ];
        for (const video of [firstVideo, secondVideo, notReady]) {
            allowVideo(database, video);
        }
        for (const video of [firstVideo, secondVideo]) {
            cacheFile(database, video.youtubeId, `/cache/${video.youtubeId}.mp4`);
        }
        for (const [index, video] of [firstVideo, secondVideo, notReady].entries()) {
            raw.query("UPDATE videos SET last_played_at = ? WHERE youtube_id = ?").run(
                100 * (3 - index),
                video.youtubeId,
            );
        }
        expect(idsOf(getCacheEntries(database))).toEqual([secondVideo.youtubeId, firstVideo.youtubeId]);
    });

    test("clearing forgets the cached file", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        cacheFile(database, video.youtubeId, "/cache/x.mp4");
        clearCache(database, video.youtubeId);
        const cleared = videoOf(database, video.youtubeId);
        expect([cleared.cacheStatus, cleared.cachePath]).toEqual(["none", ""]);
    });
});
