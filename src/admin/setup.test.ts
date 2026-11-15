import { describe, expect, spyOn, test } from "bun:test";
import { advanceTime } from "../../tests/helpers.ts";
import { logger } from "../util/logger.ts";
import { buildEnvironment, send, sessionCookie } from "../web/harness.ts";
import { clearSetupCode, currentSetupCode, type SetupCode, setupCodeMatches } from "./auth.ts";
import { loggedSetupCode, newPassword, newUsername, postSetup, setupForm, tryLogIn } from "./test-helpers.ts";
import { countUsers, deleteUsers, getUserByUsername } from "./users.ts";

const unclaimed = () => buildEnvironment({ withAdmin: false });

describe("the setup code", () => {
    test("is printed in the log on first start", async () => {
        expect(loggedSetupCode(await unclaimed())).not.toBe("");
    });

    test("is not printed when an admin already exists", async () => {
        const environment = await buildEnvironment();
        expect(environment.logs.join("\n")).not.toContain("setup code");
    });

    test("looks like eight unambiguous characters", async () => {
        const codes = await Promise.all(Array.from({ length: 20 }, async () => loggedSetupCode(await unclaimed())));
        for (const code of codes) {
            expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
            expect(code).not.toMatch(/[01OI]/);
        }
        expect(new Set(codes).size).toBeGreaterThanOrEqual(19);
    });

    test("is never shown on the setup page", async () => {
        const environment = await unclaimed();
        const code = loggedSetupCode(environment);
        const body = await (await send(environment, "/admin/setup")).text();
        expect(body).not.toContain(code);
        expect(body).not.toContain(code.replace("-", ""));
    });

    test("a started app without an admin prints a different code each time", async () => {
        expect(loggedSetupCode(await unclaimed())).not.toBe(loggedSetupCode(await unclaimed()));
    });

    test("is created once and then reused until cleared", () => {
        const logged = spyOn(logger, "info");
        const setupCode: SetupCode = { code: "" };
        const first = currentSetupCode(setupCode);
        expect(currentSetupCode(setupCode)).toBe(first);
        expect(logged.mock.calls).toHaveLength(1);
        clearSetupCode(setupCode);
        expect(setupCodeMatches(setupCode, first)).toBe(false);
        expect(logged.mock.calls).toHaveLength(2);
    });
});

describe("without an admin", () => {
    test.each([
        ["GET", "/admin"],
        ["GET", "/admin?channel=UC1"],
        ["GET", "/admin/login"],
        ["POST", "/admin/login"],
        ["POST", "/admin/sync"],
        ["POST", "/admin/videos/abcdefghijk/pin"],
        ["POST", "/admin/password"],
    ])("%s %s leads to setup", async (method, path) => {
        const response = await send(await unclaimed(), path, { method });
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/admin/setup");
    });

    test("the child side still works", async () => {
        expect((await send(await unclaimed(), "/")).status).toBe(200);
    });

    test("the setup page shows the form with all fields", async () => {
        const response = await send(await unclaimed(), "/admin/setup");
        const body = await response.text();
        for (const wanted of [
            'name="code"',
            'name="username"',
            'name="password"',
            'name="confirm"',
            'action="/admin/setup"',
        ]) {
            expect(body).toContain(wanted);
        }
        expect(response.status).toBe(200);
        expect(response.headers.get("www-authenticate")).toBeNull();
    });
});

