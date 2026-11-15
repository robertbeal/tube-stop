import { spyOn } from "bun:test";
import type { Hono } from "hono";
import { createPasswordHasher, hashPassword } from "../admin/passwords.ts";
import { createFirstUser } from "../admin/users.ts";
import { config } from "../config.ts";
import type { NewVideo, User } from "../db/types.ts";
import { allowVideo } from "../db/videos.ts";
import * as syncModule from "../sync.ts";
import { thumbnailDir } from "../thumbnails.ts";
import { logger } from "../util/logger.ts";
import * as resolveModule from "../ytdlp/resolve.ts";
import type { Resolved, VideoId } from "../ytdlp/types.ts";
import { createApp } from "./app.tsx";

export const adminUsername = "parent";
export const adminPassword = "correct horse battery";

export type Environment = {
    app: Hono;
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
};

export type EnvironmentOptions = {
    /** Create the admin account `parent` / `correct horse battery` (the default). Pass false to test first-run setup. */
    withAdmin?: boolean;
    /** Answers admin "add" requests; by default every URL fails to resolve. */
    resolve?: (url: string) => Promise<Resolved>;
    sessionLifetimeMs?: number;
};

/** A complete app on the test database and folders, with fakes for everything outside the process. */
export async function buildEnvironment(options: EnvironmentOptions = {}): Promise<Environment> {
    const hasher = createPasswordHasher(4); // the cheapest bcrypt keeps tests fast
    const admin =
        options.withAdmin === false ? null : createFirstUser(adminUsername, await hashPassword(hasher, adminPassword));

    const logs: string[] = [];
    spyOn(logger, "info").mockImplementation((message) => void logs.push(message));
    spyOn(logger, "error").mockImplementation((message) => void logs.push(message));
    const triggers = { sync: 0 };
    const imageServer = { requests: [] as string[], failing: false };
    const resolved: string[] = [];
    spyOn(resolveModule, "resolveUrl").mockImplementation(async (_binary, url) => {
        resolved.push(url);
        return (options.resolve ?? (() => Promise.reject(new Error("no resolver in this test"))))(url);
    });
    spyOn(syncModule, "syncChannels").mockImplementation(async () => {
        triggers.sync += 1;
    });
    spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
        imageServer.requests.push(String(input));
        return imageServer.failing
            ? new Response("nope", { status: 500 })
            : new Response("JPEG", { headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch);

    const app = createApp({ hasher, sessionLifetimeMs: options.sessionLifetimeMs });
    return {
        app,
        mediaDir: config.mediaDir,
        cacheDir: config.cacheDir,
        thumbDir: thumbnailDir,
        logs,
        triggers,
        imageServer,
        resolved,
        admin,
    };
}

export type RequestOptions = {
    method?: string;
    /** Sent as a url-encoded form body. */
    form?: Record<string, string>;
    headers?: Record<string, string>;
    /** A cookie header value, such as the one returned by `logIn`. */
    cookie?: string;
};

export function send(environment: Environment, path: string, options: RequestOptions = {}): Promise<Response> {
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
export function allow(video: Partial<NewVideo> & { youtubeId: VideoId }): void {
    allowVideo({
        channelYoutubeId: "",
        channelName: "",
        title: "A video",
        duration: 0,
        publishedAt: 0,
        ...video,
    });
}
