import { describe, expect, test } from "bun:test";
import { buildEnvironment, send } from "../../tests/harness.ts";
import { allowPianoVideo, videoId } from "../user/test-helpers.ts";
import { precachedFiles } from "./assets.ts";

describe("the web app manifest", () => {
    test("names the app and points at icons that exist", async () => {
        const environment = await buildEnvironment();

        const response = await send(environment, "/manifest.webmanifest");
        const manifest = (await response.json()) as {
            name: string;
            start_url: string;
            display: string;
            icons: { src: string; sizes: string; purpose: string }[];
        };

        expect(response.headers.get("content-type")).toBe("application/manifest+json");
        expect(manifest).toMatchObject({ name: "Tube Stop", start_url: "/", display: "standalone" });
        expect(manifest.icons.map((icon) => icon.sizes)).toContain("192x192");
        expect(manifest.icons.map((icon) => icon.sizes)).toContain("512x512");
        for (const icon of manifest.icons) {
            const served = await send(environment, icon.src);
            expect(served.status).toBe(200);
            expect(served.headers.get("content-type")).toBe("image/png");
        }
    });
});

describe("the service worker", () => {
    test("is served from the root, never kept by the browser, and carries a fingerprint and the files to keep", async () => {
        const environment = await buildEnvironment();

        const response = await send(environment, "/sw.js");
        const script = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("javascript");
        expect(response.headers.get("cache-control")).toBe("no-cache");
        expect(script).toMatch(/^const BUILD = "[0-9a-f]{16}";\nconst ASSETS = \[/);
        for (const path of Object.keys(precachedFiles)) {
            expect(script).toContain(JSON.stringify(path));
        }
        expect(script).not.toContain("bootstrap-LICENSE");
    });

    test("keeps only files that the server serves", async () => {
        const environment = await buildEnvironment();
        for (const path of Object.keys(precachedFiles)) {
            expect((await send(environment, path)).status).toBe(200);
        }
    });

    test("has the same fingerprint each time", async () => {
        const environment = await buildEnvironment();
        const fingerprint = async () => (await (await send(environment, "/sw.js")).text()).slice(0, 40);
        expect(await fingerprint()).toBe(await fingerprint());
    });
});

describe("pages that work without the server", () => {
    test("the child's pages link the manifest and the script, and the admin's do not", async () => {
        const environment = await buildEnvironment({ withAdmin: false });
        allowPianoVideo(videoId, "Song");

        for (const path of ["/", `/watch/${videoId}`, "/watched", "/other"]) {
            const body = await (await send(environment, path)).text();
            expect(body).toContain('rel="manifest"');
            expect(body).toContain('src="/static/offline.js"');
        }
        const setup = await (await send(environment, "/admin/setup")).text();
        expect(setup).not.toContain("manifest");
        expect(setup).not.toContain("offline.js");
    });

    test("each video card says which video it is", async () => {
        const environment = await buildEnvironment();
        allowPianoVideo(videoId, "Song");

        expect(await (await send(environment, "/")).text()).toContain(`data-video-id="${videoId}"`);
    });
});
