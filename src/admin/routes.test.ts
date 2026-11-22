import { describe, expect, spyOn, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { allow, buildEnvironment, type Environment, logIn, send } from "../../tests/harness.ts";
import { advanceTime, testVideoId } from "../../tests/helpers.ts";
import { getChannels, insertChannel, markChannelSynced } from "../shared/db/channels.ts";
import { claimDownload, failDownload, pinVideo } from "../shared/db/queue.ts";
import { createTopic, getChannelTopicIds, getTopics, getVideoTopicIds } from "../shared/db/topics.ts";
import type { ChannelId } from "../shared/db/types.ts";
import * as videoQueries from "../shared/db/videos.ts";
import { allowVideo, getVideo, getWatchableVideos, insertVideo } from "../shared/db/videos.ts";
import * as storage from "../shared/storage.ts";
import type { Resolved } from "../shared/ytdlp/types.ts";
import {
    allowPianoVideo,
    countOccurrences,
    loadVideo,
    makeCacheReady,
    makePinnedFile,
    numberedId,
    redirectKind,
    redirectMessage,
    unknownVideoId,
    videoId,
    writeFileWithFolders,
} from "../user/test-helpers.ts";

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false,
    );
}

async function adminPost(environment: Environment, path: string, form?: Record<string, string>) {
    const cookie = await logIn(environment);
    return send(environment, path, { method: "POST", cookie, form });
}

async function adminPage(environment: Environment, query = ""): Promise<string> {
    const cookie = await logIn(environment);
    return (await send(environment, `/admin${query}`, { cookie })).text();
}

async function environmentWithSong() {
    const environment = await buildEnvironment();
    allowPianoVideo(videoId, "Song");
    return environment;
}

const pianoGuyVideo: Resolved = {
    id: videoId,
    title: "Moonlight",
    channel: { id: "UC1", name: "Piano Guy" },
    duration: 90,
    publishedAt: 0,
};

describe("access control", () => {
    test("cross-site form posts are rejected", async () => {
        const environment = await environmentWithSong();
        const cookie = await logIn(environment);

        const response = await send(environment, `/admin/videos/${videoId}/pin`, {
            method: "POST",
            cookie,
            headers: { "Sec-Fetch-Site": "cross-site" },
        });

        expect(response.status).toBe(403);
        expect(loadVideo(videoId).pinned).toBe(false);
    });

    test("a database failure returns a generic 500 without leaking details", async () => {
        const environment = await buildEnvironment();
        const cookie = await logIn(environment);
        spyOn(videoQueries, "getAdminVideos").mockImplementation(() => {
            throw new Error("database is closed");
        });

        const response = await send(environment, "/admin", { cookie });

        expect(response.status).toBe(500);
        expect(await response.text()).toBe("something went wrong");
    });
});

describe("video actions on ids that are not YouTube video ids", () => {
    test.each(["pin", "unpin", "block", "unblock", "remove"])("%s is not found", async (action) => {
        const environment = await environmentWithSong();
        for (const id of ["short", "abcdefghijkl", "..%2F..%2Fx", "a%2Fb%3Fc"]) {
            expect((await adminPost(environment, `/admin/videos/${id}/${action}`)).status).toBe(404);
        }
    });
});

