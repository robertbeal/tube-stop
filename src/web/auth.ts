import { timingSafeEqual } from "node:crypto";

export const sessionCookieName = "tubestop_admin";
export const loginPath = "/admin/login";
export const setupPath = "/admin/setup";

const maxFailedLogins = 5;
const failedLoginWindowMs = 60 * 1000;
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes (0/O, 1/I); 32 symbols divide 256 evenly

interface Session {
  userId: number;
  expiresAt: number;
}

/**
 * Remembers which admin login tokens are valid and whose they are. It lives in memory, so a
 * restart logs everyone out, which for a single admin just means logging in again.
 */
export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly lifetimeMs: number;
  readonly #now: () => number;

  constructor(lifetimeMs: number, now: () => number) {
    this.lifetimeMs = lifetimeMs;
    this.#now = now;
  }

  /** Starts a session for a user and returns its random token and when it expires. */
  create(userId: number): { token: string; expiresAt: number } {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const now = this.#now();
    for (const [existing, session] of this.#sessions) {
      if (now >= session.expiresAt) {
        this.#sessions.delete(existing); // keeps the map from growing forever
      }
    }
    const expiresAt = now + this.lifetimeMs;
    this.#sessions.set(token, { userId, expiresAt });
    return { token, expiresAt };
  }

  /** The user a token belongs to, if the session has not expired or been removed. */
  lookup(token: string): number | undefined {
    const session = this.#sessions.get(token);
    if (session === undefined) {
      return undefined;
    }
    if (this.#now() >= session.expiresAt) {
      this.#sessions.delete(token);
      return undefined;
    }
    return session.userId;
  }

  remove(token: string): void {
    this.#sessions.delete(token);
  }

  /** Ends every session of a user except the one identified by `keep`. */
  removeOthers(userId: number, keep: string): void {
    for (const [token, session] of this.#sessions) {
      if (session.userId === userId && token !== keep) {
        this.#sessions.delete(token);
      }
    }
  }
}

/**
 * Refuses further attempts once too many wrong passwords or setup codes have been entered
 * within a short window. It counts every failure together rather than per device, because
 * behind a home network all devices can look the same.
 */
export class LoginLimiter {
  #failures: number[] = [];
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  #recent(): number[] {
    const cutoff = this.#now() - failedLoginWindowMs;
    return this.#failures.filter((failure) => failure > cutoff);
  }

  /** Whether attempts are currently being refused. */
  blocked(): boolean {
    this.#failures = this.#recent();
    return this.#failures.length >= maxFailedLogins;
  }

  recordFailure(): void {
    this.#failures = [...this.#recent(), this.#now()];
  }
}

/** Typed codes are forgiving: case, spaces and the dash do not matter. */
export function normaliseCode(typed: string): string {
  return typed.toUpperCase().replace(/[ -]/g, "");
}

/**
 * The one-time code that proves whoever is creating the first admin account can read the
 * app's log. It exists only in memory and is cleared once setup succeeds.
 */
export class SetupCode {
  #code = "";
  readonly #log: (message: string) => void;

  constructor(log: (message: string) => void) {
    this.#log = log;
  }

  /** The setup code, created (and printed to the log) if there is none. */
  current(): string {
    if (this.#code === "") {
      this.#code = Array.from(
        crypto.getRandomValues(new Uint8Array(8)),
        (byte) => codeAlphabet[byte % codeAlphabet.length],
      ).join("");
      this.#log(
        `No admin account exists yet. Open /admin and enter this setup code: ${this.#code.slice(0, 4)}-${this.#code.slice(4)}`,
      );
    }
    return this.#code;
  }

  /** Compares a typed code with the current one in constant time. */
  matches(typed: string): boolean {
    const wanted = Buffer.from(this.current());
    const given = Buffer.from(normaliseCode(typed));
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }

  clear(): void {
    this.#code = "";
  }
}

/** Returns `next` if it is a page inside the admin area, and "/admin" otherwise, so the login form cannot send someone to another site. */
export function safeNext(next: string): string {
  const fallback = "/admin";
  if (!next.startsWith(fallback) || /[\\\r\n]/.test(next)) {
    return fallback;
  }
  const rest = next.slice(fallback.length);
  if (rest !== "" && !rest.startsWith("/") && !rest.startsWith("?")) {
    return fallback; // not /adminx
  }
  const parsed = URL.parse(next, "http://placeholder.invalid");
  if (parsed === null || parsed.host !== "placeholder.invalid") {
    return fallback;
  }
  const insideAuthPages = [loginPath, setupPath].some((page) => parsed.pathname.startsWith(page));
  return insideAuthPages ? fallback : next;
}

const maxUsernameLength = 64;

/** A message for the user if `username` (already trimmed) cannot be used for a new account, or undefined if it is fine. */
export function usernameProblem(username: string): string | undefined {
  if (username === "") {
    return "Choose a username.";
  }
  if ([...username].length > maxUsernameLength) {
    return `The username can be at most ${maxUsernameLength} characters.`;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is being refused
  if (/[\u0000-\u001f\u007f-\u009f]/.test(username)) {
    return "The username cannot contain control characters.";
  }
  return undefined;
}

export function capitalise(text: string): string {
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}
