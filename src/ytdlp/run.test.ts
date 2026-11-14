import { describe, expect, test } from "bun:test";
import { stubYtDlp } from "../test-helpers.ts";
import { ytdlp } from "./run.ts";

const neverAborted = new AbortController().signal;

describe("ytdlp", () => {
  test("returns what yt-dlp printed", async () => {
    const stub = await stubYtDlp("echo hello");
    expect(await ytdlp(stub.binary, [], neverAborted)).toBe("hello\n");
  });

  test("passes the arguments through, in order", async () => {
    const stub = await stubYtDlp("echo ok");
    await ytdlp(stub.binary, ["-J", "--no-warnings", "x y"], neverAborted);
    expect(await stub.arguments()).toEqual(["-J", "--no-warnings", "x y"]);
  });

  test("a failure reports the exit code and yt-dlp's message", async () => {
    const stub = await stubYtDlp('echo "ERROR: Video unavailable" >&2; exit 3');
    await expect(ytdlp(stub.binary, [], neverAborted)).rejects.toThrow(
      "yt-dlp: exited with code 3: ERROR: Video unavailable",
    );
  });

  test("a failure reports only the last 500 characters of what yt-dlp said", async () => {
    const stub = await stubYtDlp(`head -c 2000 /dev/zero | tr '\\0' 'a' >&2; echo THE-END >&2; exit 1`);
    const failure = await ytdlp(stub.binary, [], neverAborted).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toEndWith("THE-END");
    expect((failure as Error).message.length).toBeLessThan(600);
  });

  test("a binary that does not exist is an error", async () => {
    await expect(ytdlp("/no/such/yt-dlp", [], neverAborted)).rejects.toThrow();
  });

  test("a signal that is already aborted rejects with its reason without starting yt-dlp", async () => {
    const stub = await stubYtDlp("sleep 30");
    const reason = new Error("took too long");
    await expect(ytdlp(stub.binary, [], AbortSignal.abort(reason))).rejects.toBe(reason);
  });

  test("aborting while yt-dlp runs kills it and rejects with the reason", async () => {
    const stub = await stubYtDlp("sleep 30");
    const controller = new AbortController();
    const reason = new Error("took too long");
    const started = performance.now();

    const running = ytdlp(stub.binary, [], controller.signal);
    setTimeout(() => controller.abort(reason), 50);

    await expect(running).rejects.toBe(reason);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("a timeout signal rejects with a timeout error", async () => {
    const stub = await stubYtDlp("sleep 30");
    const failure = await ytdlp(stub.binary, [], AbortSignal.timeout(100)).catch((error: Error) => error);
    expect(failure).toHaveProperty("name", "TimeoutError");
  });
});
