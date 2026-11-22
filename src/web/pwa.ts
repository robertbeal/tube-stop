import { Hono } from "hono";
import { precachedFiles } from "./assets.ts";
import serviceWorkerSource from "./static/sw.js" with { type: "file" };

const manifest = {
    name: "Tube Stop",
    short_name: "Tube Stop",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#1c2434",
    theme_color: "#1c2434",
    icons: [
        { src: "/static/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/static/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/static/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
};

/** A fingerprint of everything the worker keeps, so a changed file makes the browser install a new worker. */
async function buildId(files: string[]): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha256");
    for (const path of files) {
        hasher.update(await Bun.file(path).bytes());
    }
    return hasher.digest("hex").slice(0, 16);
}

/** The service worker is the script plus the two values the server knows: which files to keep, and their fingerprint. */
async function serviceWorkerScript(): Promise<string> {
    const files = [serviceWorkerSource, ...Object.values(precachedFiles)];
    const assets = Object.keys(precachedFiles);
    const source = await Bun.file(serviceWorkerSource).text();
    return `const BUILD = ${JSON.stringify(await buildId(files))};\nconst ASSETS = ${JSON.stringify(assets)};\n${source}`;
}

/** What makes the app installable and usable without a connection. */
export function pwaRoutes(): Hono {
    const routes = new Hono();
    let script: Promise<string> | undefined;

    routes.get("/manifest.webmanifest", (context) =>
        context.body(JSON.stringify(manifest), 200, { "Content-Type": "application/manifest+json" }),
    );

    // The worker must be served from the root to control every page, and the browser must always ask for a fresh copy.
    routes.get("/sw.js", async (context) => {
        script ??= serviceWorkerScript();
        return context.body(await script, 200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
        });
    });

    return routes;
}
