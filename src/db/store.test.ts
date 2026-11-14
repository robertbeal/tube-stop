import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { randomVideoId, temporaryDirectory } from "../test-helpers.ts";
import { NotFoundError, Store } from "./store.ts";
import {
  cacheFile,
  channelIdOf,
  everything,
  fixedNow,
  idsOf,
  keepFile,
  newVideo,
  openTestDatabase,
  videoOf,
} from "./support.ts";

function userVersion(path: string): number {
  const raw = new Database(path, { readonly: true });
  const row = raw.query<{ user_version: number }, []>("PRAGMA user_version").get();
  raw.close();
  return row?.user_version ?? 0;
}

describe("schema versioning", () => {
  test("a new database is stamped with the schema version", async () => {
    const { path } = await openTestDatabase();
    expect(userVersion(path)).toBe(1);
  });

  test("reopening keeps data and version", async () => {
    const path = join(await temporaryDirectory(), "test.db");
    const first = new Store(path);
    const video = newVideo("chan");
    first.allowVideo(video);
    first.close();

    const reopened = new Store(path);
    expect(videoOf(reopened, video.youtubeId).title).toBe(video.title);
    expect(userVersion(path)).toBe(1);
  });

  test("an in-memory store works", () => {
    const store = new Store(":memory:");
    store.allowVideo(newVideo("chan"));
    expect(store.userCount()).toBe(0);
  });

  test("a database from a newer build is refused", async () => {
    const path = join(await temporaryDirectory(), "future.db");
    const raw = new Database(path, { create: true });
    raw.run("PRAGMA user_version = 9999");
    raw.close();
    expect(() => new Store(path)).toThrow("newer");
  });
});

describe("what the child may watch", () => {
  test("a video from an allowed channel is visible", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    store.addChannel(channel, "Piano");
    const video = newVideo(channel);
    store.insertSynced(video);
    expect(idsOf(store.watchable("", everything).videos)).toContain(video.youtubeId);
  });

  test("a video from an unlisted channel is hidden", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.insertSynced(video);
    expect(videoOf(store, video.youtubeId).watchable).toBe(false);
  });

  test("an individually allowed video needs no channel", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    expect(videoOf(store, video.youtubeId).watchable).toBe(true);
  });

  test("a blocked video is hidden even in an allowed channel", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    store.addChannel(channel, "Piano");
    const video = newVideo(channel);
    store.insertSynced(video);
    store.block(video.youtubeId);
    expect(videoOf(store, video.youtubeId).watchable).toBe(false);
  });

  test("blocking an unknown video reports not found", async () => {
    const { store } = await openTestDatabase();
    expect(() => store.block(randomVideoId())).toThrow(NotFoundError);
  });

  test("removing a channel hides its inherited videos", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    store.addChannel(channel, "Piano");
    const video = newVideo(channel);
    store.insertSynced(video);
    store.removeChannel(channelIdOf(store, channel));
    expect(videoOf(store, video.youtubeId).watchable).toBe(false);
  });

  test("removing a channel keeps individually allowed videos", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    store.addChannel(channel, "Piano");
    const video = newVideo(channel);
    store.allowVideo(video);
    store.removeChannel(channelIdOf(store, channel));
    expect(videoOf(store, video.youtubeId).watchable).toBe(true);
  });

  test("watchable videos can be filtered by channel", async () => {
    const { store } = await openTestDatabase();
    const [channelA, channelB] = [randomVideoId(), randomVideoId()];
    store.addChannel(channelA, "A");
    store.addChannel(channelB, "B");
    const videoA = newVideo(channelA);
    store.insertSynced(videoA);
    store.insertSynced(newVideo(channelB));
    expect(idsOf(store.watchable(channelA, everything).videos)).toEqual([videoA.youtubeId]);
  });

  test("syncing again does not overwrite an explicit decision", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    store.addChannel(channel, "Piano");
    const video = newVideo(channel);
    store.insertSynced(video);
    store.block(video.youtubeId);
    store.insertSynced(video);
    expect(videoOf(store, video.youtubeId).rule).toBe("block");
  });

  test("unblocking returns to the channel rule when the channel is allowed", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    store.addChannel(channel, "Piano");
    const video = newVideo(channel);
    store.insertSynced(video);
    store.block(video.youtubeId);
    store.unblock(video.youtubeId);
    const unblocked = videoOf(store, video.youtubeId);
    expect([unblocked.rule, unblocked.watchable]).toEqual(["inherit", true]);
  });

  test("unblocking keeps the video visible when its channel is not allowed", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.block(video.youtubeId);
    store.unblock(video.youtubeId);
    const unblocked = videoOf(store, video.youtubeId);
    expect([unblocked.rule, unblocked.watchable]).toEqual(["allow", true]);
  });

  test("watchable channels lists only channels with visible videos", async () => {
    const { store } = await openTestDatabase();
    const [withVideo, empty] = [randomVideoId(), randomVideoId()];
    store.addChannel(withVideo, "Has videos");
    store.addChannel(empty, "No videos");
    store.insertSynced(newVideo(withVideo));
    expect(store.watchableChannels()).toEqual([{ youtubeId: withVideo, name: `Channel ${withVideo}` }]);
  });

  test("an unknown video is null", async () => {
    const { store } = await openTestDatabase();
    expect(store.video(randomVideoId())).toBeNull();
  });
});

