import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { createLoginLimiter, createSessions, currentSetupCode } from "../admin/auth.ts";
import { authRoutes } from "../admin/auth-routes.tsx";
import { createPasswordHasher } from "../admin/passwords.ts";
import { adminRoutes } from "../admin/routes.tsx";
import { countUsers } from "../admin/users.ts";
import { config } from "../shared/config.ts";
import { logger } from "../shared/logger.ts";
import { userRoutes } from "../user/routes.tsx";
import type { AppOptions, Services } from "./services.ts";
import bootstrapStyles from "./static/bootstrap.min.css" with { type: "file" };
import bootstrapLicense from "./static/bootstrap-LICENSE.txt" with { type: "file" };
import formsScript from "./static/forms.js" with { type: "file" };
import siteStyles from "./static/style.css" with { type: "file" };
import themeScript from "./static/theme.js" with { type: "file" };

/** The files the pages load. Importing them embeds them, so they are also inside a compiled binary. */
const staticFiles = {
    "/static/bootstrap-LICENSE.txt": bootstrapLicense,
    "/static/bootstrap.min.css": bootstrapStyles,
    "/static/forms.js": formsScript,
    "/static/style.css": siteStyles,
    "/static/theme.js": themeScript,
};

/**
 * Rejects cross-site requests that change something. Browsers say where a request came from:
 * `Sec-Fetch-Site` where they support it, otherwise `Origin`, which must match the host.
 * Requests with neither header do not come from a browser, so they pass.
 */
const crossOriginProtection = createMiddleware(async (context, next) => {
    const methods = new Set(["GET", "HEAD", "OPTIONS"]);

    if (methods.has(context.req.method)) {
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

function withDefaults(options: AppOptions): Services {
    const sessionLifetimeMs = options.sessionLifetimeMs ?? config.sessionLifetimeMs;
    return {
        hasher: options.hasher ?? createPasswordHasher(),
        sessionLifetimeMs,
        sessions: createSessions(sessionLifetimeMs),
        limiter: createLoginLimiter(),
        setupCode: { code: "" },
    };
}

/** Builds the Tube Stop web app: the child-facing pages and the admin area. */
export function createApp(options: AppOptions = {}): Hono {
    const services = withDefaults(options);
    const { routes: signInRoutes, requireLogin } = authRoutes(services);

    const admin = new Hono();
    admin.use(requireLogin);
    admin.route("/", adminRoutes(services));

    const app = new Hono();
    app.use(crossOriginProtection);
    app.route("/", userRoutes());
    app.route("/", signInRoutes);
    app.route("/admin", admin);

    app.onError((error, context) => {
        logger.error(`web: ${error.message}`);
        return context.text("something went wrong", 500);
    });

    for (const [route, path] of Object.entries(staticFiles)) {
        const file = Bun.file(path);
        app.get(route, () => new Response(file, { headers: { "Content-Type": file.type } }));
    }

    if (countUsers() === 0) {
        currentSetupCode(services.setupCode); // print the setup code at startup, where the admin will look
    }

    return app;
}
