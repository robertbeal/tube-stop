import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { YtDlp } from "../src/ytdlp.ts";
import { type Stub, stubYtDlp as writeStub } from "./helpers.ts";

/** Bun.write ignores its mode option on some versions, so make the script executable explicitly. */
async function stubYtDlp(body: string): Promise<Stub> {
  const stub = await writeStub(body);
  await chmod(stub.binary, 0o755);
  return stub;
}

async function clientPrinting(json: string) {
  const stub = await stubYtDlp(`cat <<'EOF'\n${json}\nEOF`);
  return { client: new YtDlp(stub.binary), stub };
}

async function recordingClient() {
  const stub = await stubYtDlp("echo /x.mp4");
  return { client: new YtDlp(stub.binary), stub };
}

describe("resolve", () => {
  test("a video URL returns the video's details", async () => {
    const { client } = await clientPrinting(
      '{"_type":"video","id":"abcdefghijk","title":"Moonlight Sonata","channel":"Piano Guy","channel_id":"UC123","duration":125.6}',
    );

    const resolved = await client.resolve("https://youtu.be/abcdefghijk");

    expect(resolved).toEqual({
      kind: "video",
      video: {
        id: "abcdefghijk",
        title: "Moonlight Sonata",
        channelName: "Piano Guy",
        channelId: "UC123",
        duration: 125,
        publishedAt: 0,
      },
    });
  });

  test("a channel URL is reported as a channel with its identity", async () => {
    const { client } = await clientPrinting(
      '{"_type":"playlist","title":"Piano Guy - Videos","channel":"Piano Guy","channel_id":"UC123","entries":[]}',
    );
    expect(await client.resolve("https://www.youtube.com/@pianoguy")).toEqual({
      kind: "channel",
      channelId: "UC123",
      channelName: "Piano Guy",
    });
  });

  test("a channel falls back to the first entry and the playlist title", async () => {
    const { client } = await clientPrinting(
      '{"_type":"playlist","title":"Piano Guy - Videos","entries":[{"id":"abcdefghijk","channel_id":"UC999"}]}',
    );
    expect(await client.resolve("https://www.youtube.com/@pianoguy/videos")).toEqual({
      kind: "channel",
      channelId: "UC999",
      channelName: "Piano Guy",
    });
  });

  test("a playlist without a channel is rejected", async () => {
    const { client } = await clientPrinting('{"_type":"playlist","title":"Mix","entries":[]}');
    await expect(client.resolve("https://example.com/list")).rejects.toThrow();
  });

  test("propagates a yt-dlp failure with its message", async () => {
    const stub = await stubYtDlp('echo "ERROR: Video unavailable" >&2; exit 1');
    await expect(new YtDlp(stub.binary).resolve("https://youtu.be/gone")).rejects.toThrow(
      "Video unavailable",
    );
  });

  test("rejects output that is not JSON", async () => {
    const stub = await stubYtDlp('echo "not json"');
    await expect(new YtDlp(stub.binary).resolve("x")).rejects.toThrow();
  });

  test("passes the URL after the end of options", async () => {
    const { client, stub } = await clientPrinting('{"_type":"video","id":"abcdefghijk"}');
    await client.resolve("--exec=evil");
    expect((await stub.arguments()).slice(-2)).toEqual(["--", "--exec=evil"]);
  });

  test("the video date comes from the upload date when there is no timestamp", async () => {
    const { client } = await clientPrinting(
      '{"_type":"video","id":"abcdefghijk","title":"Song","upload_date":"20240305"}',
    );
    const resolved = await client.resolve("https://youtu.be/abcdefghijk");
    expect(resolved.kind === "video" && resolved.video.publishedAt).toBe(Date.UTC(2024, 2, 5) / 1000);
  });

  test("a timestamp wins over the upload date", async () => {
    const { client } = await clientPrinting(
      '{"_type":"video","id":"abcdefghijk","timestamp":1700000000,"upload_date":"20240305"}',
    );
    const resolved = await client.resolve("https://youtu.be/abcdefghijk");
    expect(resolved.kind === "video" && resolved.video.publishedAt).toBe(1700000000);
  });

  test("a malformed upload date means unknown", async () => {
    const { client } = await clientPrinting(
      '{"_type":"video","id":"abcdefghijk","upload_date":"not-a-date"}',
    );
    const resolved = await client.resolve("https://youtu.be/abcdefghijk");
    expect(resolved.kind === "video" && resolved.video.publishedAt).toBe(0);
  });
});

