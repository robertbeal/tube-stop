import type { Database } from "bun:sqlite";
import type { LoginLimiter, Sessions, SetupCode } from "../admin/auth.ts";
import type { PasswordHasher } from "../admin/passwords.ts";
import type { ResolveUrl } from "../ytdlp/types.ts";

/** Everything the web layer needs from the rest of the app. */
export type WebDependencies = {
    database: Database;
    resolveUrl: ResolveUrl;
    /** Starts a sync of every channel and resolves when it is done. It does not fail. */
    syncNow: () => Promise<void>;
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
