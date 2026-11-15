import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { createLoginLimiter, createSessions, currentSetupCode } from "../admin/auth.ts";
import { authRoutes } from "../admin/auth-routes.tsx";
import { createPasswordHasher } from "../admin/passwords.ts";
import { adminRoutes } from "../admin/routes.tsx";
import { countUsers } from "../admin/users.ts";
import { logger } from "../logger.ts";
import { kidRoutes } from "./kid.tsx";
import type { Services, WebDependencies } from "./services.ts";

const defaultSessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Rejects cross-site requests that change something. Browsers say where a request came from:
 * `Sec-Fetch-Site` where they support it, otherwise `Origin`, which must match the host.
 * Requests with neither header do not come from a browser, so they pass.
 */
const crossOriginProtection = createMiddleware(async (context, next) => {
    if (safeMethods.has(context.req.method)) {
        return next();
    }
    const site = context.req.header("sec-fetch-site");
    const origin = context.req.header("origin");
    const sameOrigin =
        site === undefined
            ? origin === undefined || URL.parse(origin)?.host === context.req.header("host")
            : site === "same-origin" || site === "none";
    return sameOrigin ? next() : context.text("cross-origin request rejected", 403);
});

function withDefaults(dependencies: WebDependencies): Services {
    return {
        ...dependencies,
        hasher: dependencies.hasher ?? createPasswordHasher(),
        sessionLifetimeMs: dependencies.sessionLifetimeMs ?? defaultSessionLifetimeMs,
        sessions: createSessions(dependencies.sessionLifetimeMs ?? defaultSessionLifetimeMs),
        limiter: createLoginLimiter(),
        setupCode: { code: "" },
    };
}

/** Builds the Tube Stop web app: the child-facing pages and the admin area. */
export function createApp(dependencies: WebDependencies): Hono {
    const services = withDefaults(dependencies);
    const { routes: signInRoutes, requireLogin } = authRoutes(services);

    const app = new Hono();
    app.use(crossOriginProtection);
    app.onError((error, context) => {
        logger.error(`web: ${error.message}`);
        return context.text("something went wrong", 500);
    });

    app.route("/", kidRoutes(services));
    app.route("/", signInRoutes);
    const admin = new Hono();
    admin.use(requireLogin);
    admin.route("/", adminRoutes(services));
    app.route("/admin", admin);

    if (countUsers(services.database) === 0) {
        currentSetupCode(services.setupCode); // print the setup code at startup, where the admin will look
    }
    return app;
}
