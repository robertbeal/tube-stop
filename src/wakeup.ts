/**
 * A wake-up signal that merges repeated requests. `wake` never blocks, and any number of
 * calls made while nobody is waiting count as one.
 */
export interface Wakeup {
  pending: boolean;
  notify: (() => void) | undefined;
}

export const createWakeup = (): Wakeup => ({ pending: false, notify: undefined });

export function wake(wakeup: Wakeup): void {
  wakeup.pending = true;
  wakeup.notify?.();
}

/** Resolves when woken, after `timeoutMs`, or when `signal` aborts, whichever comes first. */
export async function waitForWakeup(wakeup: Wakeup, timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (!wakeup.pending && !signal.aborted) {
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        wakeup.notify = undefined;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      signal.addEventListener("abort", finish);
      wakeup.notify = finish;
    });
  }
  wakeup.pending = false;
}

/** Resolves after `milliseconds`, or as soon as `signal` aborts. */
export function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return waitForWakeup(createWakeup(), milliseconds, signal);
}