describe("setting up", () => {
    test("the right code creates the admin and logs them in", async () => {
        const environment = await unclaimed();
        const code = loggedSetupCode(environment);
        const response = await postSetup(environment, setupForm(code, newUsername, newPassword, newPassword));
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/admin");
        const cookie = sessionCookie(response);
        expect(cookie).toBeDefined();
        expect((await send(environment, "/admin", { cookie })).status).toBe(200);
        expect(await tryLogIn(environment, newUsername, newPassword)).toBeDefined();
    });

    test("stores only a bcrypt hash, never the password", async () => {
        const environment = await unclaimed();
        const code = loggedSetupCode(environment);
        await postSetup(environment, setupForm(code, newUsername, newPassword, newPassword));
        const hash = getUserByUsername(newUsername)?.passwordHash ?? "";
        expect(hash).not.toContain("enough");
        expect(hash).toMatch(/^\$2[aby]\$\d\d\$/);
        expect(await Bun.password.verify(newPassword, hash)).toBe(true);
    });

    test.each([
        ["lower case", (code: string) => code.toLowerCase()],
        ["without the dash", (code: string) => code.replace("-", "")],
        ["surrounded by spaces", (code: string) => `  ${code}  `],
        ["lower case with a space for the dash", (code: string) => code.replace("-", " ").toLowerCase()],
    ])("the code is forgiving when typed %s", async (_name, format) => {
        const environment = await unclaimed();
        const typed = format(loggedSetupCode(environment));
        const response = await postSetup(environment, setupForm(typed, newUsername, newPassword, newPassword));
        expect(response.status).toBe(303);
    });

    test("a wrong code is refused and creates nothing", async () => {
        const environment = await unclaimed();
        const wrongCodes = ["", "AAAA-AAAA", "nonsense", `${loggedSetupCode(environment)}X`, "ABCD"];
        for (const wrong of wrongCodes) {
            const response = await postSetup(environment, setupForm(wrong, newUsername, newPassword, newPassword));
            expect(response.status).toBe(401);
            expect(await response.text()).toContain("Wrong setup code");
            expect(sessionCookie(response)).toBeUndefined();
        }
        expect(countUsers()).toBe(0);
    });

    test("wrong codes are rate limited, even for the right code afterwards", async () => {
        const environment = await unclaimed();
        const code = loggedSetupCode(environment);
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await postSetup(environment, setupForm("WRONG-CODE", newUsername, newPassword, newPassword));
        }
        const blocked = await postSetup(environment, setupForm(code, newUsername, newPassword, newPassword));
        advanceTime(61 * 1000);
        const later = await postSetup(environment, setupForm(code, newUsername, newPassword, newPassword));
        expect(blocked.status).toBe(429);
        expect(later.status).toBe(303);
    });

    test.each([
        ["an empty username", "", newPassword, newPassword, "Choose a username"],
        ["a blank username", "   ", newPassword, newPassword, "Choose a username"],
        ["a username that is too long", "n".repeat(65), newPassword, newPassword, "at most 64"],
        ["a control character in the username", "mum\u0007", newPassword, newPassword, "control characters"],
        ["a short password", newUsername, "short", "short", "at least 8"],
        ["a password that is too long", newUsername, "p".repeat(73), "p".repeat(73), "at most 72"],
        ["passwords that differ", newUsername, newPassword, `${newPassword}x`, "do not match"],
    ])("rejects %s without consuming the code", async (_name, username, password, confirm, message) => {
        const environment = await unclaimed();
        const code = loggedSetupCode(environment);
        const response = await postSetup(environment, setupForm(code, username, password, confirm));
        expect(response.status).toBe(422);
        const body = await response.text();
        expect(body).toContain(message);
        expect(body).not.toContain(`value="${password}"`);
        expect(countUsers()).toBe(0);
        const retry = await postSetup(environment, setupForm(code, newUsername, newPassword, newPassword));
        expect(retry.status).toBe(303);
    });

    test("keeps the username but not the password or code in the redisplayed form", async () => {
        const environment = await unclaimed();
        const code = loggedSetupCode(environment);
        const response = await postSetup(environment, setupForm(code, newUsername, "short", "short"));
        const body = await response.text();
        expect(body).toContain('value="mum"');
        expect(body).not.toContain(code);
    });
});

describe("once set up", () => {
    test("setup is gone once an admin exists", async () => {
        const environment = await unclaimed();
        const code = loggedSetupCode(environment);
        await postSetup(environment, setupForm(code, newUsername, newPassword, newPassword));
        const intruder = setupForm(code, "intruder", newPassword, newPassword);
        expect((await send(environment, "/admin/setup")).status).toBe(404);
        expect((await postSetup(environment, intruder)).status).toBe(404);
        expect(countUsers()).toBe(1);
    });

    test("setup is not available when the app starts with an existing admin", async () => {
        const environment = await buildEnvironment();
        expect((await send(environment, "/admin/setup")).status).toBe(404);
        expect((await send(environment, "/admin/setup", { method: "POST" })).status).toBe(404);
    });

    test("only one of many simultaneous attempts wins", async () => {
        const environment = await unclaimed();
        const code = loggedSetupCode(environment);
        const responses = await Promise.all(
            Array.from({ length: 10 }, (_unused, number) =>
                postSetup(environment, setupForm(code, `claimant${"x".repeat(number)}`, newPassword, newPassword)),
            ),
        );
        expect(responses.filter((response) => response.status === 303)).toHaveLength(1);
        expect(countUsers()).toBe(1);
    });
});

describe("after a reset", () => {
    test("a different setup code is printed and setup works again", async () => {
        const environment = await buildEnvironment();
        deleteUsers();
        const redirect = await send(environment, "/admin");
        await send(environment, "/admin/setup");
        const code = loggedSetupCode(environment);
        expect(redirect.headers.get("location")).toBe("/admin/setup");
        expect(code).not.toBe("");
        const response = await postSetup(environment, setupForm(code, newUsername, newPassword, newPassword));
        expect(response.status).toBe(303);
    });
});
