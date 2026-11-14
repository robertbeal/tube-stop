import { describe, expect, test } from "bun:test";
import { formatDuration, humanBytes, timeAgo } from "./format.ts";

describe("humanBytes", () => {
  test.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KiB"],
    [1536, "1.5 KiB"],
    [2 ** 20 - 1, "1024.0 KiB"],
    [2 ** 20, "1.0 MiB"],
    [5 * 2 ** 30, "5.0 GiB"],
    [3 * 2 ** 40, "3.0 TiB"],
  ])("%p bytes is %p", (input, expected) => {
    expect(humanBytes(input)).toBe(expected);
  });
});

describe("formatDuration", () => {
  test.each([
    [-5, ""],
    [0, ""],
    [5, "0:05"],
    [59, "0:59"],
    [60, "1:00"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3661, "1:01:01"],
  ])("%p seconds is %p", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe("timeAgo", () => {
  const nowMs = Date.UTC(2026, 10, 14, 12, 0, 0);
  const secondsBefore = (seconds: number) => nowMs / 1000 - seconds;
  const minute = 60;
  const hour = 60 * minute;
  const day = 24 * hour;

  test.each([
    ["never synced", 0, "never"],
    ["a few seconds", secondsBefore(10), "just now"],
    ["just under a minute", secondsBefore(59), "just now"],
    ["in the future (clock difference)", secondsBefore(-5 * minute), "just now"],
    ["one minute", secondsBefore(minute), "1 minute ago"],
    ["twelve minutes", secondsBefore(12 * minute + 30), "12 minutes ago"],
    ["just under an hour", secondsBefore(59 * minute + 59), "59 minutes ago"],
    ["one hour", secondsBefore(hour), "1 hour ago"],
    ["three hours", secondsBefore(3 * hour + 40 * minute), "3 hours ago"],
    ["just under a day", secondsBefore(23 * hour + 59 * minute), "23 hours ago"],
    ["one day", secondsBefore(day), "1 day ago"],
    ["two days", secondsBefore(49 * hour), "2 days ago"],
    ["long ago", secondsBefore(400 * day), "400 days ago"],
  ])("%s", (_name, unixSeconds, expected) => {
    expect(timeAgo(nowMs, unixSeconds)).toBe(expected);
  });
});