describe("video actions", () => {
    test("pin queues a download", async () => {
        const environment = await environmentWithSong();

        const response = await adminPost(environment, `/admin/videos/${videoId}/pin`);

        const video = loadVideo(videoId);
        expect(redirectMessage(response)).toBe("Done");
        expect(video.pinned).toBe(true);
        expect(video.downloadStatus).toBe("queued");
    });

    test("unpin deletes the file and its folder", async () => {
        const environment = await environmentWithSong();
        const folder = join(environment.mediaDir, "Piano Guy");
        await makePinnedFile(videoId, join(folder, `Song [${videoId}].mp4`), "x");

        redirectMessage(await adminPost(environment, `/admin/videos/${videoId}/unpin`));

        expect(await exists(folder)).toBe(false);
        const video = loadVideo(videoId);
        expect(video.pinned).toBe(false);
        expect(video.filePath).toBe("");
    });

    test("unpin while downloading really unpins", async () => {
        const environment = await environmentWithSong();
        pinVideo(videoId);
        claimDownload();

        redirectMessage(await adminPost(environment, `/admin/videos/${videoId}/unpin`));

        expect(loadVideo(videoId).pinned).toBe(false);
    });

    test("retry requeues a failed download", async () => {
        const environment = await environmentWithSong();
        pinVideo(videoId);
        claimDownload();
        failDownload(videoId, "HTTP Error 403");

        await adminPost(environment, `/admin/videos/${videoId}/retry`);

        const video = loadVideo(videoId);
        expect(video.downloadStatus).toBe("queued");
        expect(video.downloadError).toBe("");
    });

    test("block hides the video from the child and unblock restores it", async () => {
        const environment = await environmentWithSong();

        await adminPost(environment, `/admin/videos/${videoId}/block`);
        expect((await send(environment, `/watch/${videoId}`)).status).toBe(404);

        await adminPost(environment, `/admin/videos/${videoId}/unblock`);
        expect((await send(environment, `/watch/${videoId}`)).status).toBe(200);
    });

    test("remove deletes the video and its cached file", async () => {
        const environment = await environmentWithSong();
        const cached = await makeCacheReady(environment, videoId, "x");

        redirectMessage(await adminPost(environment, `/admin/videos/${videoId}/remove`));

        expect(getVideo(videoId)).toBeNull();
        expect(await exists(cached)).toBe(false);
    });

    test("an action on an unknown video explains it was not found", async () => {
        const environment = await buildEnvironment();
        for (const action of ["pin", "retry", "unpin", "block", "remove"]) {
            const message = redirectMessage(await adminPost(environment, `/admin/videos/${unknownVideoId}/${action}`));
            expect(message).toContain("not found");
        }
    });

    test("an unknown action is not found", async () => {
        const environment = await environmentWithSong();
        expect((await adminPost(environment, `/admin/videos/${videoId}/explode`)).status).toBe(404);
    });

    test("removing a channel video keeps it blocked and says so", async () => {
        const environment = await buildEnvironment();
        insertChannel("UC1", "Piano Guy");
        const synced = {
            youtubeId: videoId,
            channelYoutubeId: "UC1",
            channelName: "Piano Guy",
            title: "Song",
            duration: 0,
            publishedAt: 0,
        };
        insertVideo(synced);

        const message = redirectMessage(await adminPost(environment, `/admin/videos/${videoId}/remove`));
        insertVideo(synced); // the next hourly sync

        expect(message).toBe("Removed. It stays blocked so syncing the channel cannot bring it back.");
        expect((await send(environment, `/watch/${videoId}`)).status).toBe(404);
    });

    test("removing a standalone video says it was removed", async () => {
        const environment = await environmentWithSong();
        expect(redirectMessage(await adminPost(environment, `/admin/videos/${videoId}/remove`))).toBe("Removed");
    });

    test("removing a standalone video also deletes its saved thumbnail", async () => {
        const environment = await environmentWithSong();
        await send(environment, `/thumb/${videoId}`); // saves it
        const saved = join(environment.thumbDir, `${videoId}.jpg`);
        expect(await exists(saved)).toBe(true);

        await adminPost(environment, `/admin/videos/${videoId}/remove`);

        expect(await exists(saved)).toBe(false);
    });
});

describe("the colour of the message", () => {
    test("is green when it worked", async () => {
        const environment = await buildEnvironment({ resolve: async () => pianoGuyVideo });

        const responses = [
            await adminPost(environment, "/admin/add", { url: `https://youtu.be/${videoId}` }),
            await adminPost(environment, `/admin/videos/${videoId}/pin`),
            await adminPost(environment, `/admin/videos/${videoId}/block`),
            await adminPost(environment, "/admin/sync"),
        ];

        expect(responses.map(redirectKind)).toEqual(["success", "success", "success", "success"]);
    });

    test("is red when it did not", async () => {
        const environment = await buildEnvironment({
            resolve: async () => {
                throw new Error("Unsupported URL");
            },
        });

        const responses = [
            await adminPost(environment, "/admin/add", { url: "" }),
            await adminPost(environment, "/admin/add", { url: "https://example.com/nope" }),
            await adminPost(environment, `/admin/videos/${unknownVideoId}/pin`),
            await adminPost(environment, "/admin/channels/424242/remove"),
        ];

        expect(responses.map(redirectKind)).toEqual(["error", "error", "error", "error"]);
    });

    test("is amber when it worked but some files could not be deleted", async () => {
        const environment = await environmentWithSong();
        spyOn(storage, "removeMedia").mockResolvedValue([new Error("permission denied")]);

        const response = await adminPost(environment, `/admin/videos/${videoId}/unpin`);

        expect(redirectKind(response)).toBe("warning");
        expect(redirectMessage(response)).toContain("could not be deleted: permission denied");
    });

    test.each([
        ["success", "alert-success", "status"],
        ["warning", "alert-warning", "status"],
        ["error", "alert-danger", "alert"],
        ["anything-else", "alert-info", "status"],
        ["", "alert-info", "status"],
    ])("a %s message is shown as %s, announced as %s", async (kind, alertClass, role) => {
        const environment = await buildEnvironment();

        const body = await adminPage(environment, `?msg=Hello&kind=${kind}`);

        expect(body).toContain(`<div class="alert ${alertClass}" role="${role}">Hello</div>`);
    });

    test("no message shows no box", async () => {
        const environment = await buildEnvironment();
        expect(await adminPage(environment)).not.toContain('class="alert alert-');
    });
});