describe("channels", () => {
  test("adding an existing channel renames it", async () => {
    const { store } = await openTestDatabase();
    store.addChannel("chan", "Old");
    store.addChannel("chan", "New");
    expect(store.channels().map((channel) => channel.name)).toEqual(["New"]);
  });

  test("channels are listed by name ignoring case, with their non-blocked video count", async () => {
    const { store } = await openTestDatabase();
    store.addChannel("b", "banana");
    store.addChannel("a", "Cherry");
    store.addChannel("c", "apple");
    const [first, second] = [newVideo("b"), newVideo("b")];
    store.insertSynced(first);
    store.insertSynced(second);
    store.block(second.youtubeId);
    const channels = store.channels();
    expect(channels.map((channel) => [channel.name, channel.videoCount])).toEqual([
      ["apple", 0],
      ["banana", 1],
      ["Cherry", 0],
    ]);
  });

  test("marking a channel synced stamps the current time", async () => {
    const { store } = await openTestDatabase();
    store.addChannel("chan", "Piano");
    expect(store.channels()[0]?.lastSyncedAt).toBe(0);
    store.markSynced("chan");
    expect(store.channels()[0]?.lastSyncedAt).toBe(fixedNow);
  });
});

describe("recording plays", () => {
  test("plays are counted and the time is stamped", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.recordPlay(video.youtubeId);
    store.recordPlay(video.youtubeId);
    const played = videoOf(store, video.youtubeId);
    expect([played.playCount, played.lastPlayedAt]).toEqual([2, fixedNow]);
  });
});

describe("pinning", () => {
  test("pinning queues a download for a video without a file", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.pin(video.youtubeId);
    const pinned = videoOf(store, video.youtubeId);
    expect([pinned.pinned, pinned.downloadStatus]).toEqual([true, "queued"]);
  });

  test("pinning a downloaded video leaves it ready", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    keepFile(store, video.youtubeId, "/media/x.mp4");
    store.pin(video.youtubeId);
    expect(videoOf(store, video.youtubeId).downloadStatus).toBe("ready");
  });

  test("pinning a video that is downloading leaves it downloading", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.pin(video.youtubeId);
    store.claimDownload();
    store.pin(video.youtubeId);
    expect(videoOf(store, video.youtubeId).downloadStatus).toBe("downloading");
  });

  test("pinning an unknown video reports not found", async () => {
    const { store } = await openTestDatabase();
    expect(() => store.pin(randomVideoId())).toThrow(NotFoundError);
  });

  test("unpinning returns the file path and clears the state", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    keepFile(store, video.youtubeId, "/media/chan/video.mp4");
    const path = store.unpin(video.youtubeId);
    const unpinned = videoOf(store, video.youtubeId);
    expect([path, unpinned.pinned, unpinned.filePath, unpinned.downloadStatus]).toEqual([
      "/media/chan/video.mp4",
      false,
      "",
      "none",
    ]);
  });

  test("unpinning while downloading stops keeping the video", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.pin(video.youtubeId);
    store.claimDownload();
    store.unpin(video.youtubeId);
    const unpinned = videoOf(store, video.youtubeId);
    expect([unpinned.pinned, unpinned.downloadStatus]).toEqual([false, "downloading"]);
  });

  test("unpinning an unknown video reports not found", async () => {
    const { store } = await openTestDatabase();
    expect(() => store.unpin(randomVideoId())).toThrow(NotFoundError);
  });

  test("finishing a download discards the file when unpinned mid-download", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.pin(video.youtubeId);
    store.claimDownload();
    store.unpin(video.youtubeId);
    const kept = store.finishDownload(video.youtubeId, "/media/late.mp4");
    const finished = videoOf(store, video.youtubeId);
    expect([kept, finished.filePath, finished.downloadStatus]).toEqual([false, "", "none"]);
  });

  test("finishing a download discards the file when the video was removed", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.pin(video.youtubeId);
    store.claimDownload();
    store.removeVideo(video.youtubeId);
    expect(store.finishDownload(video.youtubeId, "/media/late.mp4")).toBe(false);
  });

  test("finishing a download keeps the file when still pinned", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.pin(video.youtubeId);
    store.claimDownload();
    const kept = store.finishDownload(video.youtubeId, "/media/ok.mp4");
    const finished = videoOf(store, video.youtubeId);
    expect([kept, finished.filePath, finished.downloadStatus]).toEqual([true, "/media/ok.mp4", "ready"]);
  });
});

