import { describe, expect, spyOn, test } from "bun:test";
import { createFirstUser, deleteUsers, getUserByUsername, getVideo } from "../db/store.ts";
import * as passwords from "../passwords.ts";
import {
  createLoginLimiter,
  createSession,
  createSessions,
  isLoginBlocked,
  lookupSession,
  normaliseCode,
  recordLoginFailure,
  removeOtherSessions,
  removeSession,
  usernameProblem,
} from "./auth.ts";
import {
  failLogins,
  loginForm,
  postLogin,
  sessionCookieHeader,
  tryLogIn,
  withHasher,
} from "./auth-helpers.ts";
import {
  adminPassword,
  adminUsername,
  advanceClock,
  allow,
  buildEnvironment,
  createFakeClock,
  logIn,
  send,
  sessionCookie,
} from "./harness.ts";

const minute = 60 * 1000;
const thirtyDays = 30 * 24 * 60 * minute;
const videoId = "abcdefghijk";

describe("the login page", () => {
  test("shows a form with username and password", async () => {
    const environment = await buildEnvironment();
    const response = await send(environment, "/admin/login");
    const body = await response.text();
    for (const wanted of ['name="username"', 'type="password"', 'action="/admin/login"']) {
      expect(body).toContain(wanted);
    }
    expect(response.status).toBe(200);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  test("already logged in visitors skip the form", async () => {
    const environment = await buildEnvironment();
    const cookie = await logIn(environment);
    const response = await send(environment, "/admin/login", { cookie });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin");
  });
});

describe("logging in", () => {
  test("correct credentials start a session and go to the admin page", async () => {
    const environment = await buildEnvironment();
    const response = await postLogin(environment, loginForm(adminUsername, adminPassword));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin");
    const cookie = sessionCookie(response);
    expect(cookie).toBeDefined();
    expect((await send(environment, "/admin", { cookie })).status).toBe(200);
  });

  test("the username is case insensitive and trimmed", async () => {
    const environment = await buildEnvironment();
    for (const username of ["PARENT", "Parent", "  parent  "]) {
      expect(await tryLogIn(environment, username, adminPassword)).toBeDefined();
    }
  });

  test("the password is case sensitive", async () => {
    const environment = await buildEnvironment();
    expect(await tryLogIn(environment, adminUsername, adminPassword.toUpperCase())).toBeUndefined();
  });

  test("the session cookie is locked down", async () => {
    const environment = await buildEnvironment();
    const response = await postLogin(environment, loginForm(adminUsername, adminPassword));
    const header = sessionCookieHeader(response) ?? "";
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/admin");
    expect(header).toContain(`Max-Age=${thirtyDays / 1000}`);
    expect(header).not.toContain("Secure");
  });

  test("the cookie is secure when served over https", async () => {
    const environment = await buildEnvironment();
    const response = await postLogin(environment, loginForm(adminUsername, adminPassword), {
      "x-forwarded-proto": "https",
    });
    expect(sessionCookieHeader(response)).toContain("Secure");
  });

  test("returns to the page the visitor was trying to reach", async () => {
    const environment = await buildEnvironment();
    const response = await postLogin(
      environment,
      loginForm(adminUsername, adminPassword, "/admin?channel=UC1&page=2"),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin?channel=UC1&page=2");
  });

  test("never redirects outside the admin area", async () => {
    const environment = await buildEnvironment();
    const unsafeDestinations = [
      "https://evil.example/admin",
      "//evil.example/admin",
      "/",
      "/watch/abc",
      "/adminx",
      "/admin/login",
      "/admin/setup",
      "/admin\\evil",
      "javascript:alert(1)",
      "",
    ];
    for (const next of unsafeDestinations) {
      const response = await postLogin(environment, loginForm(adminUsername, adminPassword, next));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/admin");
    }
  });

  test("a wrong username and a wrong password get the same response", async () => {
    const environment = await buildEnvironment();
    const wrongPassword = await postLogin(environment, loginForm(adminUsername, "not the password"));
    const wrongUser = await postLogin(environment, loginForm("nobody", adminPassword));
    for (const response of [wrongPassword, wrongUser]) {
      expect(response.status).toBe(401);
      expect(sessionCookie(response)).toBeUndefined();
    }
    const wrongUserBody = await wrongUser.text();
    expect(wrongUserBody).toContain("Wrong username or password.");
    for (const leak of ["unknown user", "no such user", "user does not exist", "incorrect password"]) {
      expect(wrongUserBody.toLowerCase()).not.toContain(leak);
    }
  });

  test("a failed attempt keeps the username and destination but never the password", async () => {
    const environment = await buildEnvironment();
    const response = await postLogin(
      environment,
      loginForm(adminUsername, "wrong-password-123", "/admin?channel=UC1"),
    );
    const body = await response.text();
    expect(body).toContain('value="/admin?channel=UC1"');
    expect(body).toContain('value="parent"');
    expect(body).not.toContain("wrong-password-123");
  });

  test("an unknown username still costs a password check so timing reveals nothing", async () => {
    const dummyChecks = spyOn(passwords, "spendTimeVerifying");
    const realChecks = spyOn(passwords, "verifyPassword");
    const environment = await buildEnvironment();

    await postLogin(environment, loginForm("nobody", "whatever-password"));
    const dummiesAfterUnknownUser = dummyChecks.mock.calls.length;
    const realChecksAfterUnknownUser = realChecks.mock.calls.length;
    await postLogin(environment, loginForm(adminUsername, "whatever-password"));

    expect(dummiesAfterUnknownUser).toBe(1);
    expect(dummyChecks.mock.calls.length).toBe(1); // a known user costs one real check and no extra dummy
    expect(realChecks.mock.calls.length - realChecksAfterUnknownUser).toBe(1);
    dummyChecks.mockRestore();
    realChecks.mockRestore();
  });

  test("upgrades a password hash made at an older cost", async () => {
    const original = await buildEnvironment();
    const stronger = passwords.createPasswordHasher(5);
    const environment = withHasher(original, stronger);
    const oldHash = getUserByUsername(original.store, adminUsername)?.passwordHash ?? "";

    expect(await tryLogIn(environment, adminUsername, adminPassword)).toBeDefined();

    const newHash = getUserByUsername(environment.store, adminUsername)?.passwordHash ?? "";
    expect(newHash).not.toBe(oldHash);
    expect(await passwords.verifyPassword(newHash, adminPassword)).toBe(true);
    expect(passwords.needsUpgrade(stronger, newHash)).toBe(false);
  });

  test("does not rehash when the cost is already current", async () => {
    const environment = await buildEnvironment();
    const before = getUserByUsername(environment.store, adminUsername)?.passwordHash;
    await logIn(environment);
    expect(getUserByUsername(environment.store, adminUsername)?.passwordHash).toBe(before);
  });

  test("HTTP basic credentials no longer work", async () => {
    const environment = await buildEnvironment();
    const authorization = `Basic ${btoa(`${adminUsername}:${adminPassword}`)}`;
    const response = await send(environment, "/admin", { headers: { authorization } });
    expect(response.status).toBe(303);
  });
});

describe("cross-origin protection", () => {
  test("rejects cross-site login posts", async () => {
    const environment = await buildEnvironment();
    const response = await postLogin(environment, loginForm(adminUsername, adminPassword), {
      "sec-fetch-site": "cross-site",
    });
    expect(response.status).toBe(403);
    expect(sessionCookie(response)).toBeUndefined();
  });

  test("accepts same-origin and direct navigations", async () => {
    const environment = await buildEnvironment();
    for (const site of ["same-origin", "none"]) {
      const response = await postLogin(environment, loginForm(adminUsername, adminPassword), {
        "sec-fetch-site": site,
      });
      expect(response.status).toBe(303);
    }
  });

  test("without Sec-Fetch-Site, rejects an Origin that differs from the host", async () => {
    const environment = await buildEnvironment();
    const response = await postLogin(environment, loginForm(adminUsername, adminPassword), {
      origin: "https://evil.example",
      host: "tube.home",
    });
    expect(response.status).toBe(403);
  });

  test("without Sec-Fetch-Site, accepts an Origin that matches the host", async () => {
    const environment = await buildEnvironment();
    const response = await postLogin(environment, loginForm(adminUsername, adminPassword), {
      origin: "http://tube.home",
      host: "tube.home",
    });
    expect(response.status).toBe(303);
  });

  test("never blocks safe methods", async () => {
    const environment = await buildEnvironment();
    const response = await send(environment, "/", { headers: { "sec-fetch-site": "cross-site" } });
    expect(response.status).toBe(200);
  });
});

describe("protected pages", () => {
  test.each([
    ["the admin page", "GET", "/admin", "/admin/login?next=%2Fadmin"],
    [
      "the admin page with a filter",
      "GET",
      "/admin?channel=UC1&page=2",
      "/admin/login?next=%2Fadmin%3Fchannel%3DUC1%26page%3D2",
    ],
    ["an action", "POST", `/admin/videos/${videoId}/pin`, "/admin/login"],
    ["sync", "POST", "/admin/sync", "/admin/login"],
    ["adding", "POST", "/admin/add", "/admin/login"],
    ["channel removal", "POST", "/admin/channels/1/remove", "/admin/login"],
    ["changing the password", "POST", "/admin/password", "/admin/login"],
    ["an unknown admin path", "GET", "/admin/anything", "/admin/login?next=%2Fadmin%2Fanything"],
  ])("%s redirects to the login form when not logged in", async (_name, method, path, target) => {
    const environment = await buildEnvironment();
    allow(environment, { youtubeId: videoId, title: "Song" });
    const response = await send(environment, path, { method });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(target);
    expect(getVideo(environment.store, videoId)?.pinned).toBe(false);
  });

  test("pages are not cached, so back after logout shows nothing", async () => {
    const environment = await buildEnvironment();
    const response = await send(environment, "/admin", { cookie: await logIn(environment) });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("forged or garbage session cookies are rejected", async () => {
    const environment = await buildEnvironment();
    for (const value of ["", "garbage", "A".repeat(43), "../../etc/passwd"]) {
      const response = await send(environment, "/admin", { cookie: `tubestop_admin=${value}` });
      expect(response.status).toBe(303);
    }
  });

  test("sessions are independent", async () => {
    const environment = await buildEnvironment();
    const first = await logIn(environment);
    const second = await logIn(environment);
    await send(environment, "/admin/logout", { method: "POST", cookie: first });
    expect((await send(environment, "/admin", { cookie: first })).status).toBe(303);
    expect((await send(environment, "/admin", { cookie: second })).status).toBe(200);
    expect(first).not.toBe(second);
  });

  test("the page shows who is logged in and offers logout and password change", async () => {
    const environment = await buildEnvironment();
    const body = await (await send(environment, "/admin", { cookie: await logIn(environment) })).text();
    for (const wanted of [
      "Logged in as",
      "<strong>parent</strong>",
      'action="/admin/logout"',
      'action="/admin/password"',
    ]) {
      expect(body).toContain(wanted);
    }
  });
});

describe("session expiry and logout", () => {
  test("a session works until its lifetime ends and then stops", async () => {
    const environment = await buildEnvironment();
    const cookie = await logIn(environment);
    advanceClock(environment.clock, thirtyDays - minute);
    expect((await send(environment, "/admin", { cookie })).status).toBe(200);
    advanceClock(environment.clock, 2 * minute);
    expect((await send(environment, "/admin", { cookie })).status).toBe(303);
  });

  test("the lifetime is configurable", async () => {
    const environment = await buildEnvironment({ sessionLifetimeMs: 60 * minute });
    const cookie = await logIn(environment);
    advanceClock(environment.clock, 59 * minute);
    expect((await send(environment, "/admin", { cookie })).status).toBe(200);
    advanceClock(environment.clock, 2 * minute);
    expect((await send(environment, "/admin", { cookie })).status).toBe(303);
  });

  test("logout ends the session and clears the cookie", async () => {
    const environment = await buildEnvironment();
    const cookie = await logIn(environment);
    const response = await send(environment, "/admin/logout", { method: "POST", cookie });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/login");
    expect(sessionCookieHeader(response)).toContain("Max-Age=0");
    expect((await send(environment, "/admin", { cookie })).status).toBe(303);
  });

  test("logout without a session is harmless", async () => {
    const environment = await buildEnvironment();
    const response = await send(environment, "/admin/logout", { method: "POST" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/login");
  });
});

describe("accounts that disappear", () => {
  test("a session stops working when its account is deleted and the admin goes to setup", async () => {
    const environment = await buildEnvironment();
    const cookie = await logIn(environment);
    deleteUsers(environment.store);
    const response = await send(environment, "/admin", { cookie });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/setup");
  });

  test("a session of a deleted account never works for a new account", async () => {
    const environment = await buildEnvironment();
    const oldCookie = await logIn(environment);
    deleteUsers(environment.store);
    createFirstUser(environment.store, "someone-new", "irrelevant");
    const response = await send(environment, "/admin", { cookie: oldCookie });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toStartWith("/admin/login");
  });
});

describe("brute force protection", () => {
  test("five wrong passwords in a minute block further tries even with the right password", async () => {
    const environment = await buildEnvironment();
    await failLogins(environment, 5);
    const response = await postLogin(environment, loginForm(adminUsername, adminPassword));
    expect(response.status).toBe(429);
    expect(sessionCookie(response)).toBeUndefined();
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.text()).toContain("Wait a minute");
  });

  test("unknown usernames count towards the limit too", async () => {
    const environment = await buildEnvironment();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await postLogin(environment, loginForm(`guess-${attempt}`, "wrong-password"));
    }
    expect((await postLogin(environment, loginForm(adminUsername, adminPassword))).status).toBe(429);
  });

  test("four wrong passwords do not block the right one", async () => {
    const environment = await buildEnvironment();
    await failLogins(environment, 4);
    expect(await tryLogIn(environment, adminUsername, adminPassword)).toBeDefined();
  });

  test("login works again once the minute has passed", async () => {
    const environment = await buildEnvironment();
    await failLogins(environment, 5);
    advanceClock(environment.clock, 61 * 1000);
    expect(await tryLogIn(environment, adminUsername, adminPassword)).toBeDefined();
  });

  test("old failures age out rather than adding up forever", async () => {
    const environment = await buildEnvironment();
    await failLogins(environment, 4);
    advanceClock(environment.clock, 61 * 1000);
    await failLogins(environment, 4);
    expect(await tryLogIn(environment, adminUsername, adminPassword)).toBeDefined();
  });

  test("blocked attempts do not extend the block", async () => {
    const environment = await buildEnvironment();
    await failLogins(environment, 5);
    await failLogins(environment, 10);
    advanceClock(environment.clock, 61 * 1000);
    expect(await tryLogIn(environment, adminUsername, adminPassword)).toBeDefined();
  });
});

describe("sessions", () => {
  test("looks up a created session until it expires", () => {
    const clock = createFakeClock();
    const sessions = createSessions(1000, () => clock.milliseconds);
    const { token, expiresAt } = createSession(sessions, 7);
    expect(expiresAt).toBe(clock.milliseconds + 1000);
    expect(lookupSession(sessions, token)).toBe(7);
    advanceClock(clock, 1000);
    expect(lookupSession(sessions, token)).toBeUndefined();
  });

  test("removeOthers keeps only the given session of that user", () => {
    const sessions = createSessions(1000, () => createFakeClock().milliseconds);
    const kept = createSession(sessions, 1).token;
    const dropped = createSession(sessions, 1).token;
    const otherUser = createSession(sessions, 2).token;
    removeOtherSessions(sessions, 1, kept);
    expect(lookupSession(sessions, kept)).toBe(1);
    expect(lookupSession(sessions, dropped)).toBeUndefined();
    expect(lookupSession(sessions, otherUser)).toBe(2);
  });

  test("remove ends a session", () => {
    const sessions = createSessions(1000, () => createFakeClock().milliseconds);
    const { token } = createSession(sessions, 1);
    removeSession(sessions, token);
    expect(lookupSession(sessions, token)).toBeUndefined();
  });
});

describe("login limiter", () => {
  test("blocks after five failures and unblocks when they leave the window", () => {
    const clock = createFakeClock();
    const limiter = createLoginLimiter(() => clock.milliseconds);
    for (let failure = 0; failure < 5; failure += 1) {
      expect(isLoginBlocked(limiter)).toBe(false);
      recordLoginFailure(limiter);
    }
    expect(isLoginBlocked(limiter)).toBe(true);
    advanceClock(clock, minute + 1);
    expect(isLoginBlocked(limiter)).toBe(false);
  });
});

describe("usernameProblem and normaliseCode", () => {
  test.each([
    ["", "Choose a username."],
    ["n".repeat(65), "at most 64"],
    ["mum\u0007", "control characters"],
    ["mum", undefined],
    ["n".repeat(64), undefined],
  ])("usernameProblem(%j)", (username, expected) => {
    const problem = usernameProblem(username);
    expect(expected === undefined ? problem : problem?.includes(expected)).toBe(
      expected === undefined ? undefined : true,
    );
  });

  test("normaliseCode ignores case, spaces and dashes", () => {
    expect(normaliseCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normaliseCode("abcd efgh")).toBe("ABCDEFGH");
  });
});
