import { describe, expect, test } from "bun:test";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Store } from "../src/db/store.ts";
import { type DownloadConfig, DownloadWorker } from "../src/download.ts";
import { type Fetcher, YtDlp } from "../src/ytdlp.ts";
import { randomVideoId, temporaryDirectory, stubYtDlp as writeStub } from "./helpers.ts";

const neverAborted = new AbortController().signal;
const hour = 60 * 60 * 1000;
const day = 24 * hour;
const baseTimeSeconds = 2_000_000_000;

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

interface FetchCall {
  kind: "library" | "cache";
  id: string;
  directory: string;
  maxHeight: number;
}

type Download = (call: FetchCall, signal?: AbortSignal) => Promise<string>;

/** A fetcher that records what it was asked for and delegates the outcome. */
function fakeFetcher(download: Download) {
  const calls: FetchCall[] = [];
  const record =
    (kind: FetchCall["kind"]) => (id: string, directory: string, maxHeight: number, signal?: AbortSignal) => {
      const call = { kind, id, directory, maxHeight };
      calls.push(call);
      return download(call, signal);
    };
  const fetcher: Fetcher = { downloadToLibrary: record("library"), downloadToCache: record("cache") };
  return { fetcher, calls };
}

/** A fetcher that writes a small file where yt-dlp would have, and reports its path. */
const writingFetcher = (pathFor: (call: FetchCall) => string) =>
  fakeFetcher(async (call) => {
    const path = pathFor(call);
    await writeFile(path, 4);
    return path;
  });

const failingFetcher = () =>
  fakeFetcher(async () => {
    throw new Error("ERROR: boom");
  });

/** A fetcher whose downloads finish only when `release` is called, after they have started. */
function gatedFetcher(pathFor: (call: FetchCall) => string) {
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const { fetcher, calls } = fakeFetcher(async (call) => {
    started.resolve();
    await gate.promise;
    const path = pathFor(call);
    await writeFile(path, 4);
    return path;
  });
  return { fetcher, calls, started: started.promise, release: () => gate.resolve() };
}

interface Fixture {
  store: Store;
  config: DownloadConfig;
  logs: string[];
  workerWith(fetcher: Fetcher, overrides?: Partial<DownloadConfig>): DownloadWorker;
  /** Moves the store's clock, which stamps cache requests as played. */
  setTime(unixSeconds: number): void;
}

async function newFixture(cacheTtlMs: number, cacheMaxBytes: number): Promise<Fixture> {
  const clock = { now: baseTimeSeconds };
  const store = new Store(join(await temporaryDirectory(), "tubestop.db"), () => clock.now);
  const config: DownloadConfig = {
    mediaDir: await temporaryDirectory(),
    cacheDir: await temporaryDirectory(),
    keepMaxHeight: 1080,
    cacheTtlMs,
    cacheMaxBytes,
  };
  const logs: string[] = [];
  return {
    store,
    config,
    logs,
    workerWith: (fetcher, overrides = {}) =>
      new DownloadWorker(store, fetcher, { ...config, ...overrides }, (message) => logs.push(message)),
    setTime: (unixSeconds) => {
      clock.now = unixSeconds;
    },
  };
}

function addVideo(store: Store, youtubeId: string): void {
  store.allowVideo({
    youtubeId,
    channelYoutubeId: "",
    channelName: "",
    title: `t ${youtubeId}`,
    duration: 0,
    publishedAt: 0,
  });
}

const neverCalled = fakeFetcher(async () => {
  throw new Error("unexpected download");
}).fetcher;

/** Adds a watchable video with a ready cache file of the given size, last played `playedAgoMs` ago. */
async function addCached(fixture: Fixture, size: number, playedAgoMs: number) {
  const id = randomVideoId();
  const path = join(fixture.config.cacheDir, `${id}.mp4`);
  await writeFile(path, size);
  addVideo(fixture.store, id);
  fixture.setTime(baseTimeSeconds - Math.round(playedAgoMs / 1000));
  fixture.store.requestCache(id);
  fixture.store.claimCache();
  fixture.store.finishCache(id, path);
  return { id, path };
}

const cacheStatus = (fixture: Fixture, id: string) => fixture.store.video(id)?.cacheStatus;
const janitorTime = baseTimeSeconds * 1000;