describe("listChannel", () => {
  test("returns videos in order and skips entries without an id", async () => {
    const { client, stub } = await clientPrinting(`{"_type":"playlist","entries":[
 {"id":"aaaaaaaaaaa","title":"One","duration":60},
 {"title":"No id at all"},
 {"id":"bbbbbbbbbbb","title":"Two","channel_id":"UCother"}
]}`);

    const videos = await client.listChannel("UC123", 25);

    expect(videos.map((video) => video.id)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
    expect(videos[0]?.channelId).toBe("UC123");
    expect(videos[1]?.channelId).toBe("UCother");
    const joined = (await stub.arguments()).join(" ");
    expect(joined).toContain("/channel/UC123/videos");
    expect(joined).toContain("--playlist-end 25");
  });

  test("asks for approximate dates and reads them", async () => {
    const { client, stub } = await clientPrinting(`{"_type":"playlist","entries":[
 {"id":"aaaaaaaaaaa","title":"New","timestamp":1794528000},
 {"id":"bbbbbbbbbbb","title":"No date"}]}`);

    const videos = await client.listChannel("UC123", 10);

    expect(videos.map((video) => video.publishedAt)).toEqual([1794528000, 0]);
    expect((await stub.arguments()).join(" ")).toContain("youtubetab:approximate_date");
  });
});

describe("downloads", () => {
  test("return the path yt-dlp reports last", async () => {
    const stub = await stubYtDlp('echo "[download] progress noise"; echo "/media/Chan/video.mp4"');
    const path = await new YtDlp(stub.binary).downloadToLibrary("abcdefghijk", "/media", 1080);
    expect(path).toBe("/media/Chan/video.mp4");
  });

  test("limit quality and always write a thumbnail", async () => {
    const { client, stub } = await recordingClient();

    await client.downloadToCache("abcdefghijk", "/o", 720);
    const cacheArguments = (await stub.arguments()).join(" ");
    await client.downloadToLibrary("abcdefghijk", "/o", 1080);
    const libraryArguments = (await stub.arguments()).join(" ");

    expect(cacheArguments).toContain("height<=720");
    expect(cacheArguments).toContain("--write-thumbnail");
    expect(libraryArguments).toContain("height<=1080");
    expect(libraryArguments).toContain("--write-thumbnail");
  });

  test("name cache files by id and organise the library by channel", async () => {
    const { client, stub } = await recordingClient();

    await client.downloadToCache("abcdefghijk", "/cache", 720);
    const cacheArguments = (await stub.arguments()).join(" ");
    await client.downloadToLibrary("abcdefghijk", "/media", 720);
    const libraryArguments = (await stub.arguments()).join(" ");

    expect(cacheArguments).toContain("-o /cache/%(id)s.%(ext)s");
    expect(libraryArguments).toContain("-o /media/%(channel,uploader|Unknown)s/");
  });

  test("pass the video id after the end of options", async () => {
    const { client, stub } = await recordingClient();
    await client.downloadToCache("--exec=evil", "/o", 720);
    expect((await stub.arguments()).slice(-2)).toEqual(["--", "--exec=evil"]);
  });

  test("fail when no output file is reported", async () => {
    const stub = await stubYtDlp("exit 0");
    await expect(new YtDlp(stub.binary).downloadToCache("abcdefghijk", "/o", 720)).rejects.toThrow();
  });

  test("stop when the signal is aborted", async () => {
    const stub = await stubYtDlp("sleep 30");
    const started = performance.now();
    await expect(
      new YtDlp(stub.binary).downloadToCache("abcdefghijk", "/o", 720, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
