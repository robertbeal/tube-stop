import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { temporaryDirectory, testVideoId } from "../../tests/helpers.ts";
import { config } from "../shared/config.ts";
import { getChannels, insertChannel } from "../shared/db/channels.ts";
import { allowVideo, getVideo } from "../shared/db/videos.ts";
import { resetAdmin } from "./reset.ts";
import { countUsers, createFirstUser, getUserByUsername } from "./users.ts";

const videoId = testVideoId("abcdefghijk");

function addOneAdminAndOneVideo(): void {
    createFirstUser("parent", "some-hash");
    insertChannel("UCchannelchannelchannelaa", "Music");
    allowVideo({
        youtubeId: videoId,
        channelYoutubeId: "UCchannelchannelchannelaa",
        channelName: "Music",
        title: "Song",
        duration: 60,
        publishedAt: 0,
    });
}

function collectOutput(): { lines: string[]; output: (line: string) => void } {
    const lines: string[] = [];
    return { lines, output: (line) => lines.push(line) };
}

describe("resetAdmin", () => {
    test("removes the account and reports what was kept", async () => {
        addOneAdminAndOneVideo();
        const { lines, output } = collectOutput();

        await resetAdmin(output);

        const text = lines.join("\n");
        expect(text).toContain("Removed the admin account");
        expect(text).toContain("kept");
        expect(text).toContain("setup code");
        expect(countUsers()).toBe(0);
        expect(getUserByUsername("parent")).toBeNull();
    });

    test("keeps videos and channels", async () => {
        addOneAdminAndOneVideo();

        await resetAdmin(() => {});

        expect(getVideo(videoId)?.title).toBe("Song");
        expect(getChannels().map((channel) => channel.name)).toEqual(["Music"]);
    });

    test("says so when there is no account left to remove", async () => {
        addOneAdminAndOneVideo();
        await resetAdmin(() => {});
        const { lines, output } = collectOutput();

        await resetAdmin(output);

        expect(lines.join("\n")).toContain("no admin account");
    });

    test("explains where it looked when there is no database", async () => {
        const dataDir = await temporaryDirectory();
        config.dataDir = dataDir;

        await expect(resetAdmin(() => {})).rejects.toThrow(/DATA_DIR/);
        await expect(resetAdmin(() => {})).rejects.toThrow(dataDir);
    });

    test("does not create a database as a side effect", async () => {
        const dataDir = await temporaryDirectory();
        config.dataDir = dataDir;

        await expect(resetAdmin(() => {})).rejects.toThrow();

        expect(await readdir(dataDir)).toEqual([]);
    });
});
