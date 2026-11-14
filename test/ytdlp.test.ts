import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { downloadToCache, downloadToLibrary, listChannel, resolveUrl } from "../src/ytdlp.ts";
import { type Stub, stubYtDlp as writeStub } from "./helpers.ts";

/** Bun.write ignores its mode option on some versions, so make the script executable explicitly. */
async function stubYtDlp(body: string): Promise<Stub> {
  const stub = await writeStub(body);
  await chmod(stub.binary, 0o755);
  return stub;
}

async function printing(json: string) {
  const stub = await stubYtDlp(`cat <<'EOF'\n${json}\nEOF`);
  return { binary: stub.binary, stub };
}

async function recording() {
  const stub = await stubYtDlp("echo /x.mp4");
  return { binary: stub.binary, stub };
}

describe("resolve", () => {
  test("a video URL returns the video's details", async () => {
    const { binary } = await printing(
      '{"_type":"video","id":"abcdefghijk","title":"Moonlight Sonata","channel":"Piano Guy","channel_id":"UC123","duration":125.6}',
    );

    const resolved = await resolveUrl(binary, "https://youtu.be/abcdefghijk");

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
    const { binary } = await printing(
      '{"_type":"playlist","title":"Piano Guy - Videos","channel":"Piano Guy","channel_id":"UC123","entries":[]}',
    );
    expect(await resolveUrl(binary, "https://www.youtube.com/@pianoguy")).toEqual({
      kind: "channel",
      channelId: "UC123",
      channelName: "Piano Guy",
    });
  });

  test("a channel falls back to the first entry and the playlist title", async () => {
    const { binary } = await printing(
      '{"_type":"playlist","title":"Piano Guy - Videos","entries":[{"id":"abcdefghijk","channel_id":"UC999"}]}',
    );
    expect(await resolveUrl(binary, "https://www.youtube.com/@pianoguy/videos")).toEqual({
      kind: "channel",
      channelId: "UC999",
      channelName: "Piano Guy",
    });
  });

  test("a playlist without a channel is rejected", async () => {
    const { binary } = await printing('{"_type":"playlist","title":"Mix","entries":[]}');
    await expect(resolveUrl(binary, "https://example.com/list")).rejects.toThrow();
  });

  test("propagates a yt-dlp failure with its message", async () => {
    const stub = await stubYtDlp('echo "ERROR: Video unavailable" >&2; exit 1');
    await expect(resolveUrl(stub.binary, "https://youtu.be/gone")).rejects.toThrow("Video unavailable");
  });

  test("rejects output that is not JSON", async () => {
    const stub = await stubYtDlp('echo "not json"');
    await expect(resolveUrl(stub.binary, "x")).rejects.toThrow();
  });

  test("passes the URL after the end of options", async () => {
    const { binary, stub } = await printing('{"_type":"video","id":"abcdefghijk"}');
    await resolveUrl(binary, "--exec=evil");
    expect((await stub.arguments()).slice(-2)).toEqual(["--", "--exec=evil"]);
  });

  test("the video date comes from the upload date when there is no timestamp", async () => {
    const { binary } = await printing(
      '{"_type":"video","id":"abcdefghijk","title":"Song","upload_date":"20240305"}',
    );
    const resolved = await resolveUrl(binary, "https://youtu.be/abcdefghijk");
    expect(resolved.kind === "video" && resolved.video.publishedAt).toBe(Date.UTC(2024, 2, 5) / 1000);
  });

  test("a timestamp wins over the upload date", async () => {
    const { binary } = await printing(
      '{"_type":"video","id":"abcdefghijk","timestamp":1700000000,"upload_date":"20240305"}',
    );
    const resolved = await resolveUrl(binary, "https://youtu.be/abcdefghijk");
    expect(resolved.kind === "video" && resolved.video.publishedAt).toBe(1700000000);
  });

  test("a malformed upload date means unknown", async () => {
    const { binary } = await printing('{"_type":"video","id":"abcdefghijk","upload_date":"not-a-date"}');
    const resolved = await resolveUrl(binary, "https://youtu.be/abcdefghijk");
    expect(resolved.kind === "video" && resolved.video.publishedAt).toBe(0);
  });
});

describe("listChannel", () => {
  test("returns videos in order and skips entries without an id", async () => {
    const { binary, stub } = await printing(`{"_type":"playlist","entries":[
 {"id":"aaaaaaaaaaa","title":"One","duration":60},
 {"title":"No id at all"},
 {"id":"bbbbbbbbbbb","title":"Two","channel_id":"UCother"}
]}`);

    const videos = await listChannel(binary, "UC123", 25);

    expect(videos.map((video) => video.id)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
    expect(videos[0]?.channelId).toBe("UC123");
    expect(videos[1]?.channelId).toBe("UCother");
    const joined = (await stub.arguments()).join(" ");
    expect(joined).toContain("/channel/UC123/videos");
    expect(joined).toContain("--playlist-end 25");
  });

  test("asks for approximate dates and reads them", async () => {
    const { binary, stub } = await printing(`{"_type":"playlist","entries":[
 {"id":"aaaaaaaaaaa","title":"New","timestamp":1794528000},
 {"id":"bbbbbbbbbbb","title":"No date"}]}`);

    const videos = await listChannel(binary, "UC123", 10);

    expect(videos.map((video) => video.publishedAt)).toEqual([1794528000, 0]);
    expect((await stub.arguments()).join(" ")).toContain("youtubetab:approximate_date");
  });
});

describe("downloads", () => {
  test("return the path yt-dlp reports last", async () => {
    const stub = await stubYtDlp('echo "[download] progress noise"; echo "/media/Chan/video.mp4"');
    const path = await downloadToLibrary(stub.binary, "abcdefghijk", "/media", 1080);
    expect(path).toBe("/media/Chan/video.mp4");
  });

  test("limit quality and always write a thumbnail", async () => {
    const { binary, stub } = await recording();

    await downloadToCache(binary, "abcdefghijk", "/o", 720);
    const cacheArguments = (await stub.arguments()).join(" ");
    await downloadToLibrary(binary, "abcdefghijk", "/o", 1080);
    const libraryArguments = (await stub.arguments()).join(" ");

    expect(cacheArguments).toContain("height<=720");
    expect(cacheArguments).toContain("--write-thumbnail");
    expect(libraryArguments).toContain("height<=1080");
    expect(libraryArguments).toContain("--write-thumbnail");
  });

  test("name cache files by id and organise the library by channel", async () => {
    const { binary, stub } = await recording();

    await downloadToCache(binary, "abcdefghijk", "/cache", 720);
    const cacheArguments = (await stub.arguments()).join(" ");
    await downloadToLibrary(binary, "abcdefghijk", "/media", 720);
    const libraryArguments = (await stub.arguments()).join(" ");

    expect(cacheArguments).toContain("-o /cache/%(id)s.%(ext)s");
    expect(libraryArguments).toContain("-o /media/%(channel,uploader|Unknown)s/");
  });

  test("pass the video id after the end of options", async () => {
    const { binary, stub } = await recording();
    await downloadToCache(binary, "--exec=evil", "/o", 720);
    expect((await stub.arguments()).slice(-2)).toEqual(["--", "--exec=evil"]);
  });

  test("fail when no output file is reported", async () => {
    const stub = await stubYtDlp("exit 0");
    await expect(downloadToCache(stub.binary, "abcdefghijk", "/o", 720)).rejects.toThrow();
  });

  test("stop when the signal is aborted", async () => {
    const stub = await stubYtDlp("sleep 30");
    const started = performance.now();
    await expect(
      downloadToCache(stub.binary, "abcdefghijk", "/o", 720, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
