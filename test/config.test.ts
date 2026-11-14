import { describe, expect, test } from "bun:test";
import { loadConfig, parseDuration } from "../src/config.ts";

const day = 24 * 60 * 60 * 1000;

describe("loadConfig", () => {
  test("applies defaults when nothing is set", () => {
    expect(loadConfig({})).toEqual({
      host: "0.0.0.0",
      port: 8080,
      dataDir: "./data",
      mediaDir: "./media",
      cacheDir: "./cache",
      ytdlpBin: "yt-dlp",
      keepMaxHeight: 1080,
      cacheTtlMs: 7 * day,
      cacheMaxBytes: 20 * 2 ** 30,
      syncIntervalMs: 60 * 60 * 1000,
      sessionLifetimeMs: 30 * day,
    });
  });

  test("reads overrides", () => {
    expect(
      loadConfig({
        HOST: "127.0.0.1",
        PORT: "9000",
        DATA_DIR: "/data",
        MEDIA_DIR: "/media",
        CACHE_DIR: "/cache",
        YTDLP_BIN: "/opt/yt-dlp",
        KEEP_MAX_HEIGHT: "720",
        CACHE_TTL_DAYS: "2",
        CACHE_MAX_GB: "1.5",
        SYNC_INTERVAL: "30m",
        ADMIN_SESSION_DAYS: "7",
      }),
    ).toEqual({
      host: "127.0.0.1",
      port: 9000,
      dataDir: "/data",
      mediaDir: "/media",
      cacheDir: "/cache",
      ytdlpBin: "/opt/yt-dlp",
      keepMaxHeight: 720,
      cacheTtlMs: 2 * day,
      cacheMaxBytes: 1.5 * 2 ** 30,
      syncIntervalMs: 30 * 60 * 1000,
      sessionLifetimeMs: 7 * day,
    });
  });

  test("treats empty strings as the default", () => {
    const config = loadConfig({ PORT: "", KEEP_MAX_HEIGHT: "", SYNC_INTERVAL: "", DATA_DIR: "" });
    expect(config.port).toBe(8080);
    expect(config.keepMaxHeight).toBe(1080);
    expect(config.syncIntervalMs).toBe(60 * 60 * 1000);
    expect(config.dataDir).toBe("./data");
  });

  test("ignores a leftover ADMIN_PASSWORD because accounts are created in the browser", () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: "left-over-from-before" })).not.toThrow();
  });

  test("accepts the largest valid port and session length", () => {
    const config = loadConfig({ PORT: "65535", ADMIN_SESSION_DAYS: "400" });
    expect(config.port).toBe(65535);
    expect(config.sessionLifetimeMs).toBe(400 * day);
  });

  const invalidValues: [string, string][] = [
    ["PORT", "abc"],
    ["PORT", "0"],
    ["PORT", "65536"],
    ["PORT", "-1"],
    ["PORT", "80.5"],
    ["CACHE_MAX_GB", "20GB"],
    ["CACHE_MAX_GB", "0"],
    ["CACHE_MAX_GB", "-5"],
    ["CACHE_MAX_GB", "NaN"],
    ["CACHE_MAX_GB", "Infinity"],
    ["CACHE_MAX_GB", " "],
    ["KEEP_MAX_HEIGHT", "1080p"],
    ["KEEP_MAX_HEIGHT", "0"],
    ["KEEP_MAX_HEIGHT", "720.5"],
    ["CACHE_TTL_DAYS", "a week"],
    ["CACHE_TTL_DAYS", "0"],
    ["ADMIN_SESSION_DAYS", "forever"],
    ["ADMIN_SESSION_DAYS", "0"],
    ["ADMIN_SESSION_DAYS", "-7"],
    ["ADMIN_SESSION_DAYS", "401"],
    ["SYNC_INTERVAL", "hourly"],
    ["SYNC_INTERVAL", "-1h"],
    ["SYNC_INTERVAL", "0s"],
    ["SYNC_INTERVAL", "30"],
  ];

  test.each(invalidValues)("rejects %s=%j and names the setting", (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(`${key}: want `);
    expect(() => loadConfig({ [key]: value })).toThrow(`got "${value}"`);
  });

  test("reports every problem at once, one per line", () => {
    const lines = (() => {
      try {
        loadConfig({ CACHE_MAX_GB: "x", KEEP_MAX_HEIGHT: "y", ADMIN_SESSION_DAYS: "z" });
        return [];
      } catch (error) {
        return error instanceof Error ? error.message.split("\n") : [];
      }
    })();
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.split(":")[0]).sort()).toEqual([
      "ADMIN_SESSION_DAYS",
      "CACHE_MAX_GB",
      "KEEP_MAX_HEIGHT",
    ]);
  });
});

describe("parseDuration", () => {
  test.each([
    ["30m", 30 * 60_000],
    ["1h", 3_600_000],
    ["1h30m", 5_400_000],
    ["500ms", 500],
    ["90s", 90_000],
    ["1.5h", 5_400_000],
  ])("parses %s", (raw, milliseconds) => {
    expect(parseDuration(raw)).toBe(milliseconds);
  });

  test.each(["", "hourly", "30", "-1h", "0s", "0h0m", "1d", "1h 30m", " 1h", "1h30", "m"])(
    "rejects %j",
    (raw) => {
      expect(parseDuration(raw)).toBeUndefined();
    },
  );
});
