import { describe, expect, test } from "bun:test";
import { sleep } from "./sleep.ts";

const neverAborted = new AbortController().signal;

describe("sleep", () => {
  test("waits for the given time", async () => {
    const started = performance.now();
    await sleep(50, neverAborted);
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
  });

  test("returns as soon as the signal aborts", async () => {
    const controller = new AbortController();
    const started = performance.now();
    const sleeping = sleep(5000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await sleeping;
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("returns at once for a signal that is already aborted", async () => {
    const started = performance.now();
    await sleep(5000, AbortSignal.abort());
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
