import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomVideoId, testStartSeconds } from "../../tests/helpers.ts";
import { claimDownload, finishDownload, pinVideo } from "../downloads/queue.ts";
import type { VideoId } from "../ytdlp/types.ts";
import { deleteChannel, getWatchableChannels, insertChannel } from "./channels.ts";
import {
    cacheFile,
    channelIdOf,
    everything,
    idsOf,
    keepFile,
    newVideo,
    openTestDatabase,
    videoOf,
} from "./test-helpers.ts";
import { NotFoundError } from "./types.ts";
import {
    allowVideo,
    blockVideo,
    deleteVideo,
    getAdminVideos,
    getVideo,
    getWatchableVideos,
    insertVideo,
    recordPlay,
    unblockVideo,
} from "./videos.ts";

describe("what the child may watch", () => {
    test("a video from an allowed channel is visible", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        insertChannel(database, channel, "Piano");
        const video = newVideo(channel);
        insertVideo(database, video);
        expect(idsOf(getWatchableVideos(database, "", everything).videos)).toContain(video.youtubeId);
    });

    test("a video from an unlisted channel is hidden", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        insertVideo(database, video);
        expect(videoOf(database, video.youtubeId).watchable).toBe(false);
    });

    test("an individually allowed video needs no channel", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        expect(videoOf(database, video.youtubeId).watchable).toBe(true);
    });

    test("a blocked video is hidden even in an allowed channel", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        insertChannel(database, channel, "Piano");
        const video = newVideo(channel);
        insertVideo(database, video);
        blockVideo(database, video.youtubeId);
        expect(videoOf(database, video.youtubeId).watchable).toBe(false);
    });

    test("blocking an unknown video reports not found", async () => {
        const { database } = await openTestDatabase();
        expect(() => blockVideo(database, randomVideoId())).toThrow(NotFoundError);
    });

    test("removing a channel hides its inherited videos", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        insertChannel(database, channel, "Piano");
        const video = newVideo(channel);
        insertVideo(database, video);
        deleteChannel(database, channelIdOf(database, channel));
        expect(videoOf(database, video.youtubeId).watchable).toBe(false);
    });

    test("removing a channel keeps individually allowed videos", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        insertChannel(database, channel, "Piano");
        const video = newVideo(channel);
        allowVideo(database, video);
        deleteChannel(database, channelIdOf(database, channel));
        expect(videoOf(database, video.youtubeId).watchable).toBe(true);
    });

    test("watchable videos can be filtered by channel", async () => {
        const { database } = await openTestDatabase();
        const [channelA, channelB] = [randomVideoId(), randomVideoId()];
        insertChannel(database, channelA, "A");
        insertChannel(database, channelB, "B");
        const videoA = newVideo(channelA);
        insertVideo(database, videoA);
        insertVideo(database, newVideo(channelB));
        expect(idsOf(getWatchableVideos(database, channelA, everything).videos)).toEqual([videoA.youtubeId]);
    });

    test("syncing again does not overwrite an explicit decision", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        insertChannel(database, channel, "Piano");
        const video = newVideo(channel);
        insertVideo(database, video);
        blockVideo(database, video.youtubeId);
        insertVideo(database, video);
        expect(videoOf(database, video.youtubeId).rule).toBe("block");
    });

    test("unblocking returns to the channel rule when the channel is allowed", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        insertChannel(database, channel, "Piano");
        const video = newVideo(channel);
        insertVideo(database, video);
        blockVideo(database, video.youtubeId);
        unblockVideo(database, video.youtubeId);
        const unblocked = videoOf(database, video.youtubeId);
        expect([unblocked.rule, unblocked.watchable]).toEqual(["inherit", true]);
    });

    test("unblocking keeps the video visible when its channel is not allowed", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        blockVideo(database, video.youtubeId);
        unblockVideo(database, video.youtubeId);
        const unblocked = videoOf(database, video.youtubeId);
        expect([unblocked.rule, unblocked.watchable]).toEqual(["allow", true]);
    });

    test("watchable channels lists only channels with visible videos", async () => {
        const { database } = await openTestDatabase();
        const [withVideo, empty] = [randomVideoId(), randomVideoId()];
        insertChannel(database, withVideo, "Has videos");
        insertChannel(database, empty, "No videos");
        insertVideo(database, newVideo(withVideo));
        expect(getWatchableChannels(database)).toEqual([{ youtubeId: withVideo, name: `Channel ${withVideo}` }]);
    });

    test("an unknown video is null", async () => {
        const { database } = await openTestDatabase();
        expect(getVideo(database, randomVideoId())).toBeNull();
    });
});

