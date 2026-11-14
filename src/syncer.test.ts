import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { type Channel, Store } from "./db/store.ts";
import { ChannelSyncer, type SyncStore } from "./syncer.ts";
import { temporaryDirectory, stubYtDlp as writeStub } from "./test-helpers.ts";
import { listChannel, type Video } from "./ytdlp.ts";

const everything = { limit: 1000, offset: 0 };
const neverAborted = new AbortController().signal;
const hour = 60 * 60 * 1000;

/** yt-dlp listing, newest first. */
const listing = `{"_type":"playlist","entries":[
 {"id":"newestvideo","title":"Newest","duration":30},
 {"id":"middlevideo","title":"Middle"},
 {"id":"oldestvideo","title":"Oldest","duration":10}]}`;

async function openStore(): Promise<Store> {
  return new Store(join(await temporaryDirectory(), "tubestop.db"));
}

async function ytDlpPrinting(body: string) {
  const stub = await writeStub(body);
  await chmod(stub.binary, 0o755); // Bun.write ignores its mode option on some versions
  return listChannel.bind(null, stub.binary);
}

const printing = (json: string) => `cat <<'EOF'\n${json}\nEOF`;

function syncerFor(
  store: SyncStore,
  listChannel: ConstructorParameters<typeof ChannelSyncer>[1],
): ChannelSyncer {
  return new ChannelSyncer(store, listChannel, hour, () => undefined);
}

function fakeLister(videos: Video[] = []) {
  const calls: { channelId: string; limit: number }[] = [];
  const lister = async (channelId: string, limit: number) => {
    calls.push({ channelId, limit });
    return videos;
  };
  return { lister, calls };
}

const titlesOf = (store: Store) => store.watchable("", everything).videos.map((video) => video.title);

