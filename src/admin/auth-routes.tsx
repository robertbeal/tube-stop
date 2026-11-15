import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { AlreadySetUpError, type User } from "../db/types.ts";
import { logger } from "../util/logger.ts";
import type { Services } from "../web/services.ts";
import {
    capitalise,
    clearSetupCode,
    createSession,
    currentSetupCode,
    isLoginBlocked,
    loginPath,
    lookupSession,
    recordLoginFailure,
    removeOtherSessions,
    removeSession,
    safeNext,
    sessionCookieName,
    setupCodeMatches,
    setupPath,
    usernameProblem,
} from "./auth.ts";
import { LoginPage, SetupPage } from "./auth-views.tsx";
import { hashPassword, needsUpgrade, PasswordRuleError, spendTimeVerifying, verifyPassword } from "./passwords.ts";
import { countUsers, createFirstUser, getUserById, getUserByUsername, updatePassword } from "./users.ts";

export type AuthEnv = { Variables: { user: User } };

const tooManyAttempts = "Too many wrong attempts. Wait a minute and try again.";

/** Reads a form field as text; anything missing, or an uploaded file, counts as empty. */
export async function formFields(context: Context): Promise<(name: string) => string> {
    const body = await context.req.parseBody();
    return (name) => {
        const value = body[name];
        return typeof value === "string" ? value : "";
    };
}

function isHttps(context: Context): boolean {
    return context.req.url.startsWith("https:") || context.req.header("x-forwarded-proto") === "https";
}

/** Goes back to the admin page with a message to show. */
export function redirectWithMessage(context: Context, message: string): Response {
    return context.redirect(`/admin?msg=${encodeURIComponent(message)}`, 303);
}

