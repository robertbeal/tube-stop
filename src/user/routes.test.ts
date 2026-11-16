import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { allow, buildEnvironment, logIn, send } from "../../tests/harness.ts";
import { testVideoId } from "../../tests/helpers.ts";
import { claimCache, claimDownload, failCache, finishDownload, pinVideo, requestCache } from "../shared/db/queue.ts";
import { createTopic, setVideoTopics } from "../shared/db/topics.ts";
import * as videoQueries from "../shared/db/videos.ts";
import { blockVideo } from "../shared/db/videos.ts";
import type { VideoId } from "../shared/ytdlp/types.ts";
import {
    addPublished,
    allowPianoVideo,
    cardCount,
    countOccurrences,
    loadVideo,
    makeCacheReady,
    makePinnedFile,
    numberedId,
    unknownVideoId,
    videoId,
    writeFileWithFolders,
} from "./test-helpers.ts";

async function environmentWithSong() {
    const environment = await buildEnvironment();
    allowPianoVideo(videoId, "Song");
    return environment;
}

async function environmentWithBlockedSong() {
    const environment = await environmentWithSong();
    blockVideo(videoId);
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
        allowPianoVideo(testVideoId("aaaaaaaaaaa"), "Twinkle Twinkle");
        allowPianoVideo(testVideoId("bbbbbbbbbbb"), "Scary Video");
        blockVideo(testVideoId("bbbbbbbbbbb"));

        const response = await send(environment, "/");
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(body).toContain("Twinkle Twinkle");
        expect(body).not.toContain("Scary Video");
    });

    test("the channel filter shows only that channel", async () => {
        const environment = await buildEnvironment();
        allow({
            youtubeId: testVideoId("aaaaaaaaaaa"),
            title: "From A",
            channelYoutubeId: "UCa",
            channelName: "A",
        });
        allow({
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

        const video = loadVideo(videoId);
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
        expect(loadVideo(videoId).cacheStatus).toBe("queued");
    });

    test("prepare does nothing when a file is already ready", async () => {
        const environment = await environmentWithSong();
        await makeCacheReady(environment, videoId, "data");

        const response = await send(environment, prepare(videoId), { method: "POST" });

        expect(response.status).toBe(202);
        expect(loadVideo(videoId).cacheStatus).toBe("ready");
    });

    test("prepare retries a failed download", async () => {
        const environment = await environmentWithSong();
        requestCache(videoId);
        claimCache();
        failCache(videoId, "network");

        await send(environment, prepare(videoId), { method: "POST" });

        const video = loadVideo(videoId);
        expect(video.cacheStatus).toBe("queued");
        expect(video.cacheError).toBe("");
    });

    test("prepare and played refuse blocked and unknown videos", async () => {
        const environment = await environmentWithBlockedSong();

        for (const id of [videoId, unknownVideoId]) {
            expect((await send(environment, prepare(id), { method: "POST" })).status).toBe(404);
            expect((await send(environment, played(id), { method: "POST" })).status).toBe(404);
        }

        const video = loadVideo(videoId);
        expect(video.cacheStatus).toBe("none");
        expect(video.playCount).toBe(0);
    });

    test("watched is recorded once, and refused for blocked and unknown videos", async () => {
        const environment = await environmentWithSong();
        const watched = (id: VideoId) => `/api/videos/${id}/watched`;

        expect((await send(environment, watched(videoId), { method: "POST" })).status).toBe(204);
        expect(loadVideo(videoId).watchedAt).toBeGreaterThan(0);
        expect((await send(environment, watched(unknownVideoId), { method: "POST" })).status).toBe(404);

        blockVideo(videoId);
        expect((await send(environment, watched(videoId), { method: "POST" })).status).toBe(404);
    });

    test("played counts each reported play", async () => {
        const environment = await environmentWithSong();

        const response = await send(environment, played(videoId), { method: "POST" });
        await send(environment, played(videoId), { method: "POST" });

        const video = loadVideo(videoId);
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
        expect(loadVideo(videoId).playCount).toBe(0);
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
        requestCache(videoId);
        claimCache();
        failCache(videoId, "network");

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
        await makePinnedFile(videoId, join(environment.mediaDir, "pinned.mp4"), "pinned");

        expect(await (await send(environment, `/video/${videoId}`)).text()).toBe("pinned");
    });

    test("falls back to the cache when the pinned file went missing", async () => {
        const environment = await environmentWithSong();
        await makeCacheReady(environment, videoId, "cached");
        pinVideo(videoId);
        claimDownload();
        finishDownload(videoId, join(environment.mediaDir, "deleted-by-hand.mp4"));

        expect(await (await send(environment, `/video/${videoId}`)).text()).toBe("cached");
    });

    test("a video that is not ready returns service unavailable", async () => {
        const environment = await environmentWithSong();
        expect((await send(environment, `/video/${videoId}`)).status).toBe(503);
    });

    test("a blocked or unknown video is never served", async () => {
        const environment = await environmentWithSong();
        await makeCacheReady(environment, videoId, "secret bytes");
        blockVideo(videoId);

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
        addPublished(30);

        const body = await (await send(environment, "/")).text();

        expect(cardCount(body)).toBe(24);
        expect(body).toContain('href="/?page=2"');
        expect(body).toContain("More videos");
        expect(body).not.toContain("Newer videos");
    });

    test("the second page has the rest and a link back", async () => {
        const environment = await buildEnvironment();
        addPublished(30);

        const body = await (await send(environment, "/?page=2")).text();

        expect(cardCount(body)).toBe(6);
        expect(body).toContain('href="/"');
        expect(body).toContain("Newer videos");
        expect(body).not.toContain("More videos");
    });

    test("videos are shown newest published first across pages", async () => {
        const environment = await buildEnvironment();
        addPublished(30);

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
        addPublished(24);

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
        addPublished(30);

        const response = await send(environment, `/${query}`);

        expect(response.status).toBe(200);
        expect(cardCount(await response.text())).toBe(expectedCards);
    });

    test("pager links keep the channel filter", async () => {
        const environment = await buildEnvironment();
        addPublished(30);

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
        await makePinnedFile(videoId, video, "v");

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
        addPublished(3);

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
        spyOn(videoQueries, "getWatchableVideos").mockImplementation(() => {
            throw new Error("database is closed");
        });
        spyOn(videoQueries, "getVideo").mockImplementation(() => {
            throw new Error("database is closed");
        });

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

describe("topics", () => {
    test("the index shows a row for each topic that has videos, and the rest under more videos", async () => {
        const environment = await buildEnvironment();
        const [nature] = [createTopic("Nature", "🌿", "success"), createTopic("Empty", "", "primary")];
        allowPianoVideo(videoId, "Song");
        const other = numberedId(2);
        allowPianoVideo(other, "Loose");
        setVideoTopics(videoId, [nature.id]);

        const html = await (await send(environment, "/")).text();
        expect(html).toContain("Nature");
        expect(html).not.toContain("Empty");
        expect(html).toContain("More videos");
        expect(html).toContain(`href="/watch/${videoId}"`);
        expect(html).toContain(`href="/watch/${other}"`);
    });

    test("without topics the index is the plain list", async () => {
        const environment = await buildEnvironment();
        allowPianoVideo(videoId, "Song");
        const html = await (await send(environment, "/")).text();
        expect(html).not.toContain("shelf");
        expect(cardCount(html)).toBe(1);
    });

    test("a topic page lists its videos only", async () => {
        const environment = await buildEnvironment();
        const topic = createTopic("Music", "🎵", "danger");
        allowPianoVideo(videoId, "Song");
        allowPianoVideo(numberedId(2), "Loose");
        setVideoTopics(videoId, [topic.id]);

        const response = await send(environment, "/topic/music");
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(cardCount(html)).toBe(1);
        expect(html).toContain("Song");
        expect((await send(environment, "/topic/unknown")).status).toBe(404);
    });

    test("the page for videos without a topic lists them", async () => {
        const environment = await buildEnvironment();
        const topic = createTopic("Music", "🎵", "danger");
        allowPianoVideo(videoId, "Song");
        allowPianoVideo(numberedId(2), "Loose");
        setVideoTopics(videoId, [topic.id]);

        const html = await (await send(environment, "/other")).text();
        expect(cardCount(html)).toBe(1);
        expect(html).toContain("Loose");
    });
});

describe("watched badge", () => {
    test("only watched videos get the badge", async () => {
        const environment = await buildEnvironment();
        allowPianoVideo(videoId, "Song");
        allowPianoVideo(numberedId(2), "Other");
        expect(await (await send(environment, "/")).text()).not.toContain("Watched");

        await send(environment, `/api/videos/${videoId}/watched`, { method: "POST" });
        const html = await (await send(environment, "/?channel=UC1")).text();
        expect(countOccurrences(html, "✓ Watched")).toBe(1);
    });
});

describe("recently watched and hiding watched", () => {
    const hideCookie = "tubestop_hide_watched=1";

    async function setup() {
        const environment = await buildEnvironment();
        const topic = createTopic("Music", "🎵", "danger");
        const seen = numberedId(2);
        allowPianoVideo(videoId, "Fresh song");
        allowPianoVideo(seen, "Seen song");
        setVideoTopics(videoId, [topic.id]);
        setVideoTopics(seen, [topic.id]);
        await send(environment, `/api/videos/${seen}/watched`, { method: "POST" });
        return { environment, seen };
    }

    test("the home page ends with the recently watched row", async () => {
        const { environment, seen } = await setup();
        const html = await (await send(environment, "/")).text();
        expect(html).toContain("Recently watched");
        expect(html.indexOf("Recently watched")).toBeGreaterThan(html.indexOf("Music"));
        expect(countOccurrences(html, `href="/watch/${seen}"`)).toBe(2);
    });

    test("without topics the plain list is followed by the recently watched row", async () => {
        const environment = await buildEnvironment();
        allowPianoVideo(videoId, "Song");
        expect(await (await send(environment, "/")).text()).not.toContain("Recently watched");

        await send(environment, `/api/videos/${videoId}/watched`, { method: "POST" });
        const html = await (await send(environment, "/")).text();
        expect(html).toContain("Recently watched");
        expect(html.indexOf("Recently watched")).toBeGreaterThan(html.indexOf("Song"));
        expect(await (await send(environment, "/?channel=UC1")).text()).not.toContain("Recently watched");
    });

    test("no recently watched row until something is watched", async () => {
        const environment = await buildEnvironment();
        allowPianoVideo(videoId, "Song");
        setVideoTopics(videoId, [createTopic("Music", "", "primary").id]);
        expect(await (await send(environment, "/")).text()).not.toContain("Recently watched");
    });

    test("hiding watched leaves them out of topic rows and pages but not the recently watched row", async () => {
        const { environment, seen } = await setup();
        const home = await (await send(environment, "/", { cookie: hideCookie })).text();
        expect(countOccurrences(home, `href="/watch/${seen}"`)).toBe(1);
        expect(home).toContain("Show watched");

        const topic = await (await send(environment, "/topic/music", { cookie: hideCookie })).text();
        expect(cardCount(topic)).toBe(1);
        expect(topic).not.toContain("Seen song");

        const plain = await (await send(environment, "/topic/music")).text();
        expect(cardCount(plain)).toBe(2);
        expect(plain).toContain("Hide watched");
    });

    test("the watched page lists them all", async () => {
        const { environment } = await setup();
        const html = await (await send(environment, "/watched", { cookie: hideCookie })).text();
        expect(cardCount(html)).toBe(1);
        expect(html).toContain("Seen song");
    });

    test("the button sets and clears the choice, and only returns to this site", async () => {
        const environment = await buildEnvironment();
        const on = await send(environment, "/hide-watched", { form: { hide: "1", next: "/topic/music?page=2" } });
        expect(on.status).toBe(303);
        expect(on.headers.get("location")).toBe("/topic/music?page=2");
        expect(on.headers.getSetCookie().join()).toContain("tubestop_hide_watched=1");

        const off = await send(environment, "/hide-watched", { form: { hide: "0", next: "/" } });
        expect(off.headers.getSetCookie().join()).toMatch(/tubestop_hide_watched=;/);

        for (const next of ["//evil.example", "https://evil.example", "/\\evil", ""]) {
            const response = await send(environment, "/hide-watched", { form: { hide: "1", next } });
            expect(response.headers.get("location")).toBe("/");
        }
    });
});
