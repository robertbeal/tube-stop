import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  blockVideo,
  claimCache,
  claimDownload,
  closeStore,
  failCache,
  finishDownload,
  pinVideo,
  requestCache,
} from "../db/store.ts";
import { testVideoId } from "../test-helpers.ts";
import type { VideoId } from "../ytdlp/types.ts";
import { allow, buildEnvironment, logIn, send } from "./harness.ts";
import {
  addPublished,
  allowPianoVideo,
  cardCount,
  loadVideo,
  makeCacheReady,
  makePinnedFile,
  numberedId,
  unknownVideoId,
  videoId,
  writeFileWithFolders,
} from "./kid-helpers.ts";

async function environmentWithSong() {
  const environment = await buildEnvironment();
  allowPianoVideo(environment, videoId, "Song");
  return environment;
}

async function environmentWithBlockedSong() {
  const environment = await environmentWithSong();
  blockVideo(environment.store, videoId);
  return environment;
}

describe("ids that are not YouTube video ids", () => {
  const notVideoIds = ["short", "abcdefghijkl", "..%2F..%2Fetc%2Fpasswd", "a%2Fb%3Fc", "abcdefghij%20"];

  test.each(notVideoIds)("%s is not found on any video page", async (id) => {
    const environment = await buildEnvironment();
    for (const path of [`/watch/${id}`, `/video/${id}`, `/status/${id}`, `/thumb/${id}`]) {
      expect((await send(environment, path)).status).toBe(404);
    }
    for (const path of [`/api/videos/${id}/prepare`, `/api/videos/${id}/played`]) {
      expect((await send(environment, path, { method: "POST" })).status).toBe(404);
    }
  });
});

describe("browsing", () => {
  test("the index lists allowed videos and hides blocked ones", async () => {
    const environment = await buildEnvironment();
    allowPianoVideo(environment, testVideoId("aaaaaaaaaaa"), "Twinkle Twinkle");
    allowPianoVideo(environment, testVideoId("bbbbbbbbbbb"), "Scary Video");
    blockVideo(environment.store, testVideoId("bbbbbbbbbbb"));

    const response = await send(environment, "/");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Twinkle Twinkle");
    expect(body).not.toContain("Scary Video");
  });

  test("the channel filter shows only that channel", async () => {
    const environment = await buildEnvironment();
    allow(environment, {
      youtubeId: testVideoId("aaaaaaaaaaa"),
      title: "From A",
      channelYoutubeId: "UCa",
      channelName: "A",
    });
    allow(environment, {
      youtubeId: testVideoId("bbbbbbbbbbb"),
      title: "From B",
      channelYoutubeId: "UCb",
      channelName: "B",
    });

    const body = await (await send(environment, "/?channel=UCa")).text();

    expect(body).toContain("From A");
    expect(body).not.toContain("From B");
  });

  test("the index never shows admin controls", async () => {
    const environment = await environmentWithSong();
    const body = await (await send(environment, "/")).text();
    for (const adminControl of ["/admin", "Pin", "Block"]) {
      expect(body).not.toContain(adminControl);
    }
  });

  test("an unknown route is not found", async () => {
    const environment = await buildEnvironment();
    expect((await send(environment, "/nothing-here")).status).toBe(404);
  });
});

