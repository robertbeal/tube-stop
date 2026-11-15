import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { randomVideoId, temporaryDirectory } from "../../tests/helpers.ts";
import { countUsers } from "../admin/users.ts";
import { openDatabase } from "./open.ts";
import { newVideo, openTestDatabase, videoOf } from "./test-helpers.ts";
import { allowVideo } from "./videos.ts";

function userVersion(path: string): number {
    const raw = new Database(path, { readonly: true });
    const row = raw.query<{ user_version: number }, []>("PRAGMA user_version").get();
    raw.close();
    return row?.user_version ?? 0;
}

describe("schema versioning", () => {
    test("a new database is stamped with the schema version", async () => {
        const { path } = await openTestDatabase();
        expect(userVersion(path)).toBe(1);
    });

    test("reopening keeps data and version", async () => {
        const path = join(await temporaryDirectory(), "test.db");
        const first = openDatabase(path);
        const video = newVideo("chan");
        allowVideo(first, video);
        first.close();

        const reopened = openDatabase(path);
        expect(videoOf(reopened, video.youtubeId).title).toBe(video.title);
        expect(userVersion(path)).toBe(1);
    });

    test("an in-memory database works", () => {
        const database = openDatabase(":memory:");
        allowVideo(database, newVideo("chan"));
        expect(countUsers(database)).toBe(0);
    });

    test("a database from a newer build is refused", async () => {
        const path = join(await temporaryDirectory(), "future.db");
        const raw = new Database(path, { create: true });
        raw.run("PRAGMA user_version = 9999");
        raw.close();
        expect(() => openDatabase(path)).toThrow("newer");
    });
});

describe("schema constraints", () => {
    test("every status and rule is accepted", async () => {
        const { raw } = await openTestDatabase();
        const statuses = ["none", "queued", "downloading", "ready", "failed"];
        const rules = ["allow", "block", "inherit"];
        for (const status of statuses) {
            raw.query(
                "INSERT INTO videos (youtube_id, title, download_status, cache_status) VALUES (?, 't', ?, ?)",
            ).run(randomVideoId(), status, status);
        }
        for (const rule of rules) {
            raw.query("INSERT INTO videos (youtube_id, title, rule) VALUES (?, 't', ?)").run(randomVideoId(), rule);
        }
        expect(raw.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM videos").get()?.total).toBe(8);
    });

    test("an unknown status is rejected", async () => {
        const { raw } = await openTestDatabase();
        expect(() =>
            raw
                .query("INSERT INTO videos (youtube_id, title, download_status) VALUES (?, 't', 'bogus')")
                .run(randomVideoId()),
        ).toThrow();
    });

    test("an unknown rule is rejected", async () => {
        const { raw } = await openTestDatabase();
        expect(() =>
            raw.query("INSERT INTO videos (youtube_id, title, rule) VALUES (?, 't', 'bogus')").run(randomVideoId()),
        ).toThrow();
    });
});
