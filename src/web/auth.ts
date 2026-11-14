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
export interface Sessions {
  byToken: Map<string, Session>;
  lifetimeMs: number;
  now: () => number;
}

export const createSessions = (lifetimeMs: number, now: () => number): Sessions => ({
  byToken: new Map(),
  lifetimeMs,
  now,
});

/** Starts a session for a user and returns its random token and when it expires. */
export function createSession(sessions: Sessions, userId: number): { token: string; expiresAt: number } {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const now = sessions.now();
  for (const [existing, session] of sessions.byToken) {
    if (now >= session.expiresAt) {
      sessions.byToken.delete(existing); // keeps the map from growing forever
    }
  }
  const expiresAt = now + sessions.lifetimeMs;
  sessions.byToken.set(token, { userId, expiresAt });
  return { token, expiresAt };
}

/** The user a token belongs to, if the session has not expired or been removed. */
export function lookupSession(sessions: Sessions, token: string): number | undefined {
  const session = sessions.byToken.get(token);
  if (session === undefined) {
    return undefined;
  }
  if (sessions.now() >= session.expiresAt) {
    sessions.byToken.delete(token);
    return undefined;
  }
  return session.userId;
}

export function removeSession(sessions: Sessions, token: string): void {
  sessions.byToken.delete(token);
}

/** Ends every session of a user except the one identified by `keep`. */
export function removeOtherSessions(sessions: Sessions, userId: number, keep: string): void {
  for (const [token, session] of sessions.byToken) {
    if (session.userId === userId && token !== keep) {
      sessions.byToken.delete(token);
    }
  }
}

/**
 * Refuses further attempts once too many wrong passwords or setup codes have been entered
 * within a short window. It counts every failure together rather than per device, because
 * behind a home network all devices can look the same.
 */
export interface LoginLimiter {
  failures: number[];
  now: () => number;
}

export const createLoginLimiter = (now: () => number): LoginLimiter => ({ failures: [], now });

const recentFailures = (limiter: LoginLimiter): number[] => {
  const cutoff = limiter.now() - failedLoginWindowMs;
  return limiter.failures.filter((failure) => failure > cutoff);
};

/** Whether attempts are currently being refused. */
export function isLoginBlocked(limiter: LoginLimiter): boolean {
  limiter.failures = recentFailures(limiter);
  return limiter.failures.length >= maxFailedLogins;
}

export function recordLoginFailure(limiter: LoginLimiter): void {
  limiter.failures = [...recentFailures(limiter), limiter.now()];
}

/** Typed codes are forgiving: case, spaces and the dash do not matter. */
export function normaliseCode(typed: string): string {
  return typed.toUpperCase().replace(/[ -]/g, "");
}

/**
 * The one-time code that proves whoever is creating the first admin account can read the
 * app's log. It exists only in memory and is cleared once setup succeeds.
 */
export interface SetupCode {
  code: string;
  log: (message: string) => void;
}

export const createSetupCode = (log: (message: string) => void): SetupCode => ({ code: "", log });

/** The setup code, created (and printed to the log) if there is none. */
export function currentSetupCode(setupCode: SetupCode): string {
  if (setupCode.code === "") {
    setupCode.code = Array.from(
      crypto.getRandomValues(new Uint8Array(8)),
      (byte) => codeAlphabet[byte % codeAlphabet.length],
    ).join("");
    setupCode.log(
      `No admin account exists yet. Open /admin and enter this setup code: ${setupCode.code.slice(0, 4)}-${setupCode.code.slice(4)}`,
    );
  }
  return setupCode.code;
}

/** Compares a typed code with the current one in constant time. */
export function setupCodeMatches(setupCode: SetupCode, typed: string): boolean {
  const wanted = Buffer.from(currentSetupCode(setupCode));
  const given = Buffer.from(normaliseCode(typed));
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export function clearSetupCode(setupCode: SetupCode): void {
  setupCode.code = "";
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
