import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomVideoId, testStart, stubYtDlp as writeStub } from "../../tests/helpers.ts";
import { config } from "../config.ts";
import { allowVideo, deleteVideo, getVideo } from "../db/videos.ts";
import * as downloads from "../ytdlp/download.ts";
import type { VideoId } from "../ytdlp/types.ts";
import { claimCache, claimDownload, finishCache, finishDownload, pinVideo, requestCache, unpinVideo } from "./queue.ts";
import { janitor, processCache, processPin, runDownloads } from "./worker.ts";

const neverAborted = new AbortController().signal;
const hour = 60 * 60 * 1000;
const day = 24 * hour;

async function writeFile(path: string, size: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, new Uint8Array(size));
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false,
    );
}

type FetchCall = {
    kind: "library" | "cache";
    id: VideoId;
    directory: string;
    maxHeight: number;
};

type Download = (call: FetchCall, signal: AbortSignal) => Promise<string>;

/** Replaces both download functions with fakes that record what they were asked for and delegate the outcome. */
function fakeDownloads(download: Download) {
    const calls: FetchCall[] = [];
    const record =
        (kind: FetchCall["kind"]) =>
        (_binary: string, id: VideoId, directory: string, maxHeight: number, signal: AbortSignal) => {
            const call = { kind, id, directory, maxHeight };
            calls.push(call);
            return download(call, signal);
        };
    spyOn(downloads, "downloadToLibrary").mockImplementation(record("library"));
    spyOn(downloads, "downloadToCache").mockImplementation(record("cache"));
    return { calls };
}

/** Downloads that write a small file where yt-dlp would have, and report its path. */
const writingDownloads = (pathFor: (call: FetchCall) => string) =>
    fakeDownloads(async (call) => {
        const path = pathFor(call);
        await writeFile(path, 4);
        return path;
    });

const failingDownloads = () =>
    fakeDownloads(async () => {
        throw new Error("ERROR: boom");
    });

/** Downloads that finish only when `release` is called, after they have started. */
function gatedDownloads(pathFor: (call: FetchCall) => string) {
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const { calls } = fakeDownloads(async (call) => {
        started.resolve();
        await gate.promise;
        const path = pathFor(call);
        await writeFile(path, 4);
        return path;
    });
    return { calls, started: started.promise, release: () => gate.resolve() };
}

/** The app's settings, with the cache limits this test wants. The setup puts them back after the test. */
function useCacheLimits(cacheTtlMs: number, cacheMaxBytes: number): void {
    config.keepMaxHeight = 1080;
    config.cacheTtlMs = cacheTtlMs;
    config.cacheMaxBytes = cacheMaxBytes;
}

function addVideo(youtubeId: VideoId): void {
    allowVideo({
        youtubeId,
        channelYoutubeId: "",
        channelName: "",
        title: `t ${youtubeId}`,
        duration: 0,
        publishedAt: 0,
    });
}

/** Adds a watchable video with a ready cache file of the given size, last played `playedAgoMs` ago. */
async function addCached(size: number, playedAgoMs: number) {
    const id = randomVideoId();
    const path = join(config.cacheDir, `${id}.mp4`);
    await writeFile(path, size);
    addVideo(id);
    setSystemTime(new Date(testStart.getTime() - playedAgoMs));
    requestCache(id);
    claimCache();
    finishCache(id, path);
    setSystemTime(testStart);
    return { id, path };
}

const cacheStatus = (id: VideoId) => getVideo(id)?.cacheStatus;

