import { describe, expect, test } from "bun:test";
import { advanceTime } from "../../tests/helpers.ts";
import { adminPassword, adminUsername, buildEnvironment, logIn, send } from "../web/harness.ts";
import { changeForm, changePassword, replacementPassword, tryLogIn } from "./test-helpers.ts";
import { getUserByUsername } from "./users.ts";

describe("changing the password", () => {
    test("the new password works and the old one stops", async () => {
        const environment = await buildEnvironment();
        const cookie = await logIn(environment);
        const message = await changePassword(
            environment,
            cookie,
            changeForm(adminPassword, replacementPassword, replacementPassword),
        );
        expect(message).toContain("Password changed");
        expect(await tryLogIn(environment, adminUsername, replacementPassword)).toBeDefined();
        expect(await tryLogIn(environment, adminUsername, adminPassword)).toBeUndefined();
    });

    test("stores a new bcrypt hash, never the password", async () => {
        const environment = await buildEnvironment();
        const before = getUserByUsername(adminUsername)?.passwordHash;
        const cookie = await logIn(environment);
        await changePassword(environment, cookie, changeForm(adminPassword, replacementPassword, replacementPassword));
        const hash = getUserByUsername(adminUsername)?.passwordHash ?? "";
        expect(hash).not.toBe(before);
        expect(hash).not.toContain("passphrase");
        expect(await Bun.password.verify(replacementPassword, hash)).toBe(true);
    });

    test("keeps this session but ends all others", async () => {
        const environment = await buildEnvironment();
        const current = await logIn(environment);
        const other = await logIn(environment);
        await changePassword(environment, current, changeForm(adminPassword, replacementPassword, replacementPassword));
        expect((await send(environment, "/admin", { cookie: current })).status).toBe(200);
        expect((await send(environment, "/admin", { cookie: other })).status).toBe(303);
    });

    test("refuses a wrong current password", async () => {
        const environment = await buildEnvironment();
        const cookie = await logIn(environment);
        const message = await changePassword(
            environment,
            cookie,
            changeForm("not my password", replacementPassword, replacementPassword),
        );
        expect(message).toContain("current password is wrong");
        expect(await tryLogIn(environment, adminUsername, adminPassword)).toBeDefined();
    });

    test.each([
        ["too short", "short", "short", "at least 8"],
        ["too long", "p".repeat(73), "p".repeat(73), "at most 72"],
        ["a confirmation that differs", replacementPassword, `${replacementPassword}x`, "do not match"],
        ["empty", "", "", "at least 8"],
    ])("refuses a new password that is %s", async (_name, replacement, confirm, expected) => {
        const environment = await buildEnvironment();
        const cookie = await logIn(environment);
        const message = await changePassword(environment, cookie, changeForm(adminPassword, replacement, confirm));
        expect(message).toContain(expected);
        expect(await tryLogIn(environment, adminUsername, adminPassword)).toBeDefined();
    });

    test("wrong current passwords are rate limited", async () => {
        const environment = await buildEnvironment();
        const cookie = await logIn(environment);
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await changePassword(environment, cookie, changeForm("guess", replacementPassword, replacementPassword));
        }
        const limited = await changePassword(
            environment,
            cookie,
            changeForm(adminPassword, replacementPassword, replacementPassword),
        );
        expect(limited).toContain("Too many");
        expect(await tryLogIn(environment, adminUsername, replacementPassword)).toBeUndefined();
        advanceTime(61 * 1000);
        const later = await changePassword(
            environment,
            cookie,
            changeForm(adminPassword, replacementPassword, replacementPassword),
        );
        expect(later).toContain("Password changed");
    });

    test("requires a login", async () => {
        const environment = await buildEnvironment();
        const response = await send(environment, "/admin/password", {
            form: changeForm(adminPassword, replacementPassword, replacementPassword),
        });
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/admin/login");
        expect(await tryLogIn(environment, adminUsername, replacementPassword)).toBeUndefined();
    });

    test("rejects cross-site posts", async () => {
        const environment = await buildEnvironment();
        const response = await send(environment, "/admin/password", {
            cookie: await logIn(environment),
            form: changeForm(adminPassword, replacementPassword, replacementPassword),
            headers: { "sec-fetch-site": "cross-site" },
        });
        expect(response.status).toBe(403);
        expect(await tryLogIn(environment, adminUsername, replacementPassword)).toBeUndefined();
    });
});
