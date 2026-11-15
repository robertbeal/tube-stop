import { describe, expect, test } from "bun:test";
import { randomVideoId, testStartSeconds } from "../../tests/helpers.ts";
import { claimCache, finishCache, requestCache } from "../downloads/queue.ts";
import { deleteChannel, getChannels, insertChannel, markChannelSynced } from "./channels.ts";
import { cacheFile, channelIdOf, keepFile, newVideo, openTestDatabase, videoOf } from "./test-helpers.ts";
import { NotFoundError } from "./types.ts";
import { allowVideo, blockVideo, insertVideo } from "./videos.ts";

describe("channels", () => {
    test("adding an existing channel renames it", async () => {
        const { database } = await openTestDatabase();
        insertChannel(database, "chan", "Old");
        insertChannel(database, "chan", "New");
        expect(getChannels(database).map((channel) => channel.name)).toEqual(["New"]);
    });

    test("channels are listed by name ignoring case, with their non-blocked video count", async () => {
        const { database } = await openTestDatabase();
        insertChannel(database, "b", "banana");
        insertChannel(database, "a", "Cherry");
        insertChannel(database, "c", "apple");
        const [first, second] = [newVideo("b"), newVideo("b")];
        insertVideo(database, first);
        insertVideo(database, second);
        blockVideo(database, second.youtubeId);
        const channels = getChannels(database);
        expect(channels.map((channel) => [channel.name, channel.videoCount])).toEqual([
            ["apple", 0],
            ["banana", 1],
            ["Cherry", 0],
        ]);
    });

    test("marking a channel synced stamps the current time", async () => {
        const { database } = await openTestDatabase();
        insertChannel(database, "chan", "Piano");
        expect(getChannels(database)[0]?.lastSyncedAt).toBe(0);
        markChannelSynced(database, "chan");
        expect(getChannels(database)[0]?.lastSyncedAt).toBe(testStartSeconds);
    });
});

describe("removing a channel", () => {
    test("returns and clears the cache of its inherited videos only", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        insertChannel(database, channel, "Piano Guy");
        const [inherited, individual] = [newVideo(channel), newVideo(channel)];
        insertVideo(database, inherited);
        allowVideo(database, individual);
        for (const video of [inherited, individual]) {
            cacheFile(database, video.youtubeId, `/cache/${video.youtubeId}.mp4`);
        }

        const paths = deleteChannel(database, channelIdOf(database, channel));

        expect(paths).toEqual([`/cache/${inherited.youtubeId}.mp4`]);
        expect(videoOf(database, inherited.youtubeId)).toMatchObject({ cacheStatus: "none", cachePath: "" });
        expect(videoOf(database, individual.youtubeId)).toMatchObject({ cacheStatus: "ready", watchable: true });
    });

    test("keeps pinned files", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        insertChannel(database, channel, "Piano Guy");
        const video = newVideo(channel);
        insertVideo(database, video);
        keepFile(database, video.youtubeId, "/media/kept.mp4");
        deleteChannel(database, channelIdOf(database, channel));
        expect(videoOf(database, video.youtubeId)).toMatchObject({
            pinned: true,
            filePath: "/media/kept.mp4",
            downloadStatus: "ready",
        });
    });

    test("discards a cache download that finishes afterwards", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        insertChannel(database, channel, "Piano Guy");
        const video = newVideo(channel);
        insertVideo(database, video);
        requestCache(database, video.youtubeId);
        claimCache(database);
        deleteChannel(database, channelIdOf(database, channel));
        expect(finishCache(database, video.youtubeId, "/cache/late.mp4")).toBe(false);
    });

    test("an unknown channel reports not found", async () => {
        const { database } = await openTestDatabase();
        expect(() => deleteChannel(database, 424242)).toThrow(NotFoundError);
    });
});
