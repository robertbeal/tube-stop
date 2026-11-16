import { describe, expect, test } from "bun:test";
import { advanceTime, randomVideoId, testStartSeconds } from "../../../tests/helpers.ts";
import type { VideoId } from "../ytdlp/types.ts";
import { deleteChannel, getWatchableChannels, insertChannel } from "./channels.ts";
import { claimDownload, finishDownload, pinVideo } from "./queue.ts";
import { cacheFile, channelIdOf, everything, idsOf, keepFile, newVideo, videoOf } from "./test-helpers.ts";
import { NotFoundError } from "./types.ts";
import {
    allowVideo,
    blockVideo,
    deleteVideo,
    getAdminVideos,
    getRecentlyWatched,
    getVideo,
    getWatchableVideos,
    insertVideo,
    markWatched,
    recordPlay,
    unblockVideo,
    unmarkWatched,
} from "./videos.ts";

describe("what the child may watch", () => {
    test("a video from an allowed channel is visible", async () => {
        const channel = randomVideoId();
        insertChannel(channel, "Piano");
        const video = newVideo(channel);
        insertVideo(video);
        expect(idsOf(getWatchableVideos("", everything).videos)).toContain(video.youtubeId);
    });

    test("a video from an unlisted channel is hidden", async () => {
        const video = newVideo(randomVideoId());
        insertVideo(video);
        expect(videoOf(video.youtubeId).watchable).toBe(false);
    });

    test("an individually allowed video needs no channel", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        expect(videoOf(video.youtubeId).watchable).toBe(true);
    });

    test("a blocked video is hidden even in an allowed channel", async () => {
        const channel = randomVideoId();
        insertChannel(channel, "Piano");
        const video = newVideo(channel);
        insertVideo(video);
        blockVideo(video.youtubeId);
        expect(videoOf(video.youtubeId).watchable).toBe(false);
    });

    test("blocking an unknown video reports not found", async () => {
        expect(() => blockVideo(randomVideoId())).toThrow(NotFoundError);
    });

    test("removing a channel hides its inherited videos", async () => {
        const channel = randomVideoId();
        insertChannel(channel, "Piano");
        const video = newVideo(channel);
        insertVideo(video);
        deleteChannel(channelIdOf(channel));
        expect(videoOf(video.youtubeId).watchable).toBe(false);
    });

    test("removing a channel keeps individually allowed videos", async () => {
        const channel = randomVideoId();
        insertChannel(channel, "Piano");
        const video = newVideo(channel);
        allowVideo(video);
        deleteChannel(channelIdOf(channel));
        expect(videoOf(video.youtubeId).watchable).toBe(true);
    });

    test("watchable videos can be filtered by channel", async () => {
        const [channelA, channelB] = [randomVideoId(), randomVideoId()];
        insertChannel(channelA, "A");
        insertChannel(channelB, "B");
        const videoA = newVideo(channelA);
        insertVideo(videoA);
        insertVideo(newVideo(channelB));
        expect(idsOf(getWatchableVideos(channelA, everything).videos)).toEqual([videoA.youtubeId]);
    });

    test("syncing again does not overwrite an explicit decision", async () => {
        const channel = randomVideoId();
        insertChannel(channel, "Piano");
        const video = newVideo(channel);
        insertVideo(video);
        blockVideo(video.youtubeId);
        insertVideo(video);
        expect(videoOf(video.youtubeId).rule).toBe("block");
    });

    test("unblocking returns to the channel rule when the channel is allowed", async () => {
        const channel = randomVideoId();
        insertChannel(channel, "Piano");
        const video = newVideo(channel);
        insertVideo(video);
        blockVideo(video.youtubeId);
        unblockVideo(video.youtubeId);
        const unblocked = videoOf(video.youtubeId);
        expect([unblocked.rule, unblocked.watchable]).toEqual(["inherit", true]);
    });

    test("unblocking keeps the video visible when its channel is not allowed", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        blockVideo(video.youtubeId);
        unblockVideo(video.youtubeId);
        const unblocked = videoOf(video.youtubeId);
        expect([unblocked.rule, unblocked.watchable]).toEqual(["allow", true]);
    });

    test("watchable channels lists only channels with visible videos", async () => {
        const [withVideo, empty] = [randomVideoId(), randomVideoId()];
        insertChannel(withVideo, "Has videos");
        insertChannel(empty, "No videos");
        insertVideo(newVideo(withVideo));
        expect(getWatchableChannels()).toEqual([{ youtubeId: withVideo, name: `Channel ${withVideo}` }]);
    });

    test("an unknown video is null", async () => {
        expect(getVideo(randomVideoId())).toBeNull();
    });
});

