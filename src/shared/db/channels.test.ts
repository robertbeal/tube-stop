import { describe, expect, test } from "bun:test";
import { randomVideoId, testStartSeconds } from "../../../tests/helpers.ts";
import { deleteChannel, getChannels, insertChannel, markChannelSynced } from "./channels.ts";
import { claimCache, finishCache, requestCache } from "./queue.ts";
import { cacheFile, channelIdOf, keepFile, newVideo, videoOf } from "./test-helpers.ts";
import { type ChannelId, NotFoundError } from "./types.ts";
import { allowVideo, blockVideo, insertVideo } from "./videos.ts";

describe("channels", () => {
    test("adding an existing channel renames it", async () => {
        insertChannel("chan", "Old");
        insertChannel("chan", "New");
        expect(getChannels().map((channel) => channel.name)).toEqual(["New"]);
    });

    test("channels are listed by name ignoring case, with their non-blocked video count", async () => {
        insertChannel("b", "banana");
        insertChannel("a", "Cherry");
        insertChannel("c", "apple");
        const [first, second] = [newVideo("b"), newVideo("b")];
        insertVideo(first);
        insertVideo(second);
        blockVideo(second.youtubeId);
        const channels = getChannels();
        expect(channels.map((channel) => [channel.name, channel.videoCount])).toEqual([
            ["apple", 0],
            ["banana", 1],
            ["Cherry", 0],
        ]);
    });

    test("marking a channel synced stamps the current time", async () => {
        insertChannel("chan", "Piano");
        expect(getChannels()[0]?.lastSyncedAt).toBe(0);
        markChannelSynced("chan");
        expect(getChannels()[0]?.lastSyncedAt).toBe(testStartSeconds);
    });
});

describe("removing a channel", () => {
    test("returns and clears the cache of its inherited videos only", async () => {
        const channel = randomVideoId();
        insertChannel(channel, "Piano Guy");
        const [inherited, individual] = [newVideo(channel), newVideo(channel)];
        insertVideo(inherited);
        allowVideo(individual);
        for (const video of [inherited, individual]) {
            cacheFile(video.youtubeId, `/cache/${video.youtubeId}.mp4`);
        }

        const paths = deleteChannel(channelIdOf(channel));

        expect(paths).toEqual([`/cache/${inherited.youtubeId}.mp4`]);
        expect(videoOf(inherited.youtubeId)).toMatchObject({ cacheStatus: "none", cachePath: "" });
        expect(videoOf(individual.youtubeId)).toMatchObject({ cacheStatus: "ready", watchable: true });
    });

    test("keeps pinned files", async () => {
        const channel = randomVideoId();
        insertChannel(channel, "Piano Guy");
        const video = newVideo(channel);
        insertVideo(video);
        keepFile(video.youtubeId, "/media/kept.mp4");
        deleteChannel(channelIdOf(channel));
        expect(videoOf(video.youtubeId)).toMatchObject({
            pinned: true,
            filePath: "/media/kept.mp4",
            downloadStatus: "ready",
        });
    });

    test("discards a cache download that finishes afterwards", async () => {
        const channel = randomVideoId();
        insertChannel(channel, "Piano Guy");
        const video = newVideo(channel);
        insertVideo(video);
        requestCache(video.youtubeId);
        claimCache();
        deleteChannel(channelIdOf(channel));
        expect(finishCache(video.youtubeId, "/cache/late.mp4")).toBe(false);
    });

    test("an unknown channel reports not found", async () => {
        expect(() => deleteChannel(424242 as ChannelId)).toThrow(NotFoundError);
    });
});
