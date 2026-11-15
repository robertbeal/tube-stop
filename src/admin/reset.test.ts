import { describe, expect, test } from "bun:test";
import { testVideoId } from "../../tests/helpers.ts";
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
    test("removes the account and reports what was kept", () => {
        addOneAdminAndOneVideo();
        const { lines, output } = collectOutput();

        resetAdmin(output);

        const text = lines.join("\n");
        expect(text).toContain("Removed the admin account");
        expect(text).toContain(config.dataDir);
        expect(text).toContain("kept");
        expect(text).toContain("setup code");
        expect(countUsers()).toBe(0);
        expect(getUserByUsername("parent")).toBeNull();
    });

    test("keeps videos and channels", () => {
        addOneAdminAndOneVideo();

        resetAdmin(() => {});

        expect(getVideo(videoId)?.title).toBe("Song");
        expect(getChannels().map((channel) => channel.name)).toEqual(["Music"]);
    });

    test("says so when there is no account left to remove", () => {
        addOneAdminAndOneVideo();
        resetAdmin(() => {});
        const { lines, output } = collectOutput();

        resetAdmin(output);

        expect(lines.join("\n")).toContain("no admin account");
    });
});
