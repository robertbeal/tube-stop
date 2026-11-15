import { createApp } from "../web/app.tsx";
import { type Environment, send } from "../web/harness.ts";
import type { PasswordHasher } from "./passwords.ts";

export const newUsername = "mum";
export const newPassword = "a long enough password";
export const replacementPassword = "a brand new passphrase";

const setupCodePattern = /enter this setup code: ([A-Z0-9]{4}-[A-Z0-9]{4})/;

/** The setup code the app printed to its log, or an empty string if it printed none. */
export function loggedSetupCode(environment: Environment): string {
    return (
        environment.logs.map((message) => setupCodePattern.exec(message)?.[1]).find((code) => code !== undefined) ?? ""
    );
}

export function loginForm(username: string, password: string, next?: string): Record<string, string> {
    return next === undefined ? { username, password } : { username, password, next };
}

export function setupForm(code: string, username: string, password: string, confirm: string): Record<string, string> {
    return { code, username, password, confirm };
}

export function changeForm(current: string, replacement: string, confirm: string): Record<string, string> {
    return { current, new: replacement, confirm };
}

export function postLogin(
    environment: Environment,
    form: Record<string, string>,
    headers: Record<string, string> = {},
): Promise<Response> {
    return send(environment, "/admin/login", { form, headers });
}

export function postSetup(environment: Environment, form: Record<string, string>): Promise<Response> {
    return send(environment, "/admin/setup", { form });
}

export async function failLogins(environment: Environment, count: number): Promise<void> {
    for (let attempt = 0; attempt < count; attempt += 1) {
        await postLogin(environment, loginForm("parent", "wrong-password"));
    }
}

/** The cookie header value of a successful login, or undefined if the login was refused. */
export async function tryLogIn(
    environment: Environment,
    username: string,
    password: string,
): Promise<string | undefined> {
    const response = await postLogin(environment, loginForm(username, password));
    return response.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith("tubestop_admin="))
        ?.split(";")[0];
}

/** Changes the password and returns the message shown on the page the app redirects to. */
export async function changePassword(
    environment: Environment,
    cookie: string,
    form: Record<string, string>,
): Promise<string> {
    const response = await send(environment, "/admin/password", { cookie, form });
    expectRedirect(response);
    const location = response.headers.get("location") ?? "";
    return new URL(location, "http://localhost").searchParams.get("msg") ?? "";
}

function expectRedirect(response: Response): void {
    if (response.status !== 303) {
        throw new Error(`status ${response.status}, want a 303 redirect`);
    }
}

/** The same app and database, but served by a differently configured password hasher. */
export function withHasher(environment: Environment, hasher: PasswordHasher): Environment {
    const app = createApp({
        store: environment.store,
        resolveUrl: () => Promise.reject(new Error("no resolver in this test")),
        syncNow: async () => undefined,
        thumbnailDir: environment.thumbDir,
        mediaDir: environment.mediaDir,
        cacheDir: environment.cacheDir,
        hasher,
        now: () => environment.clock.milliseconds,
        log: (message) => void environment.logs.push(message),
    });
    return { ...environment, app };
}

export function sessionCookieHeader(response: Response): string | undefined {
    return response.headers.getSetCookie().find((cookie) => cookie.startsWith("tubestop_admin="));
}
