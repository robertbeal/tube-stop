import type { Database } from "bun:sqlite";
import type { LoginLimiter, Sessions, SetupCode } from "../admin/auth.ts";
import type { PasswordHasher } from "../admin/passwords.ts";

/** Everything the web layer needs from the rest of the app. */
export type WebDependencies = {
    database: Database;
    /** The yt-dlp program to run. */
    ytdlpBinary: string;
    /** Aborts when the app is shutting down, which stops syncs the admin started. */
    shutdown: AbortSignal;
    /** Saved thumbnails. */
    thumbnailDir: string;
    /** Pinned downloads. */
    mediaDir: string;
    /** Watch-once copies. */
    cacheDir: string;
    /** Hashes and checks admin passwords; bcrypt at its default cost if omitted. */
    hasher?: PasswordHasher;
    /** How long an admin login lasts; 30 days if omitted. */
    sessionLifetimeMs?: number;
};

/** The dependencies with defaults filled in, plus the state the web layer keeps itself. */
export type Services = Required<WebDependencies> & {
    sessions: Sessions;
    limiter: LoginLimiter;
    setupCode: SetupCode;
};
