import { describe, expect, spyOn, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory, testVideoId, stubYtDlp as writeStub } from "../tests/helpers.ts";
import {
    blockVideo,
    type Channel,
    closeStore,
    getChannels,
    getVideo,
    getWatchableVideos,
    insertChannel,
    insertVideo,
    openStore,
    type Store,
} from "./db/store.ts";
import { logger } from "./logger.ts";
import { runSync, type Syncer, syncAll } from "./syncer.ts";
import { getChannelVideos } from "./ytdlp/resolve.ts";
import type { Video } from "./ytdlp/types.ts";

const everything = { limit: 1000, offset: 0 };
const neverAborted = new AbortController().signal;
const hour = 60 * 60 * 1000;

/** yt-dlp listing, newest first. */
const listing = `{"_type":"playlist","entries":[
 {"id":"newestvideo","title":"Newest","duration":30},
 {"id":"middlevideo","title":"Middle"},
 {"id":"oldestvideo","title":"Oldest","duration":10}]}`;

async function newStore(): Promise<Store> {
    return openStore(join(await temporaryDirectory(), "tubestop.db"));
}

async function ytDlpPrinting(body: string) {
    const stub = await writeStub(body);
    await chmod(stub.binary, 0o755); // Bun.write ignores its mode option on some versions
    return getChannelVideos.bind(null, stub.binary);
}

const printing = (json: string) => `cat <<'EOF'\n${json}\nEOF`;

function syncerFor(store: Store, getChannelVideos: Syncer["getChannelVideos"]): Syncer {
    return { store, getChannelVideos, intervalMs: hour };
}

function fakeLister(videos: Video[] = []) {
    const calls: { channelId: string; limit: number }[] = [];
    const lister = async (channelId: string, limit: number) => {
        calls.push({ channelId, limit });
        return videos;
    };
    return { lister, calls };
}

const titlesOf = (store: Store) => getWatchableVideos(store, "", everything).videos.map((video) => video.title);

function listed(overrides: Partial<Video>): Video {
    return {
        id: testVideoId("abcdefghijk"),
        title: "t",
        channel: { id: "", name: "" },
        duration: 0,
        publishedAt: 0,
        ...overrides,
    };
}

