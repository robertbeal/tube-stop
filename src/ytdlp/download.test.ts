import { describe, expect, test } from "bun:test";
import { stubYtDlp } from "../test-helpers.ts";
import { downloadToCache, downloadToLibrary } from "./download.ts";

const neverAborted = new AbortController().signal;

async function recording() {
  return stubYtDlp("echo /x.mp4");
}

describe("downloads", () => {
  test("return the path yt-dlp reports last", async () => {
    const stub = await stubYtDlp('echo "[download] progress noise"; echo "/media/Chan/video.mp4"');
    const path = await downloadToLibrary(stub.binary, "abcdefghijk", "/media", 1080, neverAborted);
    expect(path).toBe("/media/Chan/video.mp4");
  });

  test("limit quality and always write a thumbnail", async () => {
    const stub = await recording();

    await downloadToCache(stub.binary, "abcdefghijk", "/o", 720, neverAborted);
    const cacheArguments = (await stub.arguments()).join(" ");
    await downloadToLibrary(stub.binary, "abcdefghijk", "/o", 1080, neverAborted);
    const libraryArguments = (await stub.arguments()).join(" ");

    expect(cacheArguments).toContain("height<=720");
    expect(cacheArguments).toContain("--write-thumbnail");
    expect(libraryArguments).toContain("height<=1080");
    expect(libraryArguments).toContain("--write-thumbnail");
  });

  test("name cache files by id and organise the library by channel", async () => {
    const stub = await recording();

    await downloadToCache(stub.binary, "abcdefghijk", "/cache", 720, neverAborted);
    const cacheArguments = (await stub.arguments()).join(" ");
    await downloadToLibrary(stub.binary, "abcdefghijk", "/media", 720, neverAborted);
    const libraryArguments = (await stub.arguments()).join(" ");

    expect(cacheArguments).toContain("-o /cache/%(id)s.%(ext)s");
    expect(libraryArguments).toContain("-o /media/%(channel,uploader|Unknown)s/");
  });

  test("pass the video id after the end of options", async () => {
    const stub = await recording();
    await downloadToCache(stub.binary, "--exec=evil", "/o", 720, neverAborted);
    expect((await stub.arguments()).slice(-2)).toEqual(["--", "--exec=evil"]);
  });

  test("fail when no output file is reported", async () => {
    const stub = await stubYtDlp("exit 0");
    await expect(downloadToCache(stub.binary, "abcdefghijk", "/o", 720, neverAborted)).rejects.toThrow();
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