describe("watching", () => {
  test("an unknown or blocked video is not found", async () => {
    const environment = await environmentWithBlockedSong();
    for (const id of [videoId, unknownVideoId]) {
      expect((await send(environment, `/watch/${id}`)).status).toBe(404);
    }
  });

  test("an uncached video shows getting ready", async () => {
    const environment = await environmentWithSong();
    const response = await send(environment, `/watch/${videoId}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Getting this video ready");
  });

  test("a ready video plays immediately", async () => {
    const environment = await environmentWithSong();
    await makeCacheReady(environment, videoId, "data");

    const body = await (await send(environment, `/watch/${videoId}`)).text();

    expect(body).toContain(`src="/video/${videoId}"`);
    expect(body).toContain("autoplay");
    expect(body).toContain("hidden");
  });

  test("safe requests never change state", async () => {
    const environment = await environmentWithSong();
    const paths = ["/", `/watch/${videoId}`, `/status/${videoId}`, `/video/${videoId}`];

    for (const path of [...paths, ...paths]) {
      await send(environment, path);
    }

    const video = loadVideo(environment, videoId);
    expect(video.playCount).toBe(0);
    expect(video.cacheStatus).toBe("none");
    expect(video.lastPlayedAt).toBe(0);
  });
});

describe("prepare and played", () => {
  const prepare = (id: VideoId) => `/api/videos/${id}/prepare`;
  const played = (id: VideoId) => `/api/videos/${id}/played`;

  test("prepare queues a watch-once download", async () => {
    const environment = await environmentWithSong();

    const response = await send(environment, prepare(videoId), { method: "POST" });

    expect(response.status).toBe(202);
    expect(loadVideo(environment, videoId).cacheStatus).toBe("queued");
  });

  test("prepare does nothing when a file is already ready", async () => {
    const environment = await environmentWithSong();
    await makeCacheReady(environment, videoId, "data");

    const response = await send(environment, prepare(videoId), { method: "POST" });

    expect(response.status).toBe(202);
    expect(loadVideo(environment, videoId).cacheStatus).toBe("ready");
  });

  test("prepare retries a failed download", async () => {
    const environment = await environmentWithSong();
    requestCache(environment.store, videoId);
    claimCache(environment.store);
    failCache(environment.store, videoId, "network");

    await send(environment, prepare(videoId), { method: "POST" });

    const video = loadVideo(environment, videoId);
    expect(video.cacheStatus).toBe("queued");
    expect(video.cacheError).toBe("");
  });

  test("prepare and played refuse blocked and unknown videos", async () => {
    const environment = await environmentWithBlockedSong();

    for (const id of [videoId, unknownVideoId]) {
      expect((await send(environment, prepare(id), { method: "POST" })).status).toBe(404);
      expect((await send(environment, played(id), { method: "POST" })).status).toBe(404);
    }

    const video = loadVideo(environment, videoId);
    expect(video.cacheStatus).toBe("none");
    expect(video.playCount).toBe(0);
  });

  test("played counts each reported play", async () => {
    const environment = await environmentWithSong();

    const response = await send(environment, played(videoId), { method: "POST" });
    await send(environment, played(videoId), { method: "POST" });

    const video = loadVideo(environment, videoId);
    expect(response.status).toBe(204);
    expect(video.playCount).toBe(2);
    expect(video.lastPlayedAt).toBeGreaterThan(0);
  });

  test("prepare and played are not available as GET", async () => {
    const environment = await environmentWithSong();
    for (const path of [prepare(videoId), played(videoId)]) {
      expect((await send(environment, path)).status).toBe(404);
    }
  });

  test("prepare and played reject cross-site posts", async () => {
    const environment = await environmentWithSong();

    const response = await send(environment, played(videoId), {
      method: "POST",
      headers: { "Sec-Fetch-Site": "cross-site" },
    });

    expect(response.status).toBe(403);
    expect(loadVideo(environment, videoId).playCount).toBe(0);
  });

  test("a post from a page on another origin is rejected", async () => {
    const environment = await environmentWithSong();

    const response = await send(environment, played(videoId), {
      method: "POST",
      headers: { Origin: "https://evil.example", Host: "tubestop.home" },
    });

    expect(response.status).toBe(403);
  });
});

describe("status", () => {
  test("reports readiness as JSON", async () => {
    const environment = await environmentWithSong();

    const before = await send(environment, `/status/${videoId}`);
    expect(await before.json()).toEqual({ ready: false, failed: false });
    expect(before.headers.get("content-type")).toStartWith("application/json");

    await makeCacheReady(environment, videoId, "data");
    const after = await send(environment, `/status/${videoId}`);
    expect(await after.json()).toEqual({ ready: true, failed: false });
  });

  test("reports a failed download", async () => {
    const environment = await environmentWithSong();
    requestCache(environment.store, videoId);
    claimCache(environment.store);
    failCache(environment.store, videoId, "network");

    expect(await (await send(environment, `/status/${videoId}`)).json()).toEqual({
      ready: false,
      failed: true,
    });
  });

  test("an unknown video is not found", async () => {
    const environment = await buildEnvironment();
    expect((await send(environment, `/status/${unknownVideoId}`)).status).toBe(404);
  });
});

describe("video bytes", () => {
  test("serves the file with range support so seeking works", async () => {
    const environment = await environmentWithSong();
    await makeCacheReady(environment, videoId, "0123456789");

    const response = await send(environment, `/video/${videoId}`, { headers: { Range: "bytes=2-5" } });

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("2345");
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
  });

  test("prefers the pinned file over the cached copy", async () => {
    const environment = await environmentWithSong();
    await makeCacheReady(environment, videoId, "cached");
    await makePinnedFile(environment, videoId, join(environment.mediaDir, "pinned.mp4"), "pinned");

    expect(await (await send(environment, `/video/${videoId}`)).text()).toBe("pinned");
  });

  test("falls back to the cache when the pinned file went missing", async () => {
    const environment = await environmentWithSong();
    await makeCacheReady(environment, videoId, "cached");
    pinVideo(environment.store, videoId);
    claimDownload(environment.store);
    finishDownload(environment.store, videoId, join(environment.mediaDir, "deleted-by-hand.mp4"));

    expect(await (await send(environment, `/video/${videoId}`)).text()).toBe("cached");
  });

  test("a video that is not ready returns service unavailable", async () => {
    const environment = await environmentWithSong();
    expect((await send(environment, `/video/${videoId}`)).status).toBe(503);
  });

  test("a blocked or unknown video is never served", async () => {
    const environment = await environmentWithSong();
    await makeCacheReady(environment, videoId, "secret bytes");
    blockVideo(environment.store, videoId);

    for (const id of [videoId, unknownVideoId]) {
      const response = await send(environment, `/video/${id}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("secret");
    }
  });
});

