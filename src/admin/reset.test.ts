import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory, testVideoId } from "../../tests/helpers.ts";
import { allowVideo, closeStore, getChannels, getVideo, insertChannel, openStore } from "../db/store.ts";
import { resetAdmin } from "./reset.ts";
import { countUsers, createFirstUser, getUserByUsername } from "./users.ts";

const videoId = testVideoId("abcdefghijk");

async function dataDirectoryWithOneAdminAndOneVideo(): Promise<string> {
  const dataDir = await temporaryDirectory();
  const store = openStore(join(dataDir, "tubestop.db"));
  createFirstUser(store, "parent", "some-hash");
  insertChannel(store, "UCchannelchannelchannelaa", "Music");
  allowVideo(store, {
    youtubeId: videoId,
    channelYoutubeId: "UCchannelchannelchannelaa",
    channelName: "Music",
    title: "Song",
    duration: 60,
    publishedAt: 0,
  });
  closeStore(store);
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
    const store = openStore(join(dataDir, "tubestop.db"));
    expect(countUsers(store)).toBe(0);
    expect(getUserByUsername(store, "parent")).toBeNull();
    closeStore(store);
  });

  test("keeps videos and channels", async () => {
    const dataDir = await dataDirectoryWithOneAdminAndOneVideo();

    resetAdmin(dataDir, () => {});

    const store = openStore(join(dataDir, "tubestop.db"));
    expect(getVideo(store, videoId)?.title).toBe("Song");
    expect(getChannels(store).map((channel) => channel.name)).toEqual(["Music"]);
    closeStore(store);
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