function listed(overrides: Partial<Video>): Video {
  return {
    id: "abcdefghijk",
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
    const store = await openStore();
    store.addChannel("UC1", "Piano Guy");

    await syncerFor(store, await ytDlpPrinting(printing(listing))).syncAll(neverAborted);

    const videos = store.watchable("", everything).videos;
    expect(videos.map((video) => video.title)).toEqual(["Newest", "Middle", "Oldest"]);
    expect(videos[0]?.channelName).toBe("Piano Guy");
    expect(videos[0]?.duration).toBe(30);
  });

  test("is idempotent and keeps blocked videos blocked", async () => {
    const store = await openStore();
    store.addChannel("UC1", "Piano Guy");
    const syncer = syncerFor(store, await ytDlpPrinting(printing(listing)));
    await syncer.syncAll(neverAborted);
    store.block("middlevideo");

    await syncer.syncAll(neverAborted);

    expect(titlesOf(store)).toEqual(["Newest", "Oldest"]);
  });

  test("marks the channel as synced", async () => {
    const store = await openStore();
    store.addChannel("UC1", "Piano Guy");

    await syncerFor(store, await ytDlpPrinting(printing(listing))).syncAll(neverAborted);

    const [channel] = store.channels();
    expect(channel?.lastSyncedAt).toBeGreaterThan(0);
    expect(channel?.videoCount).toBe(3);
  });

  test("a failure leaves existing videos and the sync time untouched", async () => {
    const store = await openStore();
    store.addChannel("UC1", "Piano Guy");
    store.insertSynced({
      youtubeId: "existingvid",
      channelYoutubeId: "UC1",
      channelName: "Piano Guy",
      title: "Existing",
      duration: 0,
      publishedAt: 0,
    });

    await syncerFor(store, await ytDlpPrinting("echo 'ERROR: offline' >&2\nexit 1")).syncAll(neverAborted);

    expect(titlesOf(store)).toEqual(["Existing"]);
    expect(store.channels()[0]?.lastSyncedAt).toBe(0);
  });

  test("one broken channel does not stop the others", async () => {
    const store = await ytDlpPrinting(
      `case "$*" in *UC1*) echo 'ERROR: nope' >&2; exit 1;; esac\n${printing(listing)}`,
    ).then(async (client) => {
      const database = await openStore();
      database.addChannel("UC1", "Broken");
      database.addChannel("UC2", "Healthy");
      await syncerFor(database, client).syncAll(neverAborted);
      return database;
    });

    const syncedByName = Object.fromEntries(
      store.channels().map((channel: Channel) => [channel.name, channel.lastSyncedAt > 0]),
    );
    expect(syncedByName).toEqual({ Broken: false, Healthy: true });
  });

  test("stops when the signal is aborted", async () => {
    const store = await openStore();
    store.addChannel("UC1", "Piano Guy");

    await syncerFor(store, await ytDlpPrinting(printing(listing))).syncAll(AbortSignal.abort());

    expect(titlesOf(store)).toEqual([]);
  });

  test("looks at the channel's 50 most recent videos only", async () => {
    const store = await openStore();
    store.addChannel("UC1", "Piano Guy");
    const { lister, calls } = fakeLister();

    await syncerFor(store, lister).syncAll(neverAborted);

    expect(calls).toEqual([{ channelId: "UC1", limit: 50 }]);
  });

  test("uses the video id when YouTube gives no title", async () => {
    const store = await openStore();
    store.addChannel("UC1", "Piano Guy");
    const { lister } = fakeLister([listed({ id: "untitledvid", title: "" })]);

    await syncerFor(store, lister).syncAll(neverAborted);

    expect(store.video("untitledvid")?.title).toBe("untitledvid");
  });

  test("a database failure is logged and the run ends without calling YouTube", async () => {
    const { lister, calls } = fakeLister();
    const brokenStore: SyncStore = {
      channels: () => {
        throw new Error("database is down");
      },
      insertSynced: () => undefined,
      markSynced: () => undefined,
    };

    const messages: string[] = [];
    const syncer = new ChannelSyncer(brokenStore, lister, hour, (message) => void messages.push(message));
    await syncer.syncAll(neverAborted);

    expect(messages).toEqual(["sync: list channels: database is down"]);
    expect(calls).toEqual([]);
  });

  test("shows videos in publish order even when YouTube lists them differently", async () => {
    const store = await openStore();
    store.addChannel("UC1", "Piano Guy");
    const datedListing = `{"_type":"playlist","entries":[
 {"id":"middlevideo","title":"Published second","timestamp":200},
 {"id":"newestvideo","title":"Published third","timestamp":300},
 {"id":"oldestvideo","title":"Published first","timestamp":100}]}`;

    await syncerFor(store, await ytDlpPrinting(printing(datedListing))).syncAll(neverAborted);

    expect(titlesOf(store)).toEqual(["Published third", "Published second", "Published first"]);
  });

  test("fills in dates for videos synced before they were known", async () => {
    const store = await openStore();
    store.addChannel("UC1", "Piano Guy");
    store.insertSynced({
      youtubeId: "oldvideoaaa",
      channelYoutubeId: "UC1",
      channelName: "Piano Guy",
      title: "Old",
      duration: 0,
      publishedAt: 0,
    });
    const { lister } = fakeLister([listed({ id: "oldvideoaaa", title: "Old", publishedAt: 4242 })]);

    await syncerFor(store, lister).syncAll(neverAborted);

    expect(store.video("oldvideoaaa")?.publishedAt).toBe(4242);
  });
});

describe("run and trigger", () => {
  test("trigger requests an immediate sync without blocking, and run stops on abort", async () => {
    const store = await openStore();
    store.addChannel("UC1", "Piano Guy");
    const syncer = syncerFor(store, await ytDlpPrinting(printing(listing)));
    [1, 2, 3, 4, 5].forEach(() => {
      syncer.trigger();
    });

    const controller = new AbortController();
    const running = syncer.run(controller.signal);
    await waitFor("run to sync the channel", () => titlesOf(store).length === 3);
    controller.abort();

    await running;
  });
});