/** Sign-in, first-run setup, and the middleware that keeps the rest of the admin area behind a login. */
export function authRoutes(services: Services): {
    routes: Hono;
    requireLogin: ReturnType<typeof createMiddleware<AuthEnv>>;
} {
    const { hasher, sessions, limiter, setupCode } = services;
    const routes = new Hono();

    /** The admin the request is logged in as, or null if there is no session or its account has since been deleted. */
    const sessionUser = (context: Context): User | null => {
        const token = getCookie(context, sessionCookieName);
        const userId = token === undefined ? undefined : lookupSession(sessions, token);
        if (token === undefined || userId === undefined) {
            return null;
        }
        const user = getUserById(userId);
        if (user === null) {
            removeSession(sessions, token); // the account was removed, for example by reset-admin
        }
        return user;
    };

    const cookieOptions = (context: Context) => ({
        path: "/admin",
        httpOnly: true,
        sameSite: "Strict" as const,
        // Secure cannot be forced: the app is often used over plain HTTP on a home network.
        secure: isHttps(context),
    });

    const startSession = (context: Context, userId: number, next: string): Response => {
        const { token, expiresAt } = createSession(sessions, userId);
        setCookie(context, sessionCookieName, token, {
            ...cookieOptions(context),
            expires: new Date(expiresAt),
            maxAge: Math.floor(sessions.lifetimeMs / 1000),
        });
        return context.redirect(next, 303);
    };

    const requireLogin = createMiddleware<AuthEnv>(async (context, next) => {
        context.header("Cache-Control", "no-store"); // the back button must not show admin pages after logout
        const user = sessionUser(context);
        if (user !== null) {
            context.set("user", user);
            return next();
        }
        if (countUsers() === 0) {
            return context.redirect(setupPath, 303);
        }
        // A GET remembers where the visitor was going; other methods cannot be replayed after logging in.
        const url = new URL(context.req.url);
        const target =
            context.req.method === "GET"
                ? `${loginPath}?next=${encodeURIComponent(url.pathname + url.search)}`
                : loginPath;
        return context.redirect(target, 303);
    });

    routes.get(loginPath, (context) => {
        if (countUsers() === 0) {
            return context.redirect(setupPath, 303);
        }
        const next = safeNext(context.req.query("next") ?? "");
        return sessionUser(context) === null ? context.html(<LoginPage next={next} />) : context.redirect(next, 303);
    });

    routes.post(loginPath, async (context) => {
        if (countUsers() === 0) {
            return context.redirect(setupPath, 303);
        }
        const field = await formFields(context);
        const next = safeNext(field("next"));
        const username = field("username").trim();
        const rejected = (status: 401 | 429, error: string) =>
            context.html(<LoginPage next={next} username={username} error={error} />, status);

        if (isLoginBlocked(limiter)) {
            context.header("Retry-After", "60");
            return rejected(429, tooManyAttempts);
        }
        const password = field("password");
        const user = getUserByUsername(username);
        if (user === null) {
            await spendTimeVerifying(hasher, password); // an unknown username must cost the same time as a wrong password
        } else if (await verifyPassword(user.passwordHash, password)) {
            await upgradeHash(user, password);
            return startSession(context, user.id, next);
        }
        recordLoginFailure(limiter);
        return rejected(401, "Wrong username or password."); // the same message whichever was wrong
    });

    /** Replaces a password hash made at an older, cheaper cost. Failing to do so is harmless, so it is only logged. */
    const upgradeHash = async (user: User, password: string): Promise<void> => {
        if (!needsUpgrade(hasher, user.passwordHash)) {
            return;
        }
        try {
            updatePassword(user.id, await hashPassword(hasher, password));
        } catch (error) {
            logger.error(`web: upgrade password hash of "${user.username}": ${error.message}`);
        }
    };

    routes.post("/admin/logout", (context) => {
        const token = getCookie(context, sessionCookieName);
        if (token !== undefined) {
            removeSession(sessions, token);
        }
        setCookie(context, sessionCookieName, "", { ...cookieOptions(context), maxAge: 0 });
        return context.redirect(loginPath, 303);
    });

    // Once an account exists, the setup pages answer 404, so they do not even reveal that they exist.
    routes.get(setupPath, (context) => {
        if (countUsers() > 0) {
            return context.notFound();
        }
        currentSetupCode(setupCode); // make sure a code has been printed to the log
        return context.html(<SetupPage />);
    });

    routes.post(setupPath, async (context) => {
        if (countUsers() > 0) {
            return context.notFound();
        }
        const field = await formFields(context);
        const username = field("username").trim();
        const rejected = (status: 401 | 422 | 429, error: string) =>
            context.html(<SetupPage username={username} error={error} />, status);

        if (isLoginBlocked(limiter)) {
            context.header("Retry-After", "60");
            return rejected(429, tooManyAttempts);
        }
        if (!setupCodeMatches(setupCode, field("code"))) {
            recordLoginFailure(limiter);
            return rejected(401, "Wrong setup code. It is printed in the app's log.");
        }
        const problem = usernameProblem(username);
        if (problem !== undefined) {
            return rejected(422, problem);
        }
        const password = field("password");
        if (field("confirm") !== password) {
            return rejected(422, "The two passwords do not match.");
        }
        try {
            const user = createFirstUser(username, await hashPassword(hasher, password));
            clearSetupCode(setupCode);
            return startSession(context, user.id, "/admin");
        } catch (error) {
            if (error instanceof PasswordRuleError) {
                return rejected(422, `${capitalise(error.message)}.`);
            }
            if (error instanceof AlreadySetUpError) {
                return context.notFound(); // someone else finished setup first
            }
            throw error;
        }
    });

    return { routes, requireLogin };
}

/** Lets the logged-in admin set a new password. Every other session is ended, so a stolen or forgotten login stops working. */
export function changePassword(services: Services) {
    const { hasher, sessions, limiter } = services;
    return async (context: Context<AuthEnv>): Promise<Response> => {
        const user = context.get("user");
        if (isLoginBlocked(limiter)) {
            return redirectWithMessage(context, tooManyAttempts);
        }
        const field = await formFields(context);
        if (!(await verifyPassword(user.passwordHash, field("current")))) {
            recordLoginFailure(limiter);
            return redirectWithMessage(context, "Your current password is wrong.");
        }
        const newPassword = field("new");
        if (field("confirm") !== newPassword) {
            return redirectWithMessage(context, "The two new passwords do not match.");
        }
        try {
            updatePassword(user.id, await hashPassword(hasher, newPassword));
        } catch (error) {
            if (error instanceof PasswordRuleError) {
                return redirectWithMessage(context, `${capitalise(error.message)}.`);
            }
            throw error;
        }
        const token = getCookie(context, sessionCookieName);
        if (token !== undefined) {
            removeOtherSessions(sessions, user.id, token);
        }
        return redirectWithMessage(context, "Password changed. Any other logins were signed out.");
    };
}