describe("download queue", () => {
  test("claiming only takes pinned queued videos, each once", async () => {
    const { store } = await openTestDatabase();
    const [plain, pinned] = [newVideo(randomVideoId()), newVideo(randomVideoId())];
    store.allowVideo(plain);
    store.allowVideo(pinned);
    store.pin(pinned.youtubeId);
    expect(store.claimDownload()).toBe(pinned.youtubeId);
    expect(store.claimDownload()).toBeNull();
  });

  test("queued videos are claimed oldest first, each exactly once", async () => {
    const { store } = await openTestDatabase();
    const videos = Array.from({ length: 12 }, () => newVideo(randomVideoId()));
    videos.forEach((video) => {
      store.allowVideo(video);
      store.pin(video.youtubeId);
    });
    const claimed = videos.map(() => store.claimDownload());
    expect(claimed).toEqual(idsOf(videos));
    expect(store.claimDownload()).toBeNull();
  });

  test("resetting requeues interrupted downloads and cache copies", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.pin(video.youtubeId);
    store.claimDownload();
    store.requestCache(video.youtubeId);
    store.claimCache();
    store.resetDownloading();
    const reset = videoOf(store, video.youtubeId);
    expect([reset.downloadStatus, reset.cacheStatus]).toEqual(["queued", "queued"]);
  });

  test("a failed download records its error and retrying requeues it", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.pin(video.youtubeId);
    store.claimDownload();
    store.failDownload(video.youtubeId, "boom");
    const failed = videoOf(store, video.youtubeId);
    expect([failed.downloadStatus, failed.downloadError]).toEqual(["failed", "boom"]);

    store.pin(video.youtubeId);
    const retried = videoOf(store, video.youtubeId);
    expect([retried.downloadStatus, retried.downloadError]).toEqual(["queued", ""]);
  });
});