describe("janitor", () => {
    test("keeps recent files under the budget", async () => {
        useCacheLimits(7 * day, 1 << 20);
        const { id, path } = await addCached(100, hour);

        await janitor();

        expect(await exists(path)).toBe(true);
        expect(cacheStatus(id)).toBe("ready");
    });

    test("evicts files not played within the TTL", async () => {
        useCacheLimits(7 * day, 1 << 20);
        const stale = await addCached(100, 8 * day);
        const fresh = await addCached(100, 6 * day);

        await janitor();

        expect(await exists(stale.path)).toBe(false);
        expect(cacheStatus(stale.id)).toBe("none");
        expect(await exists(fresh.path)).toBe(true);
        expect(cacheStatus(fresh.id)).toBe("ready");
    });

    test("over budget evicts the least recently played first and stops when under", async () => {
        useCacheLimits(30 * day, 250);
        const oldest = await addCached(100, 3 * hour);
        const middle = await addCached(100, 2 * hour);
        const newest = await addCached(100, hour);

        await janitor();

        expect(await exists(oldest.path)).toBe(false);
        expect(cacheStatus(oldest.id)).toBe("none");
        expect(await exists(middle.path)).toBe(true);
        expect(await exists(newest.path)).toBe(true);
        expect(cacheStatus(middle.id)).toBe("ready");
        expect(cacheStatus(newest.id)).toBe("ready");
    });

    test("drops the cached copy once the video is pinned and downloaded", async () => {
        useCacheLimits(7 * day, 1 << 20);
        const { id, path } = await addCached(100, 60_000);
        pinVideo(id);
        claimDownload();
        finishDownload(id, join(config.mediaDir, "kept.mp4"));

        await janitor();

        expect(await exists(path)).toBe(false);
        expect(cacheStatus(id)).toBe("none");
    });

    test("keeps the cached copy while the pinned download is still pending", async () => {
        useCacheLimits(7 * day, 1 << 20);
        const { id, path } = await addCached(100, 60_000);
        pinVideo(id);

        await janitor();

        expect(await exists(path)).toBe(true);
        expect(cacheStatus(id)).toBe("ready");
    });

    test("forgets entries whose file has vanished", async () => {
        useCacheLimits(7 * day, 1 << 20);
        const { id, path } = await addCached(100, 60_000);
        await rm(path);

        await janitor();

        expect(cacheStatus(id)).toBe("none");
    });
});

describe("processCache", () => {
    test("stores the file and marks the video ready", async () => {
        useCacheLimits(hour, 1 << 30);
        const id = randomVideoId();
        const outputPath = join(config.cacheDir, `${id}.mp4`);
        addVideo(id);
        requestCache(id);
        writingDownloads(() => outputPath);

        const didWork = await processCache(neverAborted);

        const video = getVideo(id);
        expect(didWork).toBe(true);
        expect(video?.cacheStatus).toBe("ready");
        expect(video?.cachePath).toBe(outputPath);
        expect(await exists(outputPath)).toBe(true);
    });

    test("records a failure so it can be retried", async () => {
        useCacheLimits(hour, 1 << 30);
        const id = randomVideoId();
        addVideo(id);
        requestCache(id);
        failingDownloads();

        await processCache(neverAborted);

        const video = getVideo(id);
        expect(video?.cacheStatus).toBe("failed");
        expect(video?.cacheError).toContain("boom");
    });

    test("reports no work when nothing is queued", async () => {
        useCacheLimits(hour, 1 << 30);
        expect(await processCache(neverAborted)).toBe(false);
    });

    test("discards the file if the video is removed during the download", async () => {
        useCacheLimits(hour, 1 << 30);
        const id = randomVideoId();
        const outputPath = join(config.cacheDir, `${id}.mp4`);
        addVideo(id);
        requestCache(id);
        const { started, release } = gatedDownloads(() => outputPath);

        const processing = processCache(neverAborted);
        await started;
        deleteVideo(id);
        release();
        await processing;

        expect(await exists(outputPath)).toBe(false);
    });

    test("does not record a failure when the download was cancelled", async () => {
        useCacheLimits(hour, 1 << 30);
        const id = randomVideoId();
        addVideo(id);
        requestCache(id);
        const controller = new AbortController();
        fakeDownloads(async () => {
            controller.abort();
            throw new Error("cancelled");
        });

        const keepGoing = await processCache(controller.signal);

        expect(keepGoing).toBe(false);
        expect(cacheStatus(id)).toBe("downloading");
    });
});