describe("paging", () => {
  test("the index shows twenty-four videos at a time with a more videos link", async () => {
    const environment = await buildEnvironment();
    addPublished(environment, 30);

    const body = await (await send(environment, "/")).text();

    expect(cardCount(body)).toBe(24);
    expect(body).toContain('href="/?page=2"');
    expect(body).toContain("More videos");
    expect(body).not.toContain("Newer videos");
  });

  test("the second page has the rest and a link back", async () => {
    const environment = await buildEnvironment();
    addPublished(environment, 30);

    const body = await (await send(environment, "/?page=2")).text();

    expect(cardCount(body)).toBe(6);
    expect(body).toContain('href="/"');
    expect(body).toContain("Newer videos");
    expect(body).not.toContain("More videos");
  });

  test("videos are shown newest published first across pages", async () => {
    const environment = await buildEnvironment();
    addPublished(environment, 30);

    const first = await (await send(environment, "/")).text();
    const last = await (await send(environment, "/?page=2")).text();

    expect(first).toContain("Song 030");
    expect(first).not.toContain("Song 006");
    expect(last).toContain("Song 006");
    expect(last).toContain("Song 001");
    expect(first.indexOf("Song 030")).toBeLessThan(first.indexOf("Song 029"));
  });

  test("exactly one page of videos has no pager", async () => {
    const environment = await buildEnvironment();
    addPublished(environment, 24);

    const body = await (await send(environment, "/")).text();

    expect(cardCount(body)).toBe(24);
    expect(body).not.toContain("More videos");
    expect(body).not.toContain("Newer videos");
  });

  test.each([
    ["?page=99", 6],
    ["?page=0", 24],
    ["?page=-3", 24],
    ["?page=abc", 24],
    ["?page=", 24],
    ["?page=99999999999999999999", 6],
  ])("the page number %p is handled gracefully", async (query, expectedCards) => {
    const environment = await buildEnvironment();
    addPublished(environment, 30);

    const response = await send(environment, `/${query}`);

    expect(response.status).toBe(200);
    expect(cardCount(await response.text())).toBe(expectedCards);
  });

  test("pager links keep the channel filter", async () => {
    const environment = await buildEnvironment();
    addPublished(environment, 30);

    const body = await (await send(environment, "/?channel=UC1")).text();

    expect(body).toContain('href="/?channel=UC1&amp;page=2"');
  });

  test("an empty list shows a message and no pager", async () => {
    const environment = await buildEnvironment();
    const body = await (await send(environment, "/")).text();
    expect(body).toContain("Nothing here yet");
    expect(body).not.toContain("More videos");
  });
});