async function waitFor(description: string, condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${description}`);
        }
        await Bun.sleep(10);
    }
}

describe("syncAll", () => {
    test("adds channel videos as watchable, newest first", async () => {
        const store = await newStore();
        insertChannel(store, "UC1", "Piano Guy");

        await syncAll(syncerFor(store, await ytDlpPrinting(printing(listing))), neverAborted);

        const videos = getWatchableVideos(store, "", everything).videos;
        expect(videos.map((video) => video.title)).toEqual(["Newest", "Middle", "Oldest"]);
        expect(videos[0]?.channelName).toBe("Piano Guy");
        expect(videos[0]?.duration).toBe(30);
    });

    test("is idempotent and keeps blocked videos blocked", async () => {
        const store = await newStore();
        insertChannel(store, "UC1", "Piano Guy");
        const syncer = syncerFor(store, await ytDlpPrinting(printing(listing)));
        await syncAll(syncer, neverAborted);
        blockVideo(store, testVideoId("middlevideo"));

        await syncAll(syncer, neverAborted);

        expect(titlesOf(store)).toEqual(["Newest", "Oldest"]);
    });

    test("marks the channel as synced", async () => {
        const store = await newStore();
        insertChannel(store, "UC1", "Piano Guy");

        await syncAll(syncerFor(store, await ytDlpPrinting(printing(listing))), neverAborted);

        const [channel] = getChannels(store);
        expect(channel?.lastSyncedAt).toBeGreaterThan(0);
        expect(channel?.videoCount).toBe(3);
    });

    test("a failure leaves existing videos and the sync time untouched", async () => {
        const store = await newStore();
        insertChannel(store, "UC1", "Piano Guy");
        insertVideo(store, {
            youtubeId: testVideoId("existingvid"),
            channelYoutubeId: "UC1",
            channelName: "Piano Guy",
            title: "Existing",
            duration: 0,
            publishedAt: 0,
        });

        await syncAll(syncerFor(store, await ytDlpPrinting("echo 'ERROR: offline' >&2\nexit 1")), neverAborted);

        expect(titlesOf(store)).toEqual(["Existing"]);
        expect(getChannels(store)[0]?.lastSyncedAt).toBe(0);
    });

    test("one broken channel does not stop the others", async () => {
        const store = await ytDlpPrinting(
            `case "$*" in *UC1*) echo 'ERROR: nope' >&2; exit 1;; esac\n${printing(listing)}`,
        ).then(async (client) => {
            const database = await newStore();
            insertChannel(database, "UC1", "Broken");
            insertChannel(database, "UC2", "Healthy");
            await syncAll(syncerFor(database, client), neverAborted);
            return database;
        });

        const syncedByName = Object.fromEntries(
            getChannels(store).map((channel: Channel) => [channel.name, channel.lastSyncedAt > 0]),
        );
        expect(syncedByName).toEqual({ Broken: false, Healthy: true });
    });

    test("stops when the signal is aborted", async () => {
        const store = await newStore();
        insertChannel(store, "UC1", "Piano Guy");

        await syncAll(syncerFor(store, await ytDlpPrinting(printing(listing))), AbortSignal.abort());

        expect(titlesOf(store)).toEqual([]);
    });

    test("looks at the channel's 50 most recent videos only", async () => {
        const store = await newStore();
        insertChannel(store, "UC1", "Piano Guy");
        const { lister, calls } = fakeLister();

        await syncAll(syncerFor(store, lister), neverAborted);

        expect(calls).toEqual([{ channelId: "UC1", limit: 50 }]);
    });

    test("uses the video id when YouTube gives no title", async () => {
        const store = await newStore();
        insertChannel(store, "UC1", "Piano Guy");
        const { lister } = fakeLister([listed({ id: testVideoId("untitledvid"), title: "" })]);

        await syncAll(syncerFor(store, lister), neverAborted);

        expect(getVideo(store, testVideoId("untitledvid"))?.title).toBe("untitledvid");
    });

    test("a database failure is logged and the run ends without calling YouTube", async () => {
        const { lister, calls } = fakeLister();
        const brokenStore = await newStore();
        closeStore(brokenStore);

        const errors = spyOn(logger, "error");
        const syncer: Syncer = { store: brokenStore, getChannelVideos: lister, intervalMs: hour };
        await syncAll(syncer, neverAborted);

        expect(errors.mock.calls).toHaveLength(1);
        expect(errors.mock.calls[0]?.[0]).toStartWith("sync: ");
        expect(calls).toEqual([]);
    });

    test("shows videos in publish order even when YouTube lists them differently", async () => {
        const store = await newStore();
        insertChannel(store, "UC1", "Piano Guy");
        const datedListing = `{"_type":"playlist","entries":[
 {"id":"middlevideo","title":"Published second","timestamp":200},
 {"id":"newestvideo","title":"Published third","timestamp":300},
 {"id":"oldestvideo","title":"Published first","timestamp":100}]}`;

        await syncAll(syncerFor(store, await ytDlpPrinting(printing(datedListing))), neverAborted);

        expect(titlesOf(store)).toEqual(["Published third", "Published second", "Published first"]);
    });

    test("fills in dates for videos synced before they were known", async () => {
        const store = await newStore();
        insertChannel(store, "UC1", "Piano Guy");
        insertVideo(store, {
            youtubeId: testVideoId("oldvideoaaa"),
            channelYoutubeId: "UC1",
            channelName: "Piano Guy",
            title: "Old",
            duration: 0,
            publishedAt: 0,
        });
        const { lister } = fakeLister([listed({ id: testVideoId("oldvideoaaa"), title: "Old", publishedAt: 4242 })]);

        await syncAll(syncerFor(store, lister), neverAborted);

        expect(getVideo(store, testVideoId("oldvideoaaa"))?.publishedAt).toBe(4242);
    });
});

describe("run", () => {
    test("syncs straight away and stops when aborted", async () => {
        const store = await newStore();
        insertChannel(store, "UC1", "Piano Guy");
        const syncer = syncerFor(store, await ytDlpPrinting(printing(listing)));

        const controller = new AbortController();
        const running = runSync(syncer, controller.signal);
        await waitFor("run to sync the channel", () => titlesOf(store).length === 3);
        controller.abort();

        await running;
    });

    test("syncs again on every interval", async () => {
        const store = await newStore();
        insertChannel(store, "UC1", "Piano Guy");
        const { lister, calls } = fakeLister();
        const syncer: Syncer = { store, getChannelVideos: lister, intervalMs: 20 };

        const controller = new AbortController();
        const running = runSync(syncer, controller.signal);
        await waitFor("a third sync", () => calls.length >= 3);
        controller.abort();

        await running;
    });
});
