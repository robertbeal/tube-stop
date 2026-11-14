import type { LoginLimiter, Sessions, SetupCode } from "../admin/auth.ts";
import type { PasswordHasher } from "../admin/passwords.ts";
import type { Store } from "../db/store.ts";
import type { Thumbnail } from "../thumbnails.ts";
import type { ResolveUrl } from "../ytdlp/types.ts";

/** Everything the web layer needs from the rest of the app. */
export interface WebDependencies {
  store: Store;
  resolveUrl: ResolveUrl;
  /** Starts a sync of every channel and resolves when it is done. It does not fail. */
  syncNow: () => Promise<void>;
  thumbnails: Thumbnail;
  /** Pinned downloads. */
  mediaDir: string;
  /** Watch-once copies. */
  cacheDir: string;
  /** Hashes and checks admin passwords; bcrypt at its default cost if omitted. */
  hasher?: PasswordHasher;
  /** How long an admin login lasts; 30 days if omitted. */
  sessionLifetimeMs?: number;
  /** The current time in milliseconds; the real clock if omitted. Tests replace it. */
  now?: () => number;
  /** Where messages go; the console if omitted. */
  log?: (message: string) => void;
}

/** The dependencies with defaults filled in, plus the state the web layer keeps itself. */
export interface Services extends Required<WebDependencies> {
  sessions: Sessions;
  limiter: LoginLimiter;
  setupCode: SetupCode;
}