describe("janitor", () => {
  test("keeps recent files under the budget", async () => {
    const fixture = await newFixture(7 * day, 1 << 20);
    const { id, path } = await addCached(fixture, 100, hour);

    await fixture.workerWith(neverCalled).janitor(janitorTime);

    expect(await exists(path)).toBe(true);
    expect(cacheStatus(fixture, id)).toBe("ready");
  });

  test("evicts files not played within the TTL", async () => {
    const fixture = await newFixture(7 * day, 1 << 20);
    const stale = await addCached(fixture, 100, 8 * day);
    const fresh = await addCached(fixture, 100, 6 * day);

    await fixture.workerWith(neverCalled).janitor(janitorTime);

    expect(await exists(stale.path)).toBe(false);
    expect(cacheStatus(fixture, stale.id)).toBe("none");
    expect(await exists(fresh.path)).toBe(true);
    expect(cacheStatus(fixture, fresh.id)).toBe("ready");
  });

  test("over budget evicts the least recently played first and stops when under", async () => {
    const fixture = await newFixture(30 * day, 250);
    const oldest = await addCached(fixture, 100, 3 * hour);
    const middle = await addCached(fixture, 100, 2 * hour);
    const newest = await addCached(fixture, 100, hour);

    await fixture.workerWith(neverCalled).janitor(janitorTime);

    expect(await exists(oldest.path)).toBe(false);
    expect(cacheStatus(fixture, oldest.id)).toBe("none");
    expect(await exists(middle.path)).toBe(true);
    expect(await exists(newest.path)).toBe(true);
    expect(cacheStatus(fixture, middle.id)).toBe("ready");
    expect(cacheStatus(fixture, newest.id)).toBe("ready");
  });

  test("drops the cached copy once the video is pinned and downloaded", async () => {
    const fixture = await newFixture(7 * day, 1 << 20);
    const { id, path } = await addCached(fixture, 100, 60_000);
    fixture.store.pin(id);
    fixture.store.claimDownload();
    fixture.store.finishDownload(id, join(fixture.config.mediaDir, "kept.mp4"));

    await fixture.workerWith(neverCalled).janitor(janitorTime);

    expect(await exists(path)).toBe(false);
    expect(cacheStatus(fixture, id)).toBe("none");
  });

  test("keeps the cached copy while the pinned download is still pending", async () => {
    const fixture = await newFixture(7 * day, 1 << 20);
    const { id, path } = await addCached(fixture, 100, 60_000);
    fixture.store.pin(id);

    await fixture.workerWith(neverCalled).janitor(janitorTime);

    expect(await exists(path)).toBe(true);
    expect(cacheStatus(fixture, id)).toBe("ready");
  });

  test("forgets entries whose file has vanished", async () => {
    const fixture = await newFixture(7 * day, 1 << 20);
    const { id, path } = await addCached(fixture, 100, 60_000);
    await rm(path);

    await fixture.workerWith(neverCalled).janitor(janitorTime);

    expect(cacheStatus(fixture, id)).toBe("none");
  });
});

describe("processCache", () => {
  test("stores the file and marks the video ready", async () => {
    const fixture = await newFixture(hour, 1 << 30);
    const id = randomVideoId();
    const outputPath = join(fixture.config.cacheDir, `${id}.mp4`);
    addVideo(fixture.store, id);
    fixture.store.requestCache(id);
    const { fetcher } = writingFetcher(() => outputPath);

    const didWork = await fixture.workerWith(fetcher).processCache(neverAborted);

    const video = fixture.store.video(id);
    expect(didWork).toBe(true);
    expect(video?.cacheStatus).toBe("ready");
    expect(video?.cachePath).toBe(outputPath);
    expect(await exists(outputPath)).toBe(true);
  });

  test("records a failure so it can be retried", async () => {
    const fixture = await newFixture(hour, 1 << 30);
    const id = randomVideoId();
    addVideo(fixture.store, id);
    fixture.store.requestCache(id);

    await fixture.workerWith(failingFetcher().fetcher).processCache(neverAborted);

    const video = fixture.store.video(id);
    expect(video?.cacheStatus).toBe("failed");
    expect(video?.cacheError).toContain("boom");
  });

  test("reports no work when nothing is queued", async () => {
    const fixture = await newFixture(hour, 1 << 30);
    expect(await fixture.workerWith(neverCalled).processCache(neverAborted)).toBe(false);
  });

  test("discards the file if the video is removed during the download", async () => {
    const fixture = await newFixture(hour, 1 << 30);
    const id = randomVideoId();
    const outputPath = join(fixture.config.cacheDir, `${id}.mp4`);
    addVideo(fixture.store, id);
    fixture.store.requestCache(id);
    const { fetcher, started, release } = gatedFetcher(() => outputPath);

    const processing = fixture.workerWith(fetcher).processCache(neverAborted);
    await started;
    fixture.store.removeVideo(id);
    release();
    await processing;

    expect(await exists(outputPath)).toBe(false);
  });

  test("does not record a failure when the download was cancelled", async () => {
    const fixture = await newFixture(hour, 1 << 30);
    const id = randomVideoId();
    addVideo(fixture.store, id);
    fixture.store.requestCache(id);
    const controller = new AbortController();
    const { fetcher } = fakeFetcher(async () => {
      controller.abort();
      throw new Error("cancelled");
    });

    const keepGoing = await fixture.workerWith(fetcher).processCache(controller.signal);

    expect(keepGoing).toBe(false);
    expect(cacheStatus(fixture, id)).toBe("downloading");
  });
});

