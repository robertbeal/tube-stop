/**
 * A wake-up signal that merges repeated requests. `wake()` never blocks, and any number of
 * calls made while nobody is waiting count as one.
 */
export class Wakeup {
  #pending = false;
  #notify: (() => void) | undefined;

  wake(): void {
    this.#pending = true;
    this.#notify?.();
  }

  /** Resolves when woken, after `timeoutMs`, or when `signal` aborts, whichever comes first. */
  async wait(timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (!this.#pending && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          this.#notify = undefined;
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        signal.addEventListener("abort", finish);
        this.#notify = finish;
      });
    }
    this.#pending = false;
  }
}

/** Resolves after `milliseconds`, or as soon as `signal` aborts. */
export function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Wakeup().wait(milliseconds, signal);
}