describe("the admin page", () => {
    test("shows download errors, a retry button and disk usage", async () => {
        const environment = await environmentWithSong();
        pinVideo(videoId);
        claimDownload();
        failDownload(videoId, "HTTP Error 403");
        await writeFileWithFolders(join(environment.cacheDir, "x.bin"), new Uint8Array(2048));

        const body = await adminPage(environment);

        for (const wanted of ["HTTP Error 403", "Retry", "2.0 KiB"]) {
            expect(body).toContain(wanted);
        }
    });

    test("the flash message is escaped", async () => {
        const environment = await buildEnvironment();
        const body = await adminPage(environment, `?msg=${encodeURIComponent("<script>alert(1)</script>")}`);
        expect(body).not.toContain("<script>alert(1)");
        expect(body).toContain("&lt;script&gt;alert(1)");
    });

    test("the button that adds a URL is called Add", async () => {
        const environment = await buildEnvironment();
        const body = await adminPage(environment);
        expect(body).toMatch(/<button[^>]*>Add<\/button>/);
        expect(body).not.toMatch(/<button[^>]*>Allow<\/button>/);
    });

    test("every button that sends a form says what it is doing while it works", async () => {
        const environment = await environmentWithSong();
        insertChannel("UC1", "Piano Guy");
        pinVideo(videoId);
        claimDownload();
        failDownload(videoId, "HTTP Error 403");

        const body = await adminPage(environment);

        const buttons = [...body.matchAll(/<button[^>]*type="submit"[^>]*>/g)].map(([tag]) => tag);
        expect(buttons.length).toBeGreaterThan(8);
        expect(buttons.filter((tag) => !/data-busy-label="[^"]+…"/.test(tag))).toEqual([]);
        expect(body).toContain('src="/static/forms.js"');
    });

    test("the remove button says when the video will stay hidden", async () => {
        const environment = await buildEnvironment();
        insertChannel("UC1", "Piano Guy");
        allow({
            youtubeId: testVideoId("inchannel01"),
            channelYoutubeId: "UC1",
            title: "In an allowed channel",
        });
        allow({
            youtubeId: testVideoId("standalone1"),
            channelYoutubeId: "UC9",
            title: "On its own",
        });

        const body = await adminPage(environment);

        expect(countOccurrences(body, "Remove (stays hidden)")).toBe(1);
    });

    test("lists one hundred videos per page and says where you are", async () => {
        const environment = await buildEnvironment();
        for (const number of Array.from({ length: 150 }, (_, index) => index + 1)) {
            allow({
                youtubeId: numberedId(number),
                title: `Listed ${String(number).padStart(3, "0")}`,
            });
        }

        const first = await adminPage(environment);
        const second = await adminPage(environment, "?page=2");

        expect(first).toContain("Showing 1–100 of 150");
        expect(first).toContain("Next →");
        expect(first).not.toContain("← Previous");
        expect(second).toContain("Showing 101–150 of 150");
        expect(second).toContain("← Previous");
        expect(second).not.toContain("Next →");
        expect(countOccurrences(first, "/watch/")).toBe(100);
        expect(countOccurrences(second, "/watch/")).toBe(50);
    });

    test("lists channels with their video counts and last sync", async () => {
        const environment = await buildEnvironment();
        insertChannel("UC1", "Piano Guy");
        insertVideo({
            youtubeId: videoId,
            channelYoutubeId: "UC1",
            channelName: "Piano Guy",
            title: "Song",
            duration: 0,
            publishedAt: 0,
        });
        markChannelSynced("UC1");
        advanceTime(2 * 60 * 60 * 1000);

        const body = await adminPage(environment);

        expect(body).toContain('href="/admin?channel=UC1"');
        expect(body).toContain("2 hours ago");
    });

    test("the channel filter lists that channel's videos", async () => {
        const environment = await buildEnvironment();
        insertChannel("UCa", "A");
        insertVideo({
            youtubeId: testVideoId("aaaaaaaaaaa"),
            channelYoutubeId: "UCa",
            channelName: "A",
            title: "From A",
            duration: 0,
            publishedAt: 0,
        });
        allow({
            youtubeId: testVideoId("bbbbbbbbbbb"),
            title: "Standalone B",
            channelYoutubeId: "UCb",
        });

        const body = await adminPage(environment, "?channel=UCa");

        expect(body).toContain("From A");
        expect(body).not.toContain("Standalone B");
        expect(body).toContain("channel filter");
    });
});

describe("adding by URL", () => {
    test("a video URL makes that video watchable", async () => {
        const environment = await buildEnvironment({ resolve: async () => pianoGuyVideo });

        const message = redirectMessage(
            await adminPost(environment, "/admin/add", { url: `https://youtu.be/${videoId}` }),
        );

        const video = loadVideo(videoId);
        expect(message).toBe("Allowed video Moonlight");
        expect(video.watchable).toBe(true);
        expect(video.title).toBe("Moonlight");
        expect(environment.resolved).toEqual([`https://youtu.be/${videoId}`]);
    });

    test("a channel URL allows the channel and starts a sync", async () => {
        const environment = await buildEnvironment({
            resolve: async () => ({ id: "UC1", name: "Piano Guy" }),
        });

        const message = redirectMessage(
            await adminPost(environment, "/admin/add", { url: "https://www.youtube.com/@pianoguy" }),
        );

        expect(message).toBe("Allowed channel Piano Guy (syncing videos…)");
        expect(getChannels().map(({ youtubeId, name }) => ({ youtubeId, name }))).toEqual([
            { youtubeId: "UC1", name: "Piano Guy" },
        ]);
        expect(environment.triggers.sync).toBe(1);
    });

    test("an empty URL is rejected with a message", async () => {
        const environment = await buildEnvironment();
        const message = redirectMessage(await adminPost(environment, "/admin/add", { url: "" }));
        expect(message).toBe("Enter a URL");
        expect(environment.resolved).toEqual([]);
    });

    test("an unreadable URL reports the error and changes nothing", async () => {
        const environment = await buildEnvironment({
            resolve: async () => {
                throw new Error("Unsupported URL");
            },
        });

        const message = redirectMessage(
            await adminPost(environment, "/admin/add", { url: "https://example.com/nope" }),
        );

        expect(message).toBe("Could not read that URL: Unsupported URL");
        expect(getWatchableVideos("", { limit: 1000, offset: 0 }).videos).toEqual([]);
        expect(environment.triggers.sync).toBe(0);
    });
});

describe("channels", () => {
    test("removing a channel hides its videos", async () => {
        const environment = await buildEnvironment();
        insertChannel("UC1", "Piano Guy");
        insertVideo({
            youtubeId: videoId,
            channelYoutubeId: "UC1",
            channelName: "Piano Guy",
            title: "Song",
            duration: 0,
            publishedAt: 0,
        });
        const [channel] = getChannels();

        redirectMessage(await adminPost(environment, `/admin/channels/${channel?.id}/remove`));

        expect((await send(environment, `/watch/${videoId}`)).status).toBe(404);
    });

    test("removing a channel deletes cached copies but keeps pinned and individually allowed videos", async () => {
        const environment = await buildEnvironment();
        insertChannel("UC1", "Piano Guy");
        const base = { channelYoutubeId: "UC1", channelName: "Piano Guy", duration: 0, publishedAt: 0 };
        insertVideo({ ...base, youtubeId: testVideoId("inherited01"), title: "Inherited" });
        allowVideo({ ...base, youtubeId: testVideoId("individual1"), title: "Individual" });
        insertVideo({ ...base, youtubeId: testVideoId("pinnedvid01"), title: "Pinned" });
        const inheritedCache = await makeCacheReady(environment, testVideoId("inherited01"), "x");
        const individualCache = await makeCacheReady(environment, testVideoId("individual1"), "x");
        const pinnedFile = join(environment.mediaDir, "kept.mp4");
        await makePinnedFile(testVideoId("pinnedvid01"), pinnedFile, "x");
        const [channel] = getChannels();

        const message = redirectMessage(await adminPost(environment, `/admin/channels/${channel?.id}/remove`));

        expect(await exists(inheritedCache)).toBe(false);
        expect(await exists(individualCache)).toBe(true);
        expect(await exists(pinnedFile)).toBe(true);
        expect(message).toBe("Channel removed. Kept videos from it were kept.");
    });

    test("removing an unknown channel explains it was not found", async () => {
        const environment = await buildEnvironment();
        const message = redirectMessage(await adminPost(environment, "/admin/channels/424242/remove"));
        expect(message).toContain("not found");
    });

    test("a channel id that is not a number is not found", async () => {
        const environment = await buildEnvironment();
        expect((await adminPost(environment, "/admin/channels/abc/remove")).status).toBe(404);
    });

    test("sync all now starts a sync", async () => {
        const environment = await buildEnvironment();

        const message = redirectMessage(await adminPost(environment, "/admin/sync"));

        expect(message).toBe("Sync started");
        expect(environment.triggers.sync).toBe(1);
    });
});

describe("topics", () => {
    test("an admin can add, rename, move and delete topics", async () => {
        const environment = await buildEnvironment();
        await adminPost(environment, "/admin/topics", { name: "Nature", emoji: "🌿", color: "success" });
        await adminPost(environment, "/admin/topics", { name: "Music", emoji: "🎵", color: "danger" });
        const [nature, music] = getTopics();
        await adminPost(environment, `/admin/topics/${music?.id}/up`);
        await adminPost(environment, `/admin/topics/${nature?.id}/update`, {
            name: "Wild",
            emoji: "🦊",
            color: "info",
        });
        expect(getTopics().map((topic) => topic.name)).toEqual(["Music", "Wild"]);
        await adminPost(environment, `/admin/topics/${music?.id}/delete`);
        expect(getTopics().map((topic) => topic.name)).toEqual(["Wild"]);
        expect((await adminPost(environment, `/admin/topics/${nature?.id}/explode`)).status).toBe(404);
    });

    test("an admin can tag a channel and a video with several topics", async () => {
        const environment = await environmentWithSong();
        const [a, b] = [createTopic("A", "", "primary"), createTopic("B", "", "primary")];
        const cookie = await logIn(environment);
        insertChannel("UC1", "Piano Guy");
        const channel = getChannels()[0];
        const form = new URLSearchParams([
            ["topic", String(a.id)],
            ["topic", String(b.id)],
        ]);
        const response = await send(environment, `/admin/channels/${channel?.id}/topics`, { cookie, form });
        expect(response.status).toBe(303);
        expect(getChannelTopicIds().get(channel?.id as ChannelId)).toEqual([a.id, b.id]);

        await send(environment, `/admin/videos/${videoId}/topics`, {
            cookie,
            form: new URLSearchParams([["topic", String(b.id)]]),
        });
        expect(getVideoTopicIds([videoId]).get(videoId)).toEqual([b.id]);

        await send(environment, `/admin/videos/${videoId}/topics`, { cookie, form: new URLSearchParams() });
        expect(getVideoTopicIds([videoId]).size).toBe(0);
    });

    test("something that is not a topic is refused", async () => {
        const environment = await environmentWithSong();
        const response = await adminPost(environment, `/admin/videos/${videoId}/topics`, { topic: "abc" });
        expect(redirectKind(response)).toBe("error");
    });
});

describe("watched marks", () => {
    test("an admin can mark a video watched and clear it again", async () => {
        const environment = await environmentWithSong();
        const cookie = await logIn(environment);

        await send(environment, `/admin/videos/${videoId}/watched`, { cookie, method: "POST" });
        expect(loadVideo(videoId).watchedAt).toBeGreaterThan(0);
        expect(await adminPage(environment)).toContain("Unwatch");

        await send(environment, `/admin/videos/${videoId}/unwatched`, { cookie, method: "POST" });
        expect(loadVideo(videoId).watchedAt).toBe(0);
        expect(await adminPage(environment)).toContain("Mark watched");
    });
});