describe("watched", () => {
    test("the first report is kept and later ones change nothing", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        expect(videoOf(video.youtubeId).watchedAt).toBe(0);
        markWatched(video.youtubeId);
        advanceTime(60_000);
        markWatched(video.youtubeId);
        expect(videoOf(video.youtubeId).watchedAt).toBe(testStartSeconds);
    });

    test("unmarking clears it, and unknown videos are refused", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        markWatched(video.youtubeId);
        unmarkWatched(video.youtubeId);
        expect(videoOf(video.youtubeId).watchedAt).toBe(0);
        expect(() => markWatched(randomVideoId())).toThrow(NotFoundError);
        expect(() => unmarkWatched(randomVideoId())).toThrow(NotFoundError);
    });
});

describe("hiding watched videos", () => {
    test("watched videos can be left out of the list", async () => {
        const seen = newVideo("loose");
        const fresh = newVideo("loose");
        allowVideo(seen);
        allowVideo(fresh);
        markWatched(seen.youtubeId);
        expect(getWatchableVideos("", everything, true).videos.map((video) => video.youtubeId)).toEqual([
            fresh.youtubeId,
        ]);
        expect(getWatchableVideos("", everything).total).toBe(2);
    });

    test("recently watched lists the latest first, and leaves out blocked videos", async () => {
        const [first, second, third, hidden] = [newVideo("x"), newVideo("x"), newVideo("x"), newVideo("x")];
        for (const video of [first, second, third, hidden]) {
            allowVideo(video);
        }
        for (const video of [second, first, hidden, third]) {
            markWatched(video.youtubeId);
            advanceTime(1000);
        }
        blockVideo(hidden.youtubeId);
        expect(idsOf(getRecentlyWatched(everything).videos)).toEqual([
            third.youtubeId,
            first.youtubeId,
            second.youtubeId,
        ]);
    });
});

describe("recording plays", () => {
    test("plays are counted and the time is stamped", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        recordPlay(video.youtubeId);
        recordPlay(video.youtubeId);
        const played = videoOf(video.youtubeId);
        expect([played.playCount, played.lastPlayedAt]).toEqual([2, testStartSeconds]);
    });
});

describe("removing a video", () => {
    function allowedChannelVideo() {
        const channel = randomVideoId();
        insertChannel(channel, "Piano Guy");
        const video = newVideo(channel);
        insertVideo(video);
        keepFile(video.youtubeId, "/media/kept.mp4");
        cacheFile(video.youtubeId, "/cache/copy.mp4");
        return video;
    }

    test("removing returns both paths for cleanup", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        keepFile(video.youtubeId, "/media/a.mp4");
        cacheFile(video.youtubeId, "/cache/a.mp4");
        expect(deleteVideo(video.youtubeId)).toMatchObject({
            filePath: "/media/a.mp4",
            cachePath: "/cache/a.mp4",
        });
    });

    test("removing an unknown video reports not found", async () => {
        expect(() => deleteVideo(randomVideoId())).toThrow(NotFoundError);
    });

    test("removing a video of an allowed channel blocks it instead of deleting", async () => {
        const video = allowedChannelVideo();
        const removal = deleteVideo(video.youtubeId);
        expect(removal).toEqual({ filePath: "/media/kept.mp4", cachePath: "/cache/copy.mp4", blocked: true });
        expect(videoOf(video.youtubeId)).toMatchObject({
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
        const video = allowedChannelVideo();
        deleteVideo(video.youtubeId);
        insertVideo(video);
        expect(videoOf(video.youtubeId)).toMatchObject({ rule: "block", watchable: false });
    });

    test("removing an individually allowed video in an allowed channel still hides it", async () => {
        const channel = randomVideoId();
        insertChannel(channel, "Piano Guy");
        const video = newVideo(channel);
        allowVideo(video);
        deleteVideo(video.youtubeId);
        expect(videoOf(video.youtubeId).watchable).toBe(false);
    });

    test("removing a video outside any allowed channel deletes it", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        expect(deleteVideo(video.youtubeId).blocked).toBe(false);
        expect(getVideo(video.youtubeId)).toBeNull();
    });

    test("removing while downloading deletes a video outside any allowed channel", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        pinVideo(video.youtubeId);
        claimDownload();
        deleteVideo(video.youtubeId);
        expect(getVideo(video.youtubeId)).toBeNull();
    });

    test("removing leaves an in-flight download for the worker to discard", async () => {
        const channel = randomVideoId();
        insertChannel(channel, "Piano Guy");
        const video = newVideo(channel);
        insertVideo(video);
        pinVideo(video.youtubeId);
        claimDownload();
        deleteVideo(video.youtubeId);
        expect(videoOf(video.youtubeId)).toMatchObject({ pinned: false, downloadStatus: "downloading" });
        expect(finishDownload(video.youtubeId, "/media/late.mp4")).toBe(false);
    });
});