describe("watch-once cache", () => {
  test("requesting queues only when nothing is in progress", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.requestCache(video.youtubeId);
    expect(videoOf(store, video.youtubeId).cacheStatus).toBe("queued");
    store.claimCache();
    store.requestCache(video.youtubeId);
    expect(videoOf(store, video.youtubeId).cacheStatus).toBe("downloading");
  });

  test("requesting retries after a failure", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.requestCache(video.youtubeId);
    store.claimCache();
    store.failCache(video.youtubeId, "network");
    expect(videoOf(store, video.youtubeId).cacheError).toBe("network");
    store.requestCache(video.youtubeId);
    const retried = videoOf(store, video.youtubeId);
    expect([retried.cacheStatus, retried.cacheError]).toEqual(["queued", ""]);
  });

  test("requesting stamps the video as just used without counting a play", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.requestCache(video.youtubeId);
    const requested = videoOf(store, video.youtubeId);
    expect([requested.lastPlayedAt, requested.playCount]).toEqual([fixedNow, 0]);
  });

  test("claiming serves the most recently played first", async () => {
    const { store, raw } = await openTestDatabase();
    const [older, newer] = [newVideo(randomVideoId()), newVideo(randomVideoId())];
    store.allowVideo(older);
    store.allowVideo(newer);
    store.requestCache(older.youtubeId);
    store.requestCache(newer.youtubeId);
    raw.query("UPDATE videos SET last_played_at = 100 WHERE youtube_id = ?").run(older.youtubeId);
    raw.query("UPDATE videos SET last_played_at = 200 WHERE youtube_id = ?").run(newer.youtubeId);
    expect(store.claimCache()).toBe(newer.youtubeId);
    expect(store.claimCache()).toBe(older.youtubeId);
    expect(store.claimCache()).toBeNull();
  });

  test("finishing discards the file when the video was removed", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.requestCache(video.youtubeId);
    store.claimCache();
    store.removeVideo(video.youtubeId);
    expect(store.finishCache(video.youtubeId, "/cache/late.mp4")).toBe(false);
  });

  test("finishing discards the file for a video blocked meanwhile", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.requestCache(video.youtubeId);
    store.claimCache();
    store.block(video.youtubeId);
    const stored = store.finishCache(video.youtubeId, "/cache/late.mp4");
    const finished = videoOf(store, video.youtubeId);
    expect([stored, finished.cacheStatus, finished.cachePath]).toEqual([false, "none", ""]);
  });

  test("finishing stores the file for a watchable video", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.requestCache(video.youtubeId);
    store.claimCache();
    expect(store.finishCache(video.youtubeId, "/cache/ok.mp4")).toBe(true);
    const finished = videoOf(store, video.youtubeId);
    expect([finished.cacheStatus, finished.cachePath]).toEqual(["ready", "/cache/ok.mp4"]);
  });

  test("cache entries list ready files least recently played first", async () => {
    const { store, raw } = await openTestDatabase();
    const [firstVideo, secondVideo, notReady] = [
      newVideo(randomVideoId()),
      newVideo(randomVideoId()),
      newVideo(randomVideoId()),
    ];
    [firstVideo, secondVideo, notReady].forEach((video) => {
      store.allowVideo(video);
    });
    [firstVideo, secondVideo].forEach((video) => {
      cacheFile(store, video.youtubeId, `/cache/${video.youtubeId}.mp4`);
    });
    [firstVideo, secondVideo, notReady].forEach((video, index) => {
      raw
        .query("UPDATE videos SET last_played_at = ? WHERE youtube_id = ?")
        .run(100 * (3 - index), video.youtubeId);
    });
    expect(idsOf(store.cacheEntries())).toEqual([secondVideo.youtubeId, firstVideo.youtubeId]);
  });

  test("clearing forgets the cached file", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    cacheFile(store, video.youtubeId, "/cache/x.mp4");
    store.clearCache(video.youtubeId);
    const cleared = videoOf(store, video.youtubeId);
    expect([cleared.cacheStatus, cleared.cachePath]).toEqual(["none", ""]);
  });
});

describe("schema constraints", () => {
  test("every status and rule is accepted", async () => {
    const { raw } = await openTestDatabase();
    const statuses = ["none", "queued", "downloading", "ready", "failed"];
    const rules = ["allow", "block", "inherit"];
    statuses.forEach((status) => {
      raw
        .query("INSERT INTO videos (youtube_id, title, download_status, cache_status) VALUES (?, 't', ?, ?)")
        .run(randomVideoId(), status, status);
    });
    rules.forEach((rule) => {
      raw.query("INSERT INTO videos (youtube_id, title, rule) VALUES (?, 't', ?)").run(randomVideoId(), rule);
    });
    expect(raw.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM videos").get()?.total).toBe(8);
  });

  test("an unknown status is rejected", async () => {
    const { raw } = await openTestDatabase();
    expect(() =>
      raw
        .query("INSERT INTO videos (youtube_id, title, download_status) VALUES (?, 't', 'bogus')")
        .run(randomVideoId()),
    ).toThrow();
  });

  test("an unknown rule is rejected", async () => {
    const { raw } = await openTestDatabase();
    expect(() =>
      raw.query("INSERT INTO videos (youtube_id, title, rule) VALUES (?, 't', 'bogus')").run(randomVideoId()),
    ).toThrow();
  });
});

describe("removing a video", () => {
  function allowedChannelVideo(store: Store) {
    const channel = randomVideoId();
    store.addChannel(channel, "Piano Guy");
    const video = newVideo(channel);
    store.insertSynced(video);
    keepFile(store, video.youtubeId, "/media/kept.mp4");
    cacheFile(store, video.youtubeId, "/cache/copy.mp4");
    return video;
  }

  test("removing returns both paths for cleanup", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    keepFile(store, video.youtubeId, "/media/a.mp4");
    cacheFile(store, video.youtubeId, "/cache/a.mp4");
    expect(store.removeVideo(video.youtubeId)).toMatchObject({
      filePath: "/media/a.mp4",
      cachePath: "/cache/a.mp4",
    });
  });

  test("removing an unknown video reports not found", async () => {
    const { store } = await openTestDatabase();
    expect(() => store.removeVideo(randomVideoId())).toThrow(NotFoundError);
  });

  test("removing a video of an allowed channel blocks it instead of deleting", async () => {
    const { store } = await openTestDatabase();
    const video = allowedChannelVideo(store);
    const removal = store.removeVideo(video.youtubeId);
    expect(removal).toEqual({ filePath: "/media/kept.mp4", cachePath: "/cache/copy.mp4", blocked: true });
    expect(videoOf(store, video.youtubeId)).toMatchObject({
      rule: "block",
      watchable: false,
      pinned: false,
      filePath: "",
      cachePath: "",
      downloadStatus: "none",
      cacheStatus: "none",
    });
  });

  test("a removed video stays hidden when the channel syncs again", async () => {
    const { store } = await openTestDatabase();
    const video = allowedChannelVideo(store);
    store.removeVideo(video.youtubeId);
    store.insertSynced(video);
    expect(videoOf(store, video.youtubeId)).toMatchObject({ rule: "block", watchable: false });
  });

  test("removing an individually allowed video in an allowed channel still hides it", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    store.addChannel(channel, "Piano Guy");
    const video = newVideo(channel);
    store.allowVideo(video);
    store.removeVideo(video.youtubeId);
    expect(videoOf(store, video.youtubeId).watchable).toBe(false);
  });

  test("removing a video outside any allowed channel deletes it", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    expect(store.removeVideo(video.youtubeId).blocked).toBe(false);
    expect(store.video(video.youtubeId)).toBeNull();
  });

  test("removing while downloading deletes a video outside any allowed channel", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.pin(video.youtubeId);
    store.claimDownload();
    store.removeVideo(video.youtubeId);
    expect(store.video(video.youtubeId)).toBeNull();
  });

  test("removing leaves an in-flight download for the worker to discard", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    store.addChannel(channel, "Piano Guy");
    const video = newVideo(channel);
    store.insertSynced(video);
    store.pin(video.youtubeId);
    store.claimDownload();
    store.removeVideo(video.youtubeId);
    expect(videoOf(store, video.youtubeId)).toMatchObject({ pinned: false, downloadStatus: "downloading" });
    expect(store.finishDownload(video.youtubeId, "/media/late.mp4")).toBe(false);
  });
});

