import type { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory, testVideoId, stubYtDlp as writeStub } from "../tests/helpers.ts";
import { getChannels, insertChannel } from "./db/channels.ts";
import { openDatabase } from "./db/database.ts";
import type { Channel } from "./db/types.ts";
import { blockVideo, getVideo, getWatchableVideos, insertVideo } from "./db/videos.ts";
import { logger } from "./logger.ts";
import { runSync, type Syncer, syncChannels } from "./syncer.ts";
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

async function newDatabase(): Promise<Database> {
    return openDatabase(join(await temporaryDirectory(), "tubestop.db"));
}

async function ytDlpPrinting(body: string) {
    const stub = await writeStub(body);
    await chmod(stub.binary, 0o755); // Bun.write ignores its mode option on some versions
    return getChannelVideos.bind(null, stub.binary);
}

const printing = (json: string) => `cat <<'EOF'\n${json}\nEOF`;

function syncerFor(database: Database, getChannelVideos: Syncer["getChannelVideos"]): Syncer {
    return { database, getChannelVideos, intervalMs: hour };
}

function fakeLister(videos: Video[] = []) {
    const calls: { channelId: string; limit: number }[] = [];
    const lister = async (channelId: string, limit: number) => {
        calls.push({ channelId, limit });
        return videos;
    };
    return { lister, calls };
}

const titlesOf = (database: Database) =>
    getWatchableVideos(database, "", everything).videos.map((video) => video.title);

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
    const deadline = performance.now() + 5000;
    while (!condition()) {
        if (performance.now() > deadline) {
            throw new Error(`timed out waiting for ${description}`);
        }
        await Bun.sleep(10);
    }
}

describe("syncChannels", () => {
    test("videos without dates are shown in the order YouTube lists them, newest first", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");

        await syncChannels(syncerFor(database, await ytDlpPrinting(printing(listing))), neverAborted);

        expect(titlesOf(database)).toEqual(["Newest", "Middle", "Oldest"]);
    });

    test("adds channel videos as watchable, with the channel's name and the video's duration", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");

        await syncChannels(syncerFor(database, await ytDlpPrinting(printing(listing))), neverAborted);

        const videos = getWatchableVideos(database, "", everything).videos;
        expect(videos).toHaveLength(3);
        expect(videos[0]?.channelName).toBe("Piano Guy");
        expect(videos[0]?.duration).toBe(30);
    });

    test("is idempotent and keeps blocked videos blocked", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");
        const syncer = syncerFor(database, await ytDlpPrinting(printing(listing)));
        await syncChannels(syncer, neverAborted);
        blockVideo(database, testVideoId("middlevideo"));

        await syncChannels(syncer, neverAborted);

        expect(titlesOf(database)).toEqual(["Newest", "Oldest"]);
    });

    test("marks the channel as synced", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");

        await syncChannels(syncerFor(database, await ytDlpPrinting(printing(listing))), neverAborted);

        const [channel] = getChannels(database);
        expect(channel?.lastSyncedAt).toBeGreaterThan(0);
        expect(channel?.videoCount).toBe(3);
    });

    test("a failure leaves existing videos and the sync time untouched", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");
        insertVideo(database, {
            youtubeId: testVideoId("existingvid"),
            channelYoutubeId: "UC1",
            channelName: "Piano Guy",
            title: "Existing",
            duration: 0,
            publishedAt: 0,
        });

        await syncChannels(syncerFor(database, await ytDlpPrinting("echo 'ERROR: offline' >&2\nexit 1")), neverAborted);

        expect(titlesOf(database)).toEqual(["Existing"]);
        expect(getChannels(database)[0]?.lastSyncedAt).toBe(0);
    });

    test("one broken channel does not stop the others", async () => {
        const database = await ytDlpPrinting(
            `case "$*" in *UC1*) echo 'ERROR: nope' >&2; exit 1;; esac\n${printing(listing)}`,
        ).then(async (client) => {
            const database = await newDatabase();
            insertChannel(database, "UC1", "Broken");
            insertChannel(database, "UC2", "Healthy");
            await syncChannels(syncerFor(database, client), neverAborted);
            return database;
        });

        const syncedByName = Object.fromEntries(
            getChannels(database).map((channel: Channel) => [channel.name, channel.lastSyncedAt > 0]),
        );
        expect(syncedByName).toEqual({ Broken: false, Healthy: true });
    });

    test("stops when the signal is aborted", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");

        await syncChannels(syncerFor(database, await ytDlpPrinting(printing(listing))), AbortSignal.abort());

        expect(titlesOf(database)).toEqual([]);
    });

    test("looks at the channel's 50 most recent videos only", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");
        const { lister, calls } = fakeLister();

        await syncChannels(syncerFor(database, lister), neverAborted);

        expect(calls).toEqual([{ channelId: "UC1", limit: 50 }]);
    });

    test("uses the video id when YouTube gives no title", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");
        const { lister } = fakeLister([listed({ id: testVideoId("untitledvid"), title: "" })]);

        await syncChannels(syncerFor(database, lister), neverAborted);

        expect(getVideo(database, testVideoId("untitledvid"))?.title).toBe("untitledvid");
    });

    test("a database failure is logged and the run ends without calling YouTube", async () => {
        const { lister, calls } = fakeLister();
        const brokenDatabase = await newDatabase();
        brokenDatabase.close();

        const errors = spyOn(logger, "error");
        const syncer: Syncer = { database: brokenDatabase, getChannelVideos: lister, intervalMs: hour };
        await syncChannels(syncer, neverAborted);

        expect(errors.mock.calls).toHaveLength(1);
        expect(errors.mock.calls[0]?.[0]).toStartWith("sync: ");
        expect(calls).toEqual([]);
    });

    test("shows videos in publish order even when YouTube lists them differently", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");
        const datedListing = `{"_type":"playlist","entries":[
 {"id":"middlevideo","title":"Published second","timestamp":200},
 {"id":"newestvideo","title":"Published third","timestamp":300},
 {"id":"oldestvideo","title":"Published first","timestamp":100}]}`;

        await syncChannels(syncerFor(database, await ytDlpPrinting(printing(datedListing))), neverAborted);

        expect(titlesOf(database)).toEqual(["Published third", "Published second", "Published first"]);
    });

    test("fills in dates for videos synced before they were known", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");
        insertVideo(database, {
            youtubeId: testVideoId("oldvideoaaa"),
            channelYoutubeId: "UC1",
            channelName: "Piano Guy",
            title: "Old",
            duration: 0,
            publishedAt: 0,
        });
        const { lister } = fakeLister([listed({ id: testVideoId("oldvideoaaa"), title: "Old", publishedAt: 4242 })]);

        await syncChannels(syncerFor(database, lister), neverAborted);

        expect(getVideo(database, testVideoId("oldvideoaaa"))?.publishedAt).toBe(4242);
    });
});

describe("run", () => {
    test("syncs straight away and stops when aborted", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");
        const syncer = syncerFor(database, await ytDlpPrinting(printing(listing)));

        const controller = new AbortController();
        const running = runSync(syncer, controller.signal);
        await waitFor("run to sync the channel", () => titlesOf(database).length === 3);
        controller.abort();

        await running;
    });

    test("syncs again on every interval", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");
        const { lister, calls } = fakeLister();
        const syncer: Syncer = { database, getChannelVideos: lister, intervalMs: 20 };

        const controller = new AbortController();
        const running = runSync(syncer, controller.signal);
        await waitFor("a third sync", () => calls.length >= 3);
        controller.abort();

        await running;
    });
});
