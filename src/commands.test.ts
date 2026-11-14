import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { resetAdmin } from "./commands.ts";
import { Store } from "./db/store.ts";
import { temporaryDirectory } from "./test-helpers.ts";

const videoId = "abcdefghijk";

async function dataDirectoryWithOneAdminAndOneVideo(): Promise<string> {
  const dataDir = await temporaryDirectory();
  const store = new Store(join(dataDir, "tubestop.db"));
  store.createFirstUser("parent", "some-hash");
  store.addChannel("UCchannelchannelchannelaa", "Music");
  store.allowVideo({
    youtubeId: videoId,
    channelYoutubeId: "UCchannelchannelchannelaa",
    channelName: "Music",
    title: "Song",
    duration: 60,
    publishedAt: 0,
  });
  store.close();
  return dataDir;
}

function collectOutput(): { lines: string[]; output: (line: string) => void } {
  const lines: string[] = [];
  return { lines, output: (line) => lines.push(line) };
}

describe("resetAdmin", () => {
  test("removes the accounts and reports what was kept", async () => {
    const dataDir = await dataDirectoryWithOneAdminAndOneVideo();
    const { lines, output } = collectOutput();

    resetAdmin(dataDir, output);

    const text = lines.join("\n");
    expect(text).toContain("Removed 1 admin account");
    expect(text).toContain("kept");
    expect(text).toContain("setup code");
    const store = new Store(join(dataDir, "tubestop.db"));
    expect(store.userCount()).toBe(0);
    expect(store.userByUsername("parent")).toBeNull();
    store.close();
  });

  test("keeps videos and channels", async () => {
    const dataDir = await dataDirectoryWithOneAdminAndOneVideo();

    resetAdmin(dataDir, () => {});

    const store = new Store(join(dataDir, "tubestop.db"));
    expect(store.video(videoId)?.title).toBe("Song");
    expect(store.channels().map((channel) => channel.name)).toEqual(["Music"]);
    store.close();
  });

  test("says so when there are no accounts left to remove", async () => {
    const dataDir = await dataDirectoryWithOneAdminAndOneVideo();
    resetAdmin(dataDir, () => {});
    const { lines, output } = collectOutput();

    resetAdmin(dataDir, output);

    expect(lines.join("\n")).toContain("no admin accounts");
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
