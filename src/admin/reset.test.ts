import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory, testVideoId } from "../../tests/helpers.ts";
import { getChannels, insertChannel } from "../db/channels.ts";
import { openDatabase } from "../db/open.ts";
import { allowVideo, getVideo } from "../db/videos.ts";
import { resetAdmin } from "./reset.ts";
import { countUsers, createFirstUser, getUserByUsername } from "./users.ts";

const videoId = testVideoId("abcdefghijk");

async function dataDirectoryWithOneAdminAndOneVideo(): Promise<string> {
    const dataDir = await temporaryDirectory();
    const database = openDatabase(join(dataDir, "tubestop.db"));
    createFirstUser(database, "parent", "some-hash");
    insertChannel(database, "UCchannelchannelchannelaa", "Music");
    allowVideo(database, {
        youtubeId: videoId,
        channelYoutubeId: "UCchannelchannelchannelaa",
        channelName: "Music",
        title: "Song",
        duration: 60,
        publishedAt: 0,
    });
    database.close();
    return dataDir;
}

function collectOutput(): { lines: string[]; output: (line: string) => void } {
    const lines: string[] = [];
    return { lines, output: (line) => lines.push(line) };
}

describe("resetAdmin", () => {
    test("removes the account and reports what was kept", async () => {
        const dataDir = await dataDirectoryWithOneAdminAndOneVideo();
        const { lines, output } = collectOutput();

        resetAdmin(dataDir, output);

        const text = lines.join("\n");
        expect(text).toContain("Removed the admin account");
        expect(text).toContain("kept");
        expect(text).toContain("setup code");
        const database = openDatabase(join(dataDir, "tubestop.db"));
        expect(countUsers(database)).toBe(0);
        expect(getUserByUsername(database, "parent")).toBeNull();
        database.close();
    });

    test("keeps videos and channels", async () => {
        const dataDir = await dataDirectoryWithOneAdminAndOneVideo();

        resetAdmin(dataDir, () => {});

        const database = openDatabase(join(dataDir, "tubestop.db"));
        expect(getVideo(database, videoId)?.title).toBe("Song");
        expect(getChannels(database).map((channel) => channel.name)).toEqual(["Music"]);
        database.close();
    });

    test("says so when there is no account left to remove", async () => {
        const dataDir = await dataDirectoryWithOneAdminAndOneVideo();
        resetAdmin(dataDir, () => {});
        const { lines, output } = collectOutput();

        resetAdmin(dataDir, output);

        expect(lines.join("\n")).toContain("no admin account");
    });

    test("explains where it looked when there is no database", async () => {
        const dataDir = await temporaryDirectory();

        expect(() => resetAdmin(dataDir, () => {})).toThrow(/DATA_DIR/);
        expect(() => resetAdmin(dataDir, () => {})).toThrow(dataDir);
    });

    test("does not create a database as a side effect", async () => {
        const dataDir = await temporaryDirectory();

        expect(() => resetAdmin(dataDir, () => {})).toThrow();

        expect(await readdir(dataDir)).toEqual([]);
    });
});
