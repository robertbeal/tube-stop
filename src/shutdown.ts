/** Aborts when the app is shutting down. Anything that runs in the background listens to it. */
export const shutdown = new AbortController();
