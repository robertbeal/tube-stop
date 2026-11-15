import { spyOn } from "bun:test";
import { join } from "node:path";
import type { Hono } from "hono";
import { temporaryDirectory } from "../../tests/helpers.ts";
import { createPasswordHasher, hashPassword } from "../admin/passwords.ts";
import { createFirstUser } from "../admin/users.ts";
import { allowVideo, type NewVideo, openStore, type Store, type User } from "../db/store.ts";
import type { Resolved, ResolveUrl, VideoId } from "../ytdlp/types.ts";
import { createApp } from "./app.tsx";

export const adminUsername = "parent";
export const adminPassword = "correct horse battery";

/** A clock the test can move. */
export interface FakeClock {
  milliseconds: number;
}

export const createFakeClock = (): FakeClock => ({ milliseconds: Date.UTC(2026, 0, 1, 12, 0, 0) });

export function advanceClock(clock: FakeClock, milliseconds: number): void {
  clock.milliseconds += milliseconds;
}

export interface Environment {
  app: Hono;
  store: Store;
  clock: FakeClock;
  mediaDir: string;
  cacheDir: string;
  thumbDir: string;
  /** Messages the app logged. */
  logs: string[];
  /** How many times each worker was woken. */
  triggers: { sync: number };
  /** The images the fake thumbnail server was asked for, and whether it should fail. */
  imageServer: { requests: string[]; failing: boolean };
  /** The URLs the resolver was asked about. */
  resolved: string[];
  admin: User | null;
}

export interface EnvironmentOptions {
  /** Create the admin account `parent` / `correct horse battery` (the default). Pass false to test first-run setup. */
  withAdmin?: boolean;
  /** Answers admin "add" requests; by default every URL fails to resolve. */
  resolve?: (url: string) => Promise<Resolved>;
  sessionLifetimeMs?: number;
}

/** A complete app on a temporary database and folders, with fakes for everything outside the process. */
export async function buildEnvironment(options: EnvironmentOptions = {}): Promise<Environment> {
  const directory = await temporaryDirectory();
  const mediaDir = join(directory, "media");
  const cacheDir = join(directory, "cache");
  const thumbDir = join(directory, "thumbs");
  const clock = createFakeClock();
  const store = openStore(join(directory, "tubestop.db"), () => Math.floor(clock.milliseconds / 1000));
  const hasher = createPasswordHasher(4); // the cheapest bcrypt keeps tests fast
  const admin =
    options.withAdmin === false
      ? null
      : createFirstUser(store, adminUsername, await hashPassword(hasher, adminPassword));

  const logs: string[] = [];
  const triggers = { sync: 0 };
  const imageServer = { requests: [] as string[], failing: false };
  const resolved: string[] = [];
  const resolveUrl: ResolveUrl = (url) => {
    resolved.push(url);
    return (options.resolve ?? (() => Promise.reject(new Error("no resolver in this test"))))(url);
  };
  spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    imageServer.requests.push(String(input));
    return imageServer.failing
      ? new Response("nope", { status: 500 })
      : new Response("JPEG", { headers: { "content-type": "image/jpeg" } });
  }) as typeof fetch);

  const app = createApp({
    store,
    resolveUrl,
    syncNow: async () => {
      triggers.sync += 1;
    },
    thumbnailDir: thumbDir,
    mediaDir,
    cacheDir,
    hasher,
    sessionLifetimeMs: options.sessionLifetimeMs,
    now: () => clock.milliseconds,
    log: (message) => void logs.push(message),
  });
  return { app, store, clock, mediaDir, cacheDir, thumbDir, logs, triggers, imageServer, resolved, admin };
}

export interface RequestOptions {
  method?: string;
  /** Sent as a url-encoded form body. */
  form?: Record<string, string>;
  headers?: Record<string, string>;
  /** A cookie header value, such as the one returned by `logIn`. */
  cookie?: string;
}

export function send(
  environment: Environment,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.cookie) {
    headers.set("cookie", options.cookie);
  }
  if (options.form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
  }
  return Promise.resolve(
    environment.app.request(path, {
      method: options.method ?? (options.form ? "POST" : "GET"),
      headers,
      body: options.form ? new URLSearchParams(options.form).toString() : undefined,
    }),
  );
}

/** The `name=value` part of the session cookie a response set, for sending back as a cookie header. */
export function sessionCookie(response: Response): string | undefined {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith("tubestop_admin="));
  return header?.split(";")[0];
}

/** Logs in as the admin and returns the cookie header value. */
export async function logIn(environment: Environment): Promise<string> {
  const response = await send(environment, "/admin/login", {
    form: { username: adminUsername, password: adminPassword },
  });
  const cookie = sessionCookie(response);
  if (response.status !== 303 || !cookie) {
    throw new Error(`login failed with status ${response.status}`);
  }
  return cookie;
}

/** Adds a video the child may watch. */
export function allow(environment: Environment, video: Partial<NewVideo> & { youtubeId: VideoId }): void {
  allowVideo(environment.store, {
    channelYoutubeId: "",
    channelName: "",
    title: "A video",
    duration: 0,
    publishedAt: 0,
    ...video,
  });
}
