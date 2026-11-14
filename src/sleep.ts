import { setTimeout as delay } from "node:timers/promises";

/** Resolves after `milliseconds`, or as soon as `signal` aborts. */
export async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  await delay(milliseconds, undefined, { signal }).catch(() => undefined);
}
