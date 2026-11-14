import { describe, expect, test } from "bun:test";
import { sleep, Wakeup } from "../src/wakeup.ts";

const neverAborted = new AbortController().signal;

describe("Wakeup", () => {
  test("a wake-up made before waiting makes the wait return immediately", async () => {
    const wakeup = new Wakeup();
    wakeup.wake();
    const started = performance.now();
    await wakeup.wait(5000, neverAborted);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("repeated wake-ups merge into one", async () => {
    const wakeup = new Wakeup();
    [1, 2, 3, 4, 5].forEach(() => {
      wakeup.wake();
    });
    await wakeup.wait(5000, neverAborted);

    const started = performance.now();
    await wakeup.wait(60, neverAborted);
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
  });

  test("a wake-up during a wait ends it", async () => {
    const wakeup = new Wakeup();
    const started = performance.now();
    const waiting = wakeup.wait(5000, neverAborted);
    setTimeout(() => wakeup.wake(), 20);
    await waiting;
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("aborting the signal ends the wait", async () => {
    const controller = new AbortController();
    const started = performance.now();
    const waiting = new Wakeup().wait(5000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await waiting;
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("an already aborted signal returns at once", async () => {
    const started = performance.now();
    await new Wakeup().wait(5000, AbortSignal.abort());
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("the wait returns after the timeout when nothing happens", async () => {
    const started = performance.now();
    await new Wakeup().wait(50, neverAborted);
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
  });
});

describe("sleep", () => {
  test("sleeps for the given time", async () => {
    const started = performance.now();
    await sleep(50, neverAborted);
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
  });

  test("stops early when the signal aborts", async () => {
    const started = performance.now();
    await sleep(5000, AbortSignal.abort());
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
