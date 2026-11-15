import { describe, expect, test } from "bun:test";
import { randomVideoId, testStartSeconds } from "../../../tests/helpers.ts";
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
import { cacheFile, idsOf, keepFile, newVideo, raw, videoOf } from "./test-helpers.ts";
import { NotFoundError } from "./types.ts";
import { allowVideo, blockVideo, deleteVideo } from "./videos.ts";

describe("pinning", () => {
    test("pinning queues a download for a video without a file", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        pinVideo(video.youtubeId);
        const pinned = videoOf(video.youtubeId);
        expect([pinned.pinned, pinned.downloadStatus]).toEqual([true, "queued"]);
    });

    test("pinning a downloaded video leaves it ready", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        keepFile(video.youtubeId, "/media/x.mp4");
        pinVideo(video.youtubeId);
        expect(videoOf(video.youtubeId).downloadStatus).toBe("ready");
    });

    test("pinning a video that is downloading leaves it downloading", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        pinVideo(video.youtubeId);
        claimDownload();
        pinVideo(video.youtubeId);
        expect(videoOf(video.youtubeId).downloadStatus).toBe("downloading");
    });

    test("pinning an unknown video reports not found", async () => {
        expect(() => pinVideo(randomVideoId())).toThrow(NotFoundError);
    });

    test("unpinning returns the file path and clears the state", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        keepFile(video.youtubeId, "/media/chan/video.mp4");
        const path = unpinVideo(video.youtubeId);
        const unpinned = videoOf(video.youtubeId);
        expect([path, unpinned.pinned, unpinned.filePath, unpinned.downloadStatus]).toEqual([
            "/media/chan/video.mp4",
            false,
            "",
            "none",
        ]);
    });

    test("unpinning while downloading stops keeping the video", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        pinVideo(video.youtubeId);
        claimDownload();
        unpinVideo(video.youtubeId);
        const unpinned = videoOf(video.youtubeId);
        expect([unpinned.pinned, unpinned.downloadStatus]).toEqual([false, "downloading"]);
    });

    test("unpinning an unknown video reports not found", async () => {
        expect(() => unpinVideo(randomVideoId())).toThrow(NotFoundError);
    });

    test("finishing a download discards the file when unpinned mid-download", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        pinVideo(video.youtubeId);
        claimDownload();
        unpinVideo(video.youtubeId);
        const kept = finishDownload(video.youtubeId, "/media/late.mp4");
        const finished = videoOf(video.youtubeId);
        expect([kept, finished.filePath, finished.downloadStatus]).toEqual([false, "", "none"]);
    });

    test("finishing a download discards the file when the video was removed", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        pinVideo(video.youtubeId);
        claimDownload();
        deleteVideo(video.youtubeId);
        expect(finishDownload(video.youtubeId, "/media/late.mp4")).toBe(false);
    });

    test("finishing a download keeps the file when still pinned", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        pinVideo(video.youtubeId);
        claimDownload();
        const kept = finishDownload(video.youtubeId, "/media/ok.mp4");
        const finished = videoOf(video.youtubeId);
        expect([kept, finished.filePath, finished.downloadStatus]).toEqual([true, "/media/ok.mp4", "ready"]);
    });
});

describe("download queue", () => {
    test("claiming only takes pinned queued videos, each once", async () => {
        const [plain, pinned] = [newVideo(randomVideoId()), newVideo(randomVideoId())];
        allowVideo(plain);
        allowVideo(pinned);
        pinVideo(pinned.youtubeId);
        expect(claimDownload()).toBe(pinned.youtubeId);
        expect(claimDownload()).toBeNull();
    });

    test("queued videos are claimed oldest first, each exactly once", async () => {
        const videos = Array.from({ length: 12 }, () => newVideo(randomVideoId()));
        for (const video of videos) {
            allowVideo(video);
            pinVideo(video.youtubeId);
        }
        const claimed = videos.map(() => claimDownload());
        expect(claimed).toEqual(idsOf(videos));
        expect(claimDownload()).toBeNull();
    });

    test("resetting requeues interrupted downloads and cache copies", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        pinVideo(video.youtubeId);
        claimDownload();
        requestCache(video.youtubeId);
        claimCache();
        resetDownloading();
        const reset = videoOf(video.youtubeId);
        expect([reset.downloadStatus, reset.cacheStatus]).toEqual(["queued", "queued"]);
    });

    test("a failed download records its error and retrying requeues it", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        pinVideo(video.youtubeId);
        claimDownload();
        failDownload(video.youtubeId, "boom");
        const failed = videoOf(video.youtubeId);
        expect([failed.downloadStatus, failed.downloadError]).toEqual(["failed", "boom"]);

        pinVideo(video.youtubeId);
        const retried = videoOf(video.youtubeId);
        expect([retried.downloadStatus, retried.downloadError]).toEqual(["queued", ""]);
    });
});