describe("recording plays", () => {
    test("plays are counted and the time is stamped", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        recordPlay(database, video.youtubeId);
        recordPlay(database, video.youtubeId);
        const played = videoOf(database, video.youtubeId);
        expect([played.playCount, played.lastPlayedAt]).toEqual([2, testStartSeconds]);
    });
});

describe("removing a video", () => {
    function allowedChannelVideo(database: Database) {
        const channel = randomVideoId();
        insertChannel(database, channel, "Piano Guy");
        const video = newVideo(channel);
        insertVideo(database, video);
        keepFile(database, video.youtubeId, "/media/kept.mp4");
        cacheFile(database, video.youtubeId, "/cache/copy.mp4");
        return video;
    }

    test("removing returns both paths for cleanup", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        keepFile(database, video.youtubeId, "/media/a.mp4");
        cacheFile(database, video.youtubeId, "/cache/a.mp4");
        expect(deleteVideo(database, video.youtubeId)).toMatchObject({
            filePath: "/media/a.mp4",
            cachePath: "/cache/a.mp4",
        });
    });

    test("removing an unknown video reports not found", async () => {
        const { database } = await openTestDatabase();
        expect(() => deleteVideo(database, randomVideoId())).toThrow(NotFoundError);
    });

    test("removing a video of an allowed channel blocks it instead of deleting", async () => {
        const { database } = await openTestDatabase();
        const video = allowedChannelVideo(database);
        const removal = deleteVideo(database, video.youtubeId);
        expect(removal).toEqual({ filePath: "/media/kept.mp4", cachePath: "/cache/copy.mp4", blocked: true });
        expect(videoOf(database, video.youtubeId)).toMatchObject({
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
        const { database } = await openTestDatabase();
        const video = allowedChannelVideo(database);
        deleteVideo(database, video.youtubeId);
        insertVideo(database, video);
        expect(videoOf(database, video.youtubeId)).toMatchObject({ rule: "block", watchable: false });
    });

    test("removing an individually allowed video in an allowed channel still hides it", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        insertChannel(database, channel, "Piano Guy");
        const video = newVideo(channel);
        allowVideo(database, video);
        deleteVideo(database, video.youtubeId);
        expect(videoOf(database, video.youtubeId).watchable).toBe(false);
    });

    test("removing a video outside any allowed channel deletes it", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        expect(deleteVideo(database, video.youtubeId).blocked).toBe(false);
        expect(getVideo(database, video.youtubeId)).toBeNull();
    });

    test("removing while downloading deletes a video outside any allowed channel", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        pinVideo(database, video.youtubeId);
        claimDownload(database);
        deleteVideo(database, video.youtubeId);
        expect(getVideo(database, video.youtubeId)).toBeNull();
    });

    test("removing leaves an in-flight download for the worker to discard", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        insertChannel(database, channel, "Piano Guy");
        const video = newVideo(channel);
        insertVideo(database, video);
        pinVideo(database, video.youtubeId);
        claimDownload(database);
        deleteVideo(database, video.youtubeId);
        expect(videoOf(database, video.youtubeId)).toMatchObject({ pinned: false, downloadStatus: "downloading" });
        expect(finishDownload(database, video.youtubeId, "/media/late.mp4")).toBe(false);
    });
});