describe("paging and ordering", () => {
    function addNumberedVideos(channel: string, count: number) {
        insertChannel(channel, "Channel");
        return Array.from({ length: count }, (_, index) => {
            const video = newVideo(channel, { publishedAt: 1_000_001 + index });
            insertVideo(video);
            return video;
        });
    }

    test("watchable returns the requested page and the total", async () => {
        const videos = addNumberedVideos(randomVideoId(), 10);
        const page = getWatchableVideos("", { limit: 4, offset: 4 });
        expect(page.total).toBe(10);
        expect(idsOf(page.videos)).toEqual([5, 4, 3, 2].map((index) => videos[index]?.youtubeId) as VideoId[]);
    });

    test("a page beyond the end is empty but the total is reported", async () => {
        addNumberedVideos(randomVideoId(), 3);
        expect(getWatchableVideos("", { limit: 10, offset: 50 })).toEqual({ videos: [], total: 3 });
    });

    test("the total respects the channel filter", async () => {
        const channelB = randomVideoId();
        addNumberedVideos(randomVideoId(), 5);
        addNumberedVideos(channelB, 2);
        expect(getWatchableVideos(channelB, { limit: 10, offset: 0 }).total).toBe(2);
    });

    test("videos are ordered by publish date, not by when they were synced", async () => {
        const channel = randomVideoId();
        insertChannel(channel, "Channel");
        const synced = [300, 900, 600].map((publishedAt) => newVideo(channel, { publishedAt }));
        for (const video of synced) {
            insertVideo(video);
        }
        const [oldest, newest, middle] = synced.map((video) => video.youtubeId);
        expect([oldest, newest, middle]).not.toContain(undefined);
        expect(idsOf(getWatchableVideos("", everything).videos)).toEqual([newest, middle, oldest] as VideoId[]);
    });

    test("videos without a date follow dated ones, latest synced first", async () => {
        const channel = randomVideoId();
        insertChannel(channel, "Channel");
        const [undatedFirst, dated, undatedSecond] = [
            newVideo(channel),
            newVideo(channel, { publishedAt: 500 }),
            newVideo(channel),
        ];
        for (const video of [undatedFirst, dated, undatedSecond]) {
            insertVideo(video);
        }
        expect(idsOf(getWatchableVideos("", everything).videos)).toEqual([
            dated.youtubeId,
            undatedSecond.youtubeId,
            undatedFirst.youtubeId,
        ]);
    });

    test("admin videos page and count the listed videos", async () => {
        for (const video of Array.from({ length: 7 }, () => newVideo(randomVideoId()))) {
            allowVideo(video);
        }
        insertVideo(newVideo(randomVideoId()));
        const page = getAdminVideos("", { limit: 5, offset: 5 });
        expect([page.videos.length, page.total]).toEqual([2, 7]);
    });

    test("admin videos for a channel list every video of that channel", async () => {
        const channel = randomVideoId();
        const synced = newVideo(channel);
        insertVideo(synced);
        insertVideo(newVideo(randomVideoId()));
        expect(idsOf(getAdminVideos(channel, everything).videos)).toEqual([synced.youtubeId]);
    });

    test("admin videos include pinned and downloading videos", async () => {
        const synced = newVideo(randomVideoId());
        insertVideo(synced);
        pinVideo(synced.youtubeId);
        expect(idsOf(getAdminVideos("", everything).videos)).toEqual([synced.youtubeId]);
    });
});

describe("publish dates", () => {
    test("syncing fills in a missing publish date without changing the rule", async () => {
        const channel = randomVideoId();
        insertChannel(channel, "Channel");
        const video = newVideo(channel);
        insertVideo(video);
        blockVideo(video.youtubeId);
        insertVideo({ ...video, publishedAt: 1234 });
        expect(videoOf(video.youtubeId)).toMatchObject({ publishedAt: 1234, rule: "block" });
    });

    test("syncing never replaces a known date with an unknown one", async () => {
        const channel = randomVideoId();
        insertChannel(channel, "Channel");
        const video = newVideo(channel, { publishedAt: 777 });
        insertVideo(video);
        insertVideo({ ...video, publishedAt: 0 });
        expect(videoOf(video.youtubeId).publishedAt).toBe(777);
    });

    test("allowing keeps a known publish date when the new one is unknown", async () => {
        const video = newVideo(randomVideoId(), { publishedAt: 555 });
        allowVideo(video);
        allowVideo({ ...video, publishedAt: 0 });
        expect(videoOf(video.youtubeId).publishedAt).toBe(555);
    });

    test("allowing an already synced video makes it explicitly allowed", async () => {
        const video = newVideo(randomVideoId());
        insertVideo(video);
        allowVideo({ ...video, title: "Renamed" });
        expect(videoOf(video.youtubeId)).toMatchObject({ rule: "allow", title: "Renamed" });
    });
});