describe("thumbnails", () => {
  test("a thumbnail is fetched once then served from local disk", async () => {
    const environment = await environmentWithSong();

    const first = await send(environment, `/thumb/${videoId}`);
    const second = await send(environment, `/thumb/${videoId}`);

    expect(first.status).toBe(200);
    expect(await first.text()).toBe("JPEG");
    expect(await second.text()).toBe("JPEG");
    expect(first.headers.get("content-type")).toBe("image/jpeg");
    expect(first.headers.get("cache-control")).toBeTruthy();
    expect(environment.imageServer.requests).toHaveLength(1);
  });

  test("prefers the picture saved next to a pinned download", async () => {
    const environment = await environmentWithSong();
    const video = join(environment.mediaDir, "Chan", `Song [${videoId}].mp4`);
    await writeFileWithFolders(video.replace(/\.mp4$/, ".jpg"), "PINNED-JPEG");
    await makePinnedFile(environment, videoId, video, "v");

    const response = await send(environment, `/thumb/${videoId}`);

    expect(await response.text()).toBe("PINNED-JPEG");
    expect(environment.imageServer.requests).toHaveLength(0);
  });

  test("hidden or unknown videos are not found and never fetched", async () => {
    const environment = await environmentWithBlockedSong();

    for (const id of [videoId, unknownVideoId]) {
      expect((await send(environment, `/thumb/${id}`)).status).toBe(404);
    }
    expect(environment.imageServer.requests).toHaveLength(0);
  });

  test("a failure returns bad gateway without leaking details", async () => {
    const environment = await environmentWithSong();
    environment.imageServer.failing = true;

    const response = await send(environment, `/thumb/${videoId}`);

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("thumbnail unavailable");
    expect(environment.logs.some((message) => message.includes(videoId))).toBe(true);
  });

  test("pages never make the browser contact YouTube for images", async () => {
    const environment = await buildEnvironment();
    addPublished(environment, 3);

    const body = await (await send(environment, "/")).text();

    expect(body).toContain(`src="/thumb/${numberedId(3)}"`);
    expect(body).not.toContain("ytimg.com");
    expect(body).not.toContain("youtube.com");
  });
});

describe("database failures", () => {
  test("return a generic 500 without leaking details", async () => {
    const environment = await environmentWithSong();
    const cookie = await logIn(environment);
    closeStore(environment.store);

    const requests = [
      { method: "GET", path: "/" },
      { method: "GET", path: `/watch/${videoId}` },
      { method: "GET", path: `/status/${videoId}` },
      { method: "GET", path: `/video/${videoId}` },
      { method: "GET", path: `/thumb/${videoId}` },
      { method: "POST", path: `/api/videos/${videoId}/prepare` },
      { method: "POST", path: `/api/videos/${videoId}/played` },
    ];
    for (const { method, path } of requests) {
      const response = await send(environment, path, { method, cookie });
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("something went wrong");
    }
    expect(environment.logs.length).toBeGreaterThan(0);
  });
});