describe("processPin", () => {
  const pinnedPath = (fixture: Fixture, id: string) =>
    join(fixture.config.mediaDir, "Chan", `video [${id}].mp4`);

  test("keeps the downloaded file in the media folder", async () => {
    const fixture = await newFixture(hour, 1 << 30);
    const id = randomVideoId();
    addVideo(fixture.store, id);
    fixture.store.pin(id);
    const { fetcher } = writingFetcher(() => pinnedPath(fixture, id));

    await fixture.workerWith(fetcher).processPin(neverAborted);

    const video = fixture.store.video(id);
    expect(video?.downloadStatus).toBe("ready");
    expect(video?.filePath).toBe(pinnedPath(fixture, id));
    expect(await exists(pinnedPath(fixture, id))).toBe(true);
  });

  test("unpinned during the download discards the file", async () => {
    const fixture = await newFixture(hour, 1 << 30);
    const id = randomVideoId();
    addVideo(fixture.store, id);
    fixture.store.pin(id);
    const { fetcher, started, release } = gatedFetcher(() => pinnedPath(fixture, id));

    const processing = fixture.workerWith(fetcher).processPin(neverAborted);
    await started;
    fixture.store.unpin(id);
    release();
    await processing;

    const video = fixture.store.video(id);
    expect(await exists(pinnedPath(fixture, id))).toBe(false);
    expect(video?.pinned).toBe(false);
    expect(video?.filePath).toBe("");
    expect(video?.downloadStatus).toBe("none");
  });

  test("re-pinned during the download keeps the file", async () => {
    const fixture = await newFixture(hour, 1 << 30);
    const id = randomVideoId();
    addVideo(fixture.store, id);
    fixture.store.pin(id);
    const { fetcher, started, release } = gatedFetcher(() => pinnedPath(fixture, id));

    const processing = fixture.workerWith(fetcher).processPin(neverAborted);
    await started;
    fixture.store.unpin(id);
    fixture.store.pin(id);
    release();
    await processing;

    const video = fixture.store.video(id);
    expect(await exists(pinnedPath(fixture, id))).toBe(true);
    expect(video?.pinned).toBe(true);
    expect(video?.downloadStatus).toBe("ready");
  });

  test("records a failure without losing the pin", async () => {
    const fixture = await newFixture(hour, 1 << 30);
    const id = randomVideoId();
    addVideo(fixture.store, id);
    fixture.store.pin(id);

    await fixture.workerWith(failingFetcher().fetcher).processPin(neverAborted);

    const video = fixture.store.video(id);
    expect(video?.downloadStatus).toBe("failed");
    expect(video?.pinned).toBe(true);
    expect(video?.downloadError).toContain("boom");
  });

  test("reports no work when nothing is queued", async () => {
    const fixture = await newFixture(hour, 1 << 30);
    expect(await fixture.workerWith(neverCalled).processPin(neverAborted)).toBe(false);
  });
});

describe("with a stub yt-dlp", () => {
  test("a pinned download lands in the media folder through the real client", async () => {
    const fixture = await newFixture(hour, 1 << 30);
    const id = randomVideoId();
    const outputPath = join(fixture.config.mediaDir, "Chan", `video [${id}].mp4`);
    const stub = await writeStub(
      `mkdir -p "$(dirname '${outputPath}')"\necho data > '${outputPath}'\necho '${outputPath}'`,
    );
    await chmod(stub.binary, 0o755); // Bun.write ignores its mode option on some versions
    addVideo(fixture.store, id);
    fixture.store.pin(id);

    await fixture.workerWith(new YtDlp(stub.binary)).processPin(neverAborted);

    expect(fixture.store.video(id)?.filePath).toBe(outputPath);
    expect(await exists(outputPath)).toBe(true);
  });
});

describe("what the workers ask for", () => {
  test("pins go to the library at the keep quality and caches get a fixed 720p", async () => {
    const fixture = await newFixture(hour, 1 << 30);
    const { fetcher, calls } = failingFetcher();
    const [pinned, watched] = [randomVideoId(), randomVideoId()];
    addVideo(fixture.store, pinned);
    addVideo(fixture.store, watched);
    fixture.store.pin(pinned);
    fixture.store.requestCache(watched);
    const worker = fixture.workerWith(fetcher, { keepMaxHeight: 1440 });

    await worker.processPin(neverAborted);
    await worker.processCache(neverAborted);

    expect(calls).toEqual([
      { kind: "library", id: pinned, directory: fixture.config.mediaDir, maxHeight: 1440 },
      { kind: "cache", id: watched, directory: fixture.config.cacheDir, maxHeight: 720 },
    ]);
  });
});

describe("run", () => {
  test("stops promptly when the signal is aborted", async () => {
    const fixture = await newFixture(hour, 1 << 30);
    const controller = new AbortController();

    const running = fixture.workerWith(neverCalled).run(controller.signal);
    await Bun.sleep(50);
    controller.abort();

    await running;
  });

  test("requeues downloads interrupted by a restart", async () => {
    const fixture = await newFixture(hour, 1 << 30);
    const id = randomVideoId();
    addVideo(fixture.store, id);
    fixture.store.pin(id);
    fixture.store.claimDownload(); // "downloading" when the previous process died
    const fetched = Promise.withResolvers<void>();
    const { fetcher } = fakeFetcher(async () => {
      fetched.resolve();
      throw new Error("stop here");
    });
    const controller = new AbortController();

    const running = fixture.workerWith(fetcher).run(controller.signal);
    await fetched.promise;
    controller.abort();

    await running;
  });
});