describe("processPin", () => {
    const pinnedPath = (id: VideoId) => join(config.mediaDir, "Chan", `video [${id}].mp4`);

    test("keeps the downloaded file in the media folder", async () => {
        useCacheLimits(hour, 1 << 30);
        const id = randomVideoId();
        addVideo(id);
        pinVideo(id);
        writingDownloads(() => pinnedPath(id));

        await processPin(neverAborted);

        const video = getVideo(id);
        expect(video?.downloadStatus).toBe("ready");
        expect(video?.filePath).toBe(pinnedPath(id));
        expect(await exists(pinnedPath(id))).toBe(true);
    });

    test("unpinned during the download discards the file", async () => {
        useCacheLimits(hour, 1 << 30);
        const id = randomVideoId();
        addVideo(id);
        pinVideo(id);
        const { started, release } = gatedDownloads(() => pinnedPath(id));

        const processing = processPin(neverAborted);
        await started;
        unpinVideo(id);
        release();
        await processing;

        const video = getVideo(id);
        expect(await exists(pinnedPath(id))).toBe(false);
        expect(video?.pinned).toBe(false);
        expect(video?.filePath).toBe("");
        expect(video?.downloadStatus).toBe("none");
    });

    test("re-pinned during the download keeps the file", async () => {
        useCacheLimits(hour, 1 << 30);
        const id = randomVideoId();
        addVideo(id);
        pinVideo(id);
        const { started, release } = gatedDownloads(() => pinnedPath(id));

        const processing = processPin(neverAborted);
        await started;
        unpinVideo(id);
        pinVideo(id);
        release();
        await processing;

        const video = getVideo(id);
        expect(await exists(pinnedPath(id))).toBe(true);
        expect(video?.pinned).toBe(true);
        expect(video?.downloadStatus).toBe("ready");
    });

    test("records a failure without losing the pin", async () => {
        useCacheLimits(hour, 1 << 30);
        const id = randomVideoId();
        addVideo(id);
        pinVideo(id);
        failingDownloads();

        await processPin(neverAborted);

        const video = getVideo(id);
        expect(video?.downloadStatus).toBe("failed");
        expect(video?.pinned).toBe(true);
        expect(video?.downloadError).toContain("boom");
    });

    test("reports no work when nothing is queued", async () => {
        useCacheLimits(hour, 1 << 30);
        expect(await processPin(neverAborted)).toBe(false);
    });
});

describe("with a stub yt-dlp", () => {
    test("a pinned download lands in the media folder through the real client", async () => {
        useCacheLimits(hour, 1 << 30);
        const id = randomVideoId();
        const outputPath = join(config.mediaDir, "Chan", `video [${id}].mp4`);
        const stub = await writeStub(
            `mkdir -p "$(dirname '${outputPath}')"\necho data > '${outputPath}'\necho '${outputPath}'`,
        );
        await chmod(stub.binary, 0o755); // Bun.write ignores its mode option on some versions
        addVideo(id);
        pinVideo(id);

        config.ytdlpBin = stub.binary;
        await processPin(neverAborted);

        expect(getVideo(id)?.filePath).toBe(outputPath);
        expect(await exists(outputPath)).toBe(true);
    });
});

describe("what the workers ask for", () => {
    test("pins go to the library at the keep quality and caches get a fixed 720p", async () => {
        useCacheLimits(hour, 1 << 30);
        const { calls } = failingDownloads();
        const [pinned, watched] = [randomVideoId(), randomVideoId()];
        addVideo(pinned);
        addVideo(watched);
        pinVideo(pinned);
        requestCache(watched);
        config.keepMaxHeight = 1440;

        await processPin(neverAborted);
        await processCache(neverAborted);

        expect(calls).toEqual([
            { kind: "library", id: pinned, directory: config.mediaDir, maxHeight: 1440 },
            { kind: "cache", id: watched, directory: config.cacheDir, maxHeight: 720 },
        ]);
    });
});

describe("run", () => {
    test("stops promptly when the signal is aborted", async () => {
        useCacheLimits(hour, 1 << 30);
        const controller = new AbortController();

        const running = runDownloads(controller.signal);
        await Bun.sleep(50);
        controller.abort();

        await running;
    });

    test("requeues downloads interrupted by a restart", async () => {
        useCacheLimits(hour, 1 << 30);
        const id = randomVideoId();
        addVideo(id);
        pinVideo(id);
        claimDownload(); // "downloading" when the previous process died
        const fetched = Promise.withResolvers<void>();
        fakeDownloads(async () => {
            fetched.resolve();
            throw new Error("stop here");
        });
        const controller = new AbortController();

        const running = runDownloads(controller.signal);
        await fetched.promise;
        controller.abort();

        await running;
    });
});
