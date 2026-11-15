import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { claimDownload, finishDownload, pinVideo } from "../db/store.ts";
import { allow, buildEnvironment, type Environment, logIn, send } from "./harness.ts";
import { allowPianoVideo, makeCacheReady, videoId } from "./kid-helpers.ts";

type RenderedPage = {
    name: string;
    body: string;
};

/** Renders every kind of page: the child's grid and player, and the login, first-run setup and admin pages. */
async function allPages(): Promise<RenderedPage[]> {
    const environment = await buildEnvironment();
    allowPianoVideo(environment, videoId, "Song");
    const fresh = await buildEnvironment({ withAdmin: false });
    const cookie = await logIn(environment);
    const render = async (source: Environment, path: string, pageCookie?: string) =>
        (await send(source, path, { cookie: pageCookie })).text();
    return [
        { name: "child grid", body: await render(environment, "/") },
        { name: "player", body: await render(environment, `/watch/${videoId}`) },
        { name: "login", body: await render(environment, "/admin/login") },
        { name: "setup", body: await render(fresh, "/admin/setup") },
        { name: "admin", body: await render(environment, "/admin", cookie) },
    ];
}

function titleOf(body: string): string {
    return /<title>(.*?)<\/title>/s.exec(body)?.[1] ?? "";
}

function navbarOf(body: string): string {
    return body.slice(body.indexOf('<nav class="navbar'), body.indexOf("</nav>"));
}

describe("every page", () => {
    test("uses bootstrap and follows the device theme", async () => {
        for (const page of await allPages()) {
            for (const wanted of [
                'href="/static/bootstrap.min.css"',
                'href="/static/style.css"',
                'src="/static/theme.js"',
                'name="viewport"',
                'name="color-scheme"',
                'class="navbar ',
                "navbar-brand",
            ]) {
                expect(page.body, `${page.name} page is missing ${wanted}`).toContain(wanted);
            }
            expect(
                page.body.indexOf("theme.js"),
                `${page.name} loads the theme script after the stylesheet, so the wrong theme could flash`,
            ).toBeLessThan(page.body.indexOf("bootstrap.min.css"));
        }
    });

    test("loads nothing from outside the app", async () => {
        const external = /(?:src|href|action)="(?:https?:)?\/\//;
        for (const page of await allPages()) {
            expect(page.body, `${page.name} page loads or links something external`).not.toMatch(external);
        }
    });

    test("has a distinct title ending with the app name", async () => {
        const titles = Object.fromEntries((await allPages()).map((page) => [page.name, titleOf(page.body)]));

        for (const [name, title] of Object.entries(titles)) {
            expect(title, `${name} title`).toEndWith("Tube Stop");
        }
        expect(titles.login).not.toBe(titles.admin);
        expect(titles.setup).not.toBe(titles.login);
        expect(titles.player).not.toBe(titles["child grid"]);
    });
});

describe("static assets", () => {
    test.each([
        ["/static/bootstrap.min.css", "text/css", "Bootstrap  v5.3", 100_000],
        ["/static/bootstrap-LICENSE.txt", "text/plain", "MIT License", 500],
        ["/static/theme.js", "text/javascript", "prefers-color-scheme", 100],
        ["/static/style.css", "text/css", ".video-card", 100],
        ["/static/player.js", "text/javascript", "loopToggle", 500],
    ])("%s is served as %s", async (path, contentType, mustContain, minimumBytes) => {
        const environment = await buildEnvironment();

        const response = await send(environment, path);
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toStartWith(contentType);
        expect(body.length).toBeGreaterThanOrEqual(minimumBytes);
        expect(body).toContain(mustContain);
    });

    test("a file that is not in the static folder is not found", async () => {
        const environment = await buildEnvironment();
        for (const path of ["/static/nothing.css", "/static/", "/static/..%2Fkid.tsx", "/static/.hidden"]) {
            expect((await send(environment, path)).status, path).toBe(404);
        }
    });
});

describe("the child's navbar", () => {
    test("offers only the home link", async () => {
        const environment = await buildEnvironment();
        allowPianoVideo(environment, videoId, "Song");

        for (const path of ["/", `/watch/${videoId}`]) {
            const navbar = navbarOf(await (await send(environment, path)).text());
            expect(navbar, path).toContain('href="/"');
            expect(navbar, path).not.toContain("<form");
            expect(navbar, path).not.toContain("/admin");
        }
    });
});

describe("the admin navbar", () => {
    test("holds who is logged in and the logout button", async () => {
        const environment = await buildEnvironment();
        const cookie = await logIn(environment);

        const navbar = navbarOf(await (await send(environment, "/admin", { cookie })).text());

        for (const wanted of ["Logged in as", "<strong>parent</strong>", 'action="/admin/logout"', "Log out"]) {
            expect(navbar).toContain(wanted);
        }
    });
});

describe("the player page", () => {
    test("contains every element the player script looks for", async () => {
        const script = await Bun.file(join(import.meta.dir, "static/player.js")).text();
        const environment = await buildEnvironment();
        allowPianoVideo(environment, videoId, "Song");
        const body = await (await send(environment, `/watch/${videoId}`)).text();

        const wanted = [...script.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map((match) => match[1]);

        expect(wanted.length, "the pattern needs updating if player.js changed").toBeGreaterThanOrEqual(8);
        for (const id of wanted) {
            expect(body, `player.js looks for #${id}`).toContain(`id="${id}"`);
        }
    });

    test("shows the local thumbnail as the poster while the video loads", async () => {
        const environment = await buildEnvironment();
        allowPianoVideo(environment, videoId, "Song");

        const body = await (await send(environment, `/watch/${videoId}`)).text();

        expect(body).toContain(`poster="/thumb/${videoId}"`);
    });

    test("the title is the video title and is escaped", async () => {
        const environment = await buildEnvironment();
        allow(environment, { youtubeId: videoId, title: "Tom & <b>Jerry</b>", channelName: "Cartoons" });

        const body = await (await send(environment, `/watch/${videoId}`)).text();

        expect(body).toContain("<title>Tom &amp; &lt;b&gt;Jerry&lt;/b&gt; · Tube Stop</title>");
        expect(body).not.toContain("<b>Jerry</b>");
    });

    test("the waiting and failure messages are hidden until needed", async () => {
        const environment = await buildEnvironment();
        allowPianoVideo(environment, videoId, "Song");

        const notReady = await (await send(environment, `/watch/${videoId}`)).text();
        await makeCacheReady(environment, videoId, "data");
        const ready = await (await send(environment, `/watch/${videoId}`)).text();

        const waitingShown = /id="wait"[^>]*role="status"\s*>/;
        expect(notReady).toMatch(waitingShown);
        expect(ready).not.toMatch(waitingShown);
        expect(notReady).toMatch(/id="fail"[^>]*hidden/);
    });
});

describe("video cards", () => {
    test("shows the duration and a star for saved videos", async () => {
        const environment = await buildEnvironment();
        allow(environment, { youtubeId: videoId, title: "Song", duration: 3661 });
        pinVideo(environment.store, videoId);
        claimDownload(environment.store);
        finishDownload(environment.store, videoId, join(environment.mediaDir, "song.mp4"));

        const body = await (await send(environment, "/")).text();

        expect(body).toContain("1:01:01");
        expect(body).toContain('title="Saved"');
    });
});
