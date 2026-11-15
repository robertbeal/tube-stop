import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { stubYtDlp, temporaryDirectory, testVideoId } from "../../tests/helpers.ts";
import { config } from "../shared/config.ts";
import * as channelQueries from "../shared/db/channels.ts";
import { getChannels, insertChannel } from "../shared/db/channels.ts";
import type { Channel } from "../shared/db/types.ts";
import { blockVideo, getVideo, getWatchableVideos, insertVideo } from "../shared/db/videos.ts";
import { logger } from "../shared/logger.ts";
import { runSync, syncChannels } from "./sync.ts";

const everything = { limit: 1000, offset: 0 };
const neverAborted = new AbortController().signal;

/** yt-dlp listing, newest first. */
const listing = `{"_type":"playlist","entries":[
 {"id":"newestvideo","title":"Newest","duration":30},
 {"id":"middlevideo","title":"Middle"},
 {"id":"oldestvideo","title":"Oldest","duration":10}]}`;

/** A fake yt-dlp that prints the given JSON, and the path to run it. */
async function ytDlpPrinting(json: string) {
    return stubYtDlp(`cat <<'EOF'\n${json}\nEOF`);
}

const titlesOf = () => getWatchableVideos("", everything).videos.map((video) => video.title);

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
        insertChannel("UC1", "Piano Guy");

        config.ytdlpBin = (await ytDlpPrinting(listing)).binary;
        await syncChannels(neverAborted);

        expect(titlesOf()).toEqual(["Newest", "Middle", "Oldest"]);
    });

    test("adds channel videos as watchable, with the channel's name and the video's duration", async () => {
        insertChannel("UC1", "Piano Guy");

        config.ytdlpBin = (await ytDlpPrinting(listing)).binary;
        await syncChannels(neverAborted);

        const videos = getWatchableVideos("", everything).videos;
        expect(videos).toHaveLength(3);
        expect(videos[0]?.channelName).toBe("Piano Guy");
        expect(videos[0]?.duration).toBe(30);
    });

    test("is idempotent and keeps blocked videos blocked", async () => {
        insertChannel("UC1", "Piano Guy");
        const { binary } = await ytDlpPrinting(listing);
        config.ytdlpBin = binary;
        await syncChannels(neverAborted);
        blockVideo(testVideoId("middlevideo"));

        config.ytdlpBin = binary;
        await syncChannels(neverAborted);

        expect(titlesOf()).toEqual(["Newest", "Oldest"]);
    });

    test("marks the channel as synced", async () => {
        insertChannel("UC1", "Piano Guy");

        config.ytdlpBin = (await ytDlpPrinting(listing)).binary;
        await syncChannels(neverAborted);
        config.ytdlpBin = (await ytDlpPrinting(listing)).binary;
        await syncChannels(neverAborted);

        const [channel] = getChannels();
        expect(channel?.lastSyncedAt).toBeGreaterThan(0);
        expect(channel?.videoCount).toBe(3);
    });

    test("a failure leaves existing videos and the sync time untouched", async () => {
        insertChannel("UC1", "Piano Guy");
        insertVideo({
            youtubeId: testVideoId("existingvid"),
            channelYoutubeId: "UC1",
            channelName: "Piano Guy",
            title: "Existing",
            duration: 0,
            publishedAt: 0,
        });
        const failing = await stubYtDlp("echo 'ERROR: offline' >&2\nexit 1");

        config.ytdlpBin = failing.binary;
        await syncChannels(neverAborted);

        expect(titlesOf()).toEqual(["Existing"]);
        expect(getChannels()[0]?.lastSyncedAt).toBe(0);
    });

    test("one broken channel does not stop the others", async () => {
        insertChannel("UC1", "Broken");
        insertChannel("UC2", "Healthy");
        const oneBroken = await stubYtDlp(
            `case "$*" in *UC1*) echo 'ERROR: nope' >&2; exit 1;; esac\ncat <<'EOF'\n${listing}\nEOF`,
        );

        config.ytdlpBin = oneBroken.binary;
        await syncChannels(neverAborted);

        const syncedByName = Object.fromEntries(
            getChannels().map((channel: Channel) => [channel.name, channel.lastSyncedAt > 0]),
        );
        expect(syncedByName).toEqual({ Broken: false, Healthy: true });
    });

    test("stops when the signal is aborted", async () => {
        insertChannel("UC1", "Piano Guy");

        config.ytdlpBin = (await ytDlpPrinting(listing)).binary;
        await syncChannels(AbortSignal.abort());

        expect(titlesOf()).toEqual([]);
    });

    test("looks at the channel's 50 most recent videos only", async () => {
        insertChannel("UC1", "Piano Guy");
        const stub = await ytDlpPrinting(`{"_type":"playlist","entries":[]}`);

        config.ytdlpBin = stub.binary;
        await syncChannels(neverAborted);

        const joined = (await stub.arguments()).join(" ");
        expect(joined).toContain("/channel/UC1/videos");
        expect(joined).toContain("--playlist-end 50");
    });

    test("uses the video id when YouTube gives no title", async () => {
        insertChannel("UC1", "Piano Guy");
        const untitled = await ytDlpPrinting(`{"_type":"playlist","entries":[{"id":"untitledvid","title":""}]}`);

        config.ytdlpBin = untitled.binary;
        await syncChannels(neverAborted);

        expect(getVideo(testVideoId("untitledvid"))?.title).toBe("untitledvid");
    });

    test("a database failure is logged and the run ends without calling YouTube", async () => {
        const stub = await ytDlpPrinting(listing);
        config.ytdlpBin = stub.binary;

        const errors = spyOn(logger, "error");
        spyOn(channelQueries, "getChannels").mockImplementation(() => {
            throw new Error("database is closed");
        });
        await syncChannels(neverAborted);

        expect(errors.mock.calls).toHaveLength(1);
        expect(errors.mock.calls[0]?.[0]).toStartWith("sync: ");
        await expect(stub.arguments()).rejects.toThrow(); // yt-dlp never ran, so it never recorded its arguments
    });

    test("shows videos in publish order even when YouTube lists them differently", async () => {
        insertChannel("UC1", "Piano Guy");
        const dated = await ytDlpPrinting(`{"_type":"playlist","entries":[
 {"id":"middlevideo","title":"Published second","timestamp":200},
 {"id":"newestvideo","title":"Published third","timestamp":300},
 {"id":"oldestvideo","title":"Published first","timestamp":100}]}`);

        config.ytdlpBin = dated.binary;
        await syncChannels(neverAborted);

        expect(titlesOf()).toEqual(["Published third", "Published second", "Published first"]);
    });

    test("fills in dates for videos synced before they were known", async () => {
        insertChannel("UC1", "Piano Guy");
        insertVideo({
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

        config.ytdlpBin = dated.binary;
        await syncChannels(neverAborted);

        expect(getVideo(testVideoId("oldvideoaaa"))?.publishedAt).toBe(4242);
    });
});

describe("run", () => {
    test("syncs straight away and stops when aborted", async () => {
        insertChannel("UC1", "Piano Guy");
        const { binary } = await ytDlpPrinting(listing);
        config.ytdlpBin = binary;

        const controller = new AbortController();
        const running = runSync(controller.signal);
        await waitFor("run to sync the channel", () => titlesOf().length === 3);
        controller.abort();

        await running;
    });

    test("syncs again on every interval", async () => {
        insertChannel("UC1", "Piano Guy");
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

        config.ytdlpBin = counting.binary;
        config.syncIntervalMs = 20;
        const controller = new AbortController();
        const running = runSync(controller.signal);
        await waitFor("a third sync", async () => (await calls()) >= 3);
        controller.abort();

        await running;
    });
});