describe("removing a channel", () => {
  test("returns and clears the cache of its inherited videos only", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    store.addChannel(channel, "Piano Guy");
    const [inherited, individual] = [newVideo(channel), newVideo(channel)];
    store.insertSynced(inherited);
    store.allowVideo(individual);
    [inherited, individual].forEach((video) => {
      cacheFile(store, video.youtubeId, `/cache/${video.youtubeId}.mp4`);
    });

    const paths = store.removeChannel(channelIdOf(store, channel));

    expect(paths).toEqual([`/cache/${inherited.youtubeId}.mp4`]);
    expect(videoOf(store, inherited.youtubeId)).toMatchObject({ cacheStatus: "none", cachePath: "" });
    expect(videoOf(store, individual.youtubeId)).toMatchObject({ cacheStatus: "ready", watchable: true });
  });

  test("keeps pinned files", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    store.addChannel(channel, "Piano Guy");
    const video = newVideo(channel);
    store.insertSynced(video);
    keepFile(store, video.youtubeId, "/media/kept.mp4");
    store.removeChannel(channelIdOf(store, channel));
    expect(videoOf(store, video.youtubeId)).toMatchObject({
      pinned: true,
      filePath: "/media/kept.mp4",
      downloadStatus: "ready",
    });
  });

  test("discards a cache download that finishes afterwards", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    store.addChannel(channel, "Piano Guy");
    const video = newVideo(channel);
    store.insertSynced(video);
    store.requestCache(video.youtubeId);
    store.claimCache();
    store.removeChannel(channelIdOf(store, channel));
    expect(store.finishCache(video.youtubeId, "/cache/late.mp4")).toBe(false);
  });

  test("an unknown channel reports not found", async () => {
    const { store } = await openTestDatabase();
    expect(() => store.removeChannel(424242)).toThrow(NotFoundError);
  });
});

