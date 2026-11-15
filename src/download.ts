import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
    claimCache,
    claimDownload,
    clearCache,
    failCache,
    failDownload,
    finishCache,
    finishDownload,
    getCacheEntries,
    resetDownloading,
    type Store,
    type Video,
} from "./db/store.ts";
import { removeMedia } from "./storage.ts";
import type { Download } from "./ytdlp/types.ts";

/** Watch-once copies are always fetched at this height. */
const cacheHeight = 720;
/** How often the download loops look for queued work. Looking costs one small query. */
const pollIntervalMs = 1000;
const janitorIntervalMs = 60 * 60 * 1000;

export type DownloadConfig = {
    /** Pinned downloads, one folder per channel. */
    mediaDir: string;
    /** Temporary watch-once copies. */
    cacheDir: string;
    /** Maximum video height for pinned downloads. */
    keepMaxHeight: number;
    /** Cache entries not played for this long are evicted. */
    cacheTtlMs: number;
    /** Cache entries are evicted, least recently played first, above this size. */
    cacheMaxBytes: number;
};

/** Downloads pinned videos and watch-once cache copies, and keeps the cache within its limits. */
export type DownloadWorker = {
    store: Store;
    downloadToLibrary: Download;
    downloadToCache: Download;
    config: DownloadConfig;
    log: (message: string) => void;
};

export const createDownloadWorker = (
    store: Store,
    downloadToLibrary: Download,
    downloadToCache: Download,
    config: DownloadConfig,
    log: (message: string) => void = console.log,
): DownloadWorker => ({
    store,
    downloadToLibrary,
    downloadToCache,
    config,
    log,
});

/** Runs the pin and cache loops and the hourly janitor until `signal` aborts and the loops have stopped. */
export async function runDownloads(worker: DownloadWorker, signal: AbortSignal): Promise<void> {
    resetDownloading(worker.store);
    await Promise.all([
        loop(worker, signal, () => processPin(worker, signal)),
        loop(worker, signal, () => processCache(worker, signal)),
        janitorLoop(worker, signal),
    ]);
}

/** Keeps processing while there is work, then waits a moment before looking again. */
async function loop(worker: DownloadWorker, signal: AbortSignal, processNext: () => Promise<boolean>): Promise<void> {
    while (!signal.aborted) {
        while (await processNext().catch((error) => logFailure(worker, error))) {
            // more work is queued
        }
        await delay(pollIntervalMs, undefined, { signal }).catch(() => undefined);
    }
}

function logFailure(worker: DownloadWorker, error: Error): false {
    worker.log(`download: ${error.message}`);
    return false;
}

async function janitorLoop(worker: DownloadWorker, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
        await janitor(worker);
        await delay(janitorIntervalMs, undefined, { signal }).catch(() => undefined);
    }
}

/** Downloads the next queued pinned video. False when there was nothing to do or the loop should pause. */
export async function processPin(worker: DownloadWorker, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) {
        return false;
    }
    const id = claimDownload(worker.store);
    if (id === null) {
        return false;
    }
    worker.log(`download: pinning ${id}`);
    try {
        const path = await worker.downloadToLibrary(id, worker.config.mediaDir, worker.config.keepMaxHeight, signal);
        const kept = finishDownload(worker.store, id, path);
        if (kept) {
            worker.log(`download: pinned ${id} -> ${path}`);
        } else {
            await discard(worker, worker.config.mediaDir, path); // unpinned or removed while downloading
        }
    } catch (error) {
        worker.log(`download: ${id} failed: ${error.message}`);
        if (signal.aborted) {
            return false;
        }
        failDownload(worker.store, id, error.message);
    }
    return true;
}

/** Downloads the next queued watch-once copy. False when there was nothing to do or the loop should pause. */
export async function processCache(worker: DownloadWorker, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) {
        return false;
    }
    const id = claimCache(worker.store);
    if (id === null) {
        return false;
    }
    worker.log(`cache: fetching ${id}`);
    try {
        const path = await worker.downloadToCache(id, worker.config.cacheDir, cacheHeight, signal);
        const stored = finishCache(worker.store, id, path);
        if (!stored) {
            await discard(worker, worker.config.cacheDir, path); // removed while downloading
        }
    } catch (error) {
        worker.log(`cache: ${id} failed: ${error.message}`);
        if (signal.aborted) {
            return false;
        }
        failCache(worker.store, id, error.message);
    }
    return true;
}

async function discard(worker: DownloadWorker, root: string, path: string): Promise<void> {
    const failures = await removeMedia(root, path);
    for (const failure of failures) {
        worker.log(`download: delete ${path}: ${failure.message}`);
    }
}

/**
 * Evicts cached copies that are redundant (the video is pinned and downloaded), stale (not
 * played within the TTL), or over the size budget (least recently played first).
 */
export async function janitor(worker: DownloadWorker, now: number = Date.now()): Promise<void> {
    const inspected = await Promise.all(
        getCacheEntries(worker.store).map(async (video) => ({ video, size: await fileSize(video.cachePath) })),
    );
    const vanished = inspected.filter(({ size }) => size === undefined);
    const present = inspected.flatMap(({ video, size }) => (size === undefined ? [] : [{ video, size }]));
    const expired = present.filter(({ video }) => isRedundant(video) || isStale(worker, video, now));
    const survivors = present.filter((entry) => !expired.includes(entry));

    for (const { video } of vanished) {
        clearCache(worker.store, video.youtubeId); // the file vanished: fetch again on the next play
    }
    const toEvict = [...expired, ...overBudget(survivors, worker.config.cacheMaxBytes)];
    await Promise.all(toEvict.map(({ video }) => evict(worker, video)));
}

const isRedundant = (video: Video): boolean => video.pinned && video.downloadStatus === "ready";

const isStale = (worker: DownloadWorker, video: Video, now: number): boolean =>
    now - video.lastPlayedAt * 1000 > worker.config.cacheTtlMs;

async function evict(worker: DownloadWorker, video: Video): Promise<void> {
    worker.log(`janitor: evicting ${video.youtubeId}`);
    await discard(worker, worker.config.cacheDir, video.cachePath);
    clearCache(worker.store, video.youtubeId);
}

async function fileSize(path: string): Promise<number | undefined> {
    return stat(path).then(
        (info) => info.size,
        () => undefined,
    );
}

type SizedEntry = {
    video: Video;
    size: number;
};

/** The entries to evict, from the front of the list (least recently played), to bring the total within the budget. */
function overBudget(entries: SizedEntry[], maxBytes: number): SizedEntry[] {
    const total = entries.reduce((sum, { size }) => sum + size, 0);
    return entries.reduce<{ remaining: number; evict: SizedEntry[] }>(
        (state, entry) =>
            state.remaining > maxBytes
                ? { remaining: state.remaining - entry.size, evict: [...state.evict, entry] }
                : state,
        { remaining: total, evict: [] },
    ).evict;
}