describe("watch-once cache", () => {
    test("requesting queues only when nothing is in progress", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        requestCache(video.youtubeId);
        expect(videoOf(video.youtubeId).cacheStatus).toBe("queued");
        claimCache();
        requestCache(video.youtubeId);
        expect(videoOf(video.youtubeId).cacheStatus).toBe("downloading");
    });

    test("requesting retries after a failure", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        requestCache(video.youtubeId);
        claimCache();
        failCache(video.youtubeId, "network");
        expect(videoOf(video.youtubeId).cacheError).toBe("network");
        requestCache(video.youtubeId);
        const retried = videoOf(video.youtubeId);
        expect([retried.cacheStatus, retried.cacheError]).toEqual(["queued", ""]);
    });

    test("requesting stamps the video as just used without counting a play", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        requestCache(video.youtubeId);
        const requested = videoOf(video.youtubeId);
        expect([requested.lastPlayedAt, requested.playCount]).toEqual([testStartSeconds, 0]);
    });

    test("claiming serves the most recently played first", async () => {
        const [older, newer] = [newVideo(randomVideoId()), newVideo(randomVideoId())];
        allowVideo(older);
        allowVideo(newer);
        requestCache(older.youtubeId);
        requestCache(newer.youtubeId);
        raw.query("UPDATE videos SET last_played_at = 100 WHERE youtube_id = ?").run(older.youtubeId);
        raw.query("UPDATE videos SET last_played_at = 200 WHERE youtube_id = ?").run(newer.youtubeId);
        expect(claimCache()).toBe(newer.youtubeId);
        expect(claimCache()).toBe(older.youtubeId);
        expect(claimCache()).toBeNull();
    });

    test("finishing discards the file when the video was removed", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        requestCache(video.youtubeId);
        claimCache();
        deleteVideo(video.youtubeId);
        expect(finishCache(video.youtubeId, "/cache/late.mp4")).toBe(false);
    });

    test("finishing discards the file for a video blocked meanwhile", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        requestCache(video.youtubeId);
        claimCache();
        blockVideo(video.youtubeId);
        const stored = finishCache(video.youtubeId, "/cache/late.mp4");
        const finished = videoOf(video.youtubeId);
        expect([stored, finished.cacheStatus, finished.cachePath]).toEqual([false, "none", ""]);
    });

    test("finishing stores the file for a watchable video", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        requestCache(video.youtubeId);
        claimCache();
        expect(finishCache(video.youtubeId, "/cache/ok.mp4")).toBe(true);
        const finished = videoOf(video.youtubeId);
        expect([finished.cacheStatus, finished.cachePath]).toEqual(["ready", "/cache/ok.mp4"]);
    });

    test("cache entries list ready files least recently played first", async () => {
        const [firstVideo, secondVideo, notReady] = [
            newVideo(randomVideoId()),
            newVideo(randomVideoId()),
            newVideo(randomVideoId()),
        ];
        for (const video of [firstVideo, secondVideo, notReady]) {
            allowVideo(video);
        }
        for (const video of [firstVideo, secondVideo]) {
            cacheFile(video.youtubeId, `/cache/${video.youtubeId}.mp4`);
        }
        for (const [index, video] of [firstVideo, secondVideo, notReady].entries()) {
            raw.query("UPDATE videos SET last_played_at = ? WHERE youtube_id = ?").run(
                100 * (3 - index),
                video.youtubeId,
            );
        }
        expect(idsOf(getCacheEntries())).toEqual([secondVideo.youtubeId, firstVideo.youtubeId]);
    });

    test("clearing forgets the cached file", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        cacheFile(video.youtubeId, "/cache/x.mp4");
        clearCache(video.youtubeId);
        const cleared = videoOf(video.youtubeId);
        expect([cleared.cacheStatus, cleared.cachePath]).toEqual(["none", ""]);
    });
});
