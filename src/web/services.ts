import type { Store } from "../db/store.ts";
import type { PasswordHasher } from "../passwords.ts";
import type { ThumbnailStore } from "../thumbnails.ts";
import type { ResolveUrl } from "../ytdlp/types.ts";
import type { LoginLimiter, SessionStore, SetupCode } from "./auth.ts";

/** Everything the web layer needs from the rest of the app. */
export interface WebDependencies {
  store: Store;
  resolveUrl: ResolveUrl;
  syncer: { trigger(): void };
  downloads: { triggerPins(): void; triggerCache(): void };
  thumbnails: ThumbnailStore;
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
  sessions: SessionStore;
  limiter: LoginLimiter;
  setupCode: SetupCode;
}
