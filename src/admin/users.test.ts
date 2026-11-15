import { describe, expect, test } from "bun:test";
import { randomVideoId, testStartSeconds } from "../../tests/helpers.ts";
import { newVideo, openTestDatabase, videoOf } from "../db/test-helpers.ts";
import { AlreadySetUpError, NotFoundError } from "../db/types.ts";
import { allowVideo } from "../db/videos.ts";
import { countUsers, createFirstUser, deleteUsers, getUserById, getUserByUsername, updatePassword } from "./users.ts";

describe("admin accounts", () => {
    test("creating the first user returns the account", async () => {
        const { database } = await openTestDatabase();
        const user = createFirstUser(database, "parent", "hash-value");
        expect(user).toEqual({ id: user.id, username: "parent", passwordHash: "hash-value" });
        expect(user.id).toBeGreaterThan(0);
        expect(getUserByUsername(database, "parent")).toEqual(user);
        expect(countUsers(database)).toBe(1);
    });

    test("the creation time comes from the clock", async () => {
        const { database, raw } = await openTestDatabase();
        createFirstUser(database, "parent", "hash");
        const row = raw.query<{ created_at: number }, []>("SELECT created_at FROM users").get();
        expect(row?.created_at).toBe(testStartSeconds);
    });

    test("creating a user is refused once an account exists", async () => {
        const { database } = await openTestDatabase();
        createFirstUser(database, "parent", "first");
        expect(() => createFirstUser(database, "intruder", "second")).toThrow(AlreadySetUpError);
        expect(countUsers(database)).toBe(1);
        expect(getUserByUsername(database, "intruder")).toBeNull();
    });

    test("only one of many attempts to create the first user succeeds", async () => {
        const { database } = await openTestDatabase();
        const outcomes = Array.from({ length: 12 }, (_, number) => {
            try {
                createFirstUser(database, `claimant${number}`, "hash");
                return "created";
            } catch (error) {
                return error instanceof AlreadySetUpError ? "refused" : "failed";
            }
        });
        expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome === "refused")).toHaveLength(11);
        expect(countUsers(database)).toBe(1);
    });

    test("looking up by username ignores case", async () => {
        const { database } = await openTestDatabase();
        createFirstUser(database, "Parent", "hash");
        const usernames = ["Parent", "parent", "PARENT", "pArEnT"].map(
            (name) => getUserByUsername(database, name)?.username,
        );
        expect(usernames).toEqual(["Parent", "Parent", "Parent", "Parent"]);
    });

    test("unknown users are null", async () => {
        const { database } = await openTestDatabase();
        expect(getUserByUsername(database, "nobody")).toBeNull();
        expect(getUserById(database, 99)).toBeNull();
    });

    test("updating the password replaces the hash", async () => {
        const { database } = await openTestDatabase();
        const user = createFirstUser(database, "parent", "old-hash");
        updatePassword(database, user.id, "new-hash");
        expect(getUserById(database, user.id)?.passwordHash).toBe("new-hash");
    });

    test("updating the password of a missing account reports not found", async () => {
        const { database } = await openTestDatabase();
        expect(() => updatePassword(database, 999, "x")).toThrow(NotFoundError);
    });

    test("deleting users keeps videos and makes setup possible again", async () => {
        const { database } = await openTestDatabase();
        const video = newVideo(randomVideoId());
        allowVideo(database, video);
        createFirstUser(database, "parent", "hash");
        expect(deleteUsers(database)).toBe(1);
        expect(videoOf(database, video.youtubeId).title).toBe(video.title);
        expect(createFirstUser(database, "newparent", "hash").username).toBe("newparent");
    });

    test("deleting users with no accounts removes nothing", async () => {
        const { database } = await openTestDatabase();
        expect(deleteUsers(database)).toBe(0);
    });

    test("a user id is never reused after a reset", async () => {
        const { database } = await openTestDatabase();
        const first = createFirstUser(database, "parent", "hash");
        deleteUsers(database);
        const second = createFirstUser(database, "parent", "hash");
        expect(second.id).not.toBe(first.id);
        expect(getUserById(database, first.id)).toBeNull();
    });
});
