import type { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { stubYtDlp, temporaryDirectory, testVideoId } from "../tests/helpers.ts";
import { getChannels, insertChannel } from "./db/channels.ts";
import { openDatabase } from "./db/database.ts";
import type { Channel } from "./db/types.ts";
import { blockVideo, getVideo, getWatchableVideos, insertVideo } from "./db/videos.ts";
import { logger } from "./logger.ts";
import { runSync, syncChannels } from "./syncer.ts";

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

/** A fake yt-dlp that prints the given JSON, and the path to run it. */
async function ytDlpPrinting(json: string) {
    return stubYtDlp(`cat <<'EOF'\n${json}\nEOF`);
}

const titlesOf = (database: Database) =>
    getWatchableVideos(database, "", everything).videos.map((video) => video.title);

async function waitFor(description: string, condition: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = performance.now() + 5000;
    while (!(await condition())) {
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

        await syncChannels(database, (await ytDlpPrinting(listing)).binary, neverAborted);

        expect(titlesOf(database)).toEqual(["Newest", "Middle", "Oldest"]);
    });

    test("adds channel videos as watchable, with the channel's name and the video's duration", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");

        await syncChannels(database, (await ytDlpPrinting(listing)).binary, neverAborted);

        const videos = getWatchableVideos(database, "", everything).videos;
        expect(videos).toHaveLength(3);
        expect(videos[0]?.channelName).toBe("Piano Guy");
        expect(videos[0]?.duration).toBe(30);
    });

    test("is idempotent and keeps blocked videos blocked", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");
        const { binary } = await ytDlpPrinting(listing);
        await syncChannels(database, binary, neverAborted);
        blockVideo(database, testVideoId("middlevideo"));

        await syncChannels(database, binary, neverAborted);

        expect(titlesOf(database)).toEqual(["Newest", "Oldest"]);
    });

    test("marks the channel as synced", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");

        await syncChannels(database, (await ytDlpPrinting(listing)).binary, neverAborted);
        await syncChannels(database, (await ytDlpPrinting(listing)).binary, neverAborted);

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
        const failing = await stubYtDlp("echo 'ERROR: offline' >&2\nexit 1");

        await syncChannels(database, failing.binary, neverAborted);

        expect(titlesOf(database)).toEqual(["Existing"]);
        expect(getChannels(database)[0]?.lastSyncedAt).toBe(0);
    });

    test("one broken channel does not stop the others", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Broken");
        insertChannel(database, "UC2", "Healthy");
        const oneBroken = await stubYtDlp(
            `case "$*" in *UC1*) echo 'ERROR: nope' >&2; exit 1;; esac\ncat <<'EOF'\n${listing}\nEOF`,
        );

        await syncChannels(database, oneBroken.binary, neverAborted);

        const syncedByName = Object.fromEntries(
            getChannels(database).map((channel: Channel) => [channel.name, channel.lastSyncedAt > 0]),
        );
        expect(syncedByName).toEqual({ Broken: false, Healthy: true });
    });

    test("stops when the signal is aborted", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");

        await syncChannels(database, (await ytDlpPrinting(listing)).binary, AbortSignal.abort());

        expect(titlesOf(database)).toEqual([]);
    });

    test("looks at the channel's 50 most recent videos only", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");
        const stub = await ytDlpPrinting(`{"_type":"playlist","entries":[]}`);

        await syncChannels(database, stub.binary, neverAborted);

        const joined = (await stub.arguments()).join(" ");
        expect(joined).toContain("/channel/UC1/videos");
        expect(joined).toContain("--playlist-end 50");
    });

    test("uses the video id when YouTube gives no title", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");
        const untitled = await ytDlpPrinting(`{"_type":"playlist","entries":[{"id":"untitledvid","title":""}]}`);

        await syncChannels(database, untitled.binary, neverAborted);

        expect(getVideo(database, testVideoId("untitledvid"))?.title).toBe("untitledvid");
    });

    test("a database failure is logged and the run ends without calling YouTube", async () => {
        const brokenDatabase = await newDatabase();
        brokenDatabase.close();
        const stub = await ytDlpPrinting(listing);

        const errors = spyOn(logger, "error");
        await syncChannels(brokenDatabase, stub.binary, neverAborted);

        expect(errors.mock.calls).toHaveLength(1);
        expect(errors.mock.calls[0]?.[0]).toStartWith("sync: ");
        await expect(stub.arguments()).rejects.toThrow(); // yt-dlp never ran, so it never recorded its arguments
    });

    test("shows videos in publish order even when YouTube lists them differently", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");
        const dated = await ytDlpPrinting(`{"_type":"playlist","entries":[
 {"id":"middlevideo","title":"Published second","timestamp":200},
 {"id":"newestvideo","title":"Published third","timestamp":300},
 {"id":"oldestvideo","title":"Published first","timestamp":100}]}`);

        await syncChannels(database, dated.binary, neverAborted);

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
        const dated = await ytDlpPrinting(
            `{"_type":"playlist","entries":[{"id":"oldvideoaaa","title":"Old","timestamp":4242}]}`,
        );

        await syncChannels(database, dated.binary, neverAborted);

        expect(getVideo(database, testVideoId("oldvideoaaa"))?.publishedAt).toBe(4242);
    });
});

describe("run", () => {
    test("syncs straight away and stops when aborted", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");
        const { binary } = await ytDlpPrinting(listing);

        const controller = new AbortController();
        const running = runSync(database, binary, hour, controller.signal);
        await waitFor("run to sync the channel", () => titlesOf(database).length === 3);
        controller.abort();

        await running;
    });

    test("syncs again on every interval", async () => {
        const database = await newDatabase();
        insertChannel(database, "UC1", "Piano Guy");
        const callsFile = join(await temporaryDirectory(), "calls.txt");
        const counting = await stubYtDlp(`echo called >> '${callsFile}'\necho '{"_type":"playlist","entries":[]}'`);
        const calls = async () =>
            (
                await Bun.file(callsFile)
                    .text()
                    .catch(() => "")
            )
                .split("\n")
                .filter(Boolean).length;

        const controller = new AbortController();
        const running = runSync(database, counting.binary, 20, controller.signal);
        await waitFor("a third sync", async () => (await calls()) >= 3);
        controller.abort();

        await running;
    });
});