describe("paging and ordering", () => {
    function addNumberedVideos(database: Database, channel: string, count: number) {
        insertChannel(database, channel, "Channel");
        return Array.from({ length: count }, (_, index) => {
            const video = newVideo(channel, { publishedAt: 1_000_001 + index });
            insertVideo(database, video);
            return video;
        });
    }

    test("watchable returns the requested page and the total", async () => {
        const { database } = await openTestDatabase();
        const videos = addNumberedVideos(database, randomVideoId(), 10);
        const page = getWatchableVideos(database, "", { limit: 4, offset: 4 });
        expect(page.total).toBe(10);
        expect(idsOf(page.videos)).toEqual([5, 4, 3, 2].map((index) => videos[index]?.youtubeId) as VideoId[]);
    });

    test("a page beyond the end is empty but the total is reported", async () => {
        const { database } = await openTestDatabase();
        addNumberedVideos(database, randomVideoId(), 3);
        expect(getWatchableVideos(database, "", { limit: 10, offset: 50 })).toEqual({ videos: [], total: 3 });
    });

    test("the total respects the channel filter", async () => {
        const { database } = await openTestDatabase();
        const channelB = randomVideoId();
        addNumberedVideos(database, randomVideoId(), 5);
        addNumberedVideos(database, channelB, 2);
        expect(getWatchableVideos(database, channelB, { limit: 10, offset: 0 }).total).toBe(2);
    });

    test("videos are ordered by publish date, not by when they were synced", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        insertChannel(database, channel, "Channel");
        const synced = [300, 900, 600].map((publishedAt) => newVideo(channel, { publishedAt }));
        for (const video of synced) {
            insertVideo(database, video);
        }
        const [oldest, newest, middle] = synced.map((video) => video.youtubeId);
        expect([oldest, newest, middle]).not.toContain(undefined);
        expect(idsOf(getWatchableVideos(database, "", everything).videos)).toEqual([
            newest,
            middle,
            oldest,
        ] as VideoId[]);
    });

    test("videos without a date follow dated ones, latest synced first", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        insertChannel(database, channel, "Channel");
        const [undatedFirst, dated, undatedSecond] = [
            newVideo(channel),
            newVideo(channel, { publishedAt: 500 }),
            newVideo(channel),
        ];
        for (const video of [undatedFirst, dated, undatedSecond]) {
            insertVideo(database, video);
        }
        expect(idsOf(getWatchableVideos(database, "", everything).videos)).toEqual([
            dated.youtubeId,
            undatedSecond.youtubeId,
            undatedFirst.youtubeId,
        ]);
    });

    test("admin videos page and count the listed videos", async () => {
        const { database } = await openTestDatabase();
        for (const video of Array.from({ length: 7 }, () => newVideo(randomVideoId()))) {
            allowVideo(database, video);
        }
        insertVideo(database, newVideo(randomVideoId()));
        const page = getAdminVideos(database, "", { limit: 5, offset: 5 });
        expect([page.videos.length, page.total]).toEqual([2, 7]);
    });

    test("admin videos for a channel list every video of that channel", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        const synced = newVideo(channel);
        insertVideo(database, synced);
        insertVideo(database, newVideo(randomVideoId()));
        expect(idsOf(getAdminVideos(database, channel, everything).videos)).toEqual([synced.youtubeId]);
    });

    test("admin videos include pinned and downloading videos", async () => {
        const { database } = await openTestDatabase();
        const synced = newVideo(randomVideoId());
        insertVideo(database, synced);
        pinVideo(database, synced.youtubeId);
        expect(idsOf(getAdminVideos(database, "", everything).videos)).toEqual([synced.youtubeId]);
    });
});

describe("publish dates", () => {
    test("syncing fills in a missing publish date without changing the rule", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        insertChannel(database, channel, "Channel");
        const video = newVideo(channel);
        insertVideo(database, video);
        blockVideo(database, video.youtubeId);
        insertVideo(database, { ...video, publishedAt: 1234 });
        expect(videoOf(database, video.youtubeId)).toMatchObject({ publishedAt: 1234, rule: "block" });
    });

    test("syncing never replaces a known date with an unknown one", async () => {
        const { database } = await openTestDatabase();
        const channel = randomVideoId();
        insertChannel(database, channel, "Channel");
        const video = newVideo(channel, { publishedAt: 777 });
        insertVideo(database, video);
        insertVideo(database, { ...video, publishedAt: 0 });
        expect(videoOf(database, video.youtubeId).publishedAt).toBe(777);
    });

    test("allowing keeps a known publish date when the new one is unknown", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId(), { publishedAt: 555 });
        allowVideo(database, video);
        allowVideo(database, { ...video, publishedAt: 0 });
        expect(videoOf(database, video.youtubeId).publishedAt).toBe(555);
    });

    test("allowing an already synced video makes it explicitly allowed", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        insertVideo(database, video);
        allowVideo(database, { ...video, title: "Renamed" });
        expect(videoOf(database, video.youtubeId)).toMatchObject({ rule: "allow", title: "Renamed" });
    });
});