describe("paging and ordering", () => {
  function addNumberedVideos(store: Store, channel: string, count: number) {
    store.addChannel(channel, "Channel");
    return Array.from({ length: count }, (_, index) => {
      const video = newVideo(channel, { publishedAt: 1_000_001 + index });
      store.insertSynced(video);
      return video;
    });
  }

  test("watchable returns the requested page and the total", async () => {
    const { store } = await openTestDatabase();
    const videos = addNumberedVideos(store, randomVideoId(), 10);
    const page = store.watchable("", { limit: 4, offset: 4 });
    expect(page.total).toBe(10);
    expect(idsOf(page.videos)).toEqual([5, 4, 3, 2].map((index) => videos[index]?.youtubeId ?? "missing"));
  });

  test("a page beyond the end is empty but the total is reported", async () => {
    const { store } = await openTestDatabase();
    addNumberedVideos(store, randomVideoId(), 3);
    expect(store.watchable("", { limit: 10, offset: 50 })).toEqual({ videos: [], total: 3 });
  });

  test("the total respects the channel filter", async () => {
    const { store } = await openTestDatabase();
    const channelB = randomVideoId();
    addNumberedVideos(store, randomVideoId(), 5);
    addNumberedVideos(store, channelB, 2);
    expect(store.watchable(channelB, { limit: 10, offset: 0 }).total).toBe(2);
  });

  test("videos are ordered by publish date, not by when they were synced", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    store.addChannel(channel, "Channel");
    const synced = [300, 900, 600].map((publishedAt) => newVideo(channel, { publishedAt }));
    synced.forEach((video) => {
      store.insertSynced(video);
    });
    const [oldest, newest, middle] = synced.map((video) => video.youtubeId);
    expect([oldest, newest, middle]).not.toContain(undefined);
    expect(idsOf(store.watchable("", everything).videos)).toEqual([
      newest as string,
      middle as string,
      oldest as string,
    ]);
  });

  test("videos without a date follow dated ones, latest synced first", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    store.addChannel(channel, "Channel");
    const [undatedFirst, dated, undatedSecond] = [
      newVideo(channel),
      newVideo(channel, { publishedAt: 500 }),
      newVideo(channel),
    ];
    [undatedFirst, dated, undatedSecond].forEach((video) => {
      store.insertSynced(video);
    });
    expect(idsOf(store.watchable("", everything).videos)).toEqual([
      dated.youtubeId,
      undatedSecond.youtubeId,
      undatedFirst.youtubeId,
    ]);
  });

  test("admin videos page and count the listed videos", async () => {
    const { store } = await openTestDatabase();
    Array.from({ length: 7 }, () => newVideo(randomVideoId())).forEach((video) => {
      store.allowVideo(video);
    });
    store.insertSynced(newVideo(randomVideoId()));
    const page = store.adminVideos("", { limit: 5, offset: 5 });
    expect([page.videos.length, page.total]).toEqual([2, 7]);
  });

  test("admin videos for a channel list every video of that channel", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    const synced = newVideo(channel);
    store.insertSynced(synced);
    store.insertSynced(newVideo(randomVideoId()));
    expect(idsOf(store.adminVideos(channel, everything).videos)).toEqual([synced.youtubeId]);
  });

  test("admin videos include pinned and downloading videos", async () => {
    const { store } = await openTestDatabase();
    const synced = newVideo(randomVideoId());
    store.insertSynced(synced);
    store.pin(synced.youtubeId);
    expect(idsOf(store.adminVideos("", everything).videos)).toEqual([synced.youtubeId]);
  });
});

describe("publish dates", () => {
  test("syncing fills in a missing publish date without changing the rule", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    store.addChannel(channel, "Channel");
    const video = newVideo(channel);
    store.insertSynced(video);
    store.block(video.youtubeId);
    store.insertSynced({ ...video, publishedAt: 1234 });
    expect(videoOf(store, video.youtubeId)).toMatchObject({ publishedAt: 1234, rule: "block" });
  });

  test("syncing never replaces a known date with an unknown one", async () => {
    const { store } = await openTestDatabase();
    const channel = randomVideoId();
    store.addChannel(channel, "Channel");
    const video = newVideo(channel, { publishedAt: 777 });
    store.insertSynced(video);
    store.insertSynced({ ...video, publishedAt: 0 });
    expect(videoOf(store, video.youtubeId).publishedAt).toBe(777);
  });

  test("allowing keeps a known publish date when the new one is unknown", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId(), { publishedAt: 555 });
    store.allowVideo(video);
    store.allowVideo({ ...video, publishedAt: 0 });
    expect(videoOf(store, video.youtubeId).publishedAt).toBe(555);
  });

  test("allowing an already synced video makes it explicitly allowed", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.insertSynced(video);
    store.allowVideo({ ...video, title: "Renamed" });
    expect(videoOf(store, video.youtubeId)).toMatchObject({ rule: "allow", title: "Renamed" });
  });
});
