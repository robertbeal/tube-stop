import { describe, expect, test } from "bun:test";
import { randomVideoId, testStartSeconds } from "../../tests/helpers.ts";
import { newVideo, raw, videoOf } from "../shared/db/test-helpers.ts";
import { AlreadySetUpError, NotFoundError } from "../shared/db/types.ts";
import { allowVideo } from "../shared/db/videos.ts";
import { countUsers, createFirstUser, deleteUsers, getUserById, getUserByUsername, updatePassword } from "./users.ts";

describe("admin accounts", () => {
    test("creating the first user returns the account", async () => {
        const user = createFirstUser("parent", "hash-value");
        expect(user).toEqual({ id: user.id, username: "parent", passwordHash: "hash-value" });
        expect(user.id).toBeGreaterThan(0);
        expect(getUserByUsername("parent")).toEqual(user);
        expect(countUsers()).toBe(1);
    });

    test("the creation time comes from the clock", async () => {
        createFirstUser("parent", "hash");
        const row = raw.query<{ created_at: number }, []>("SELECT created_at FROM users").get();
        expect(row?.created_at).toBe(testStartSeconds);
    });

    test("creating a user is refused once an account exists", async () => {
        createFirstUser("parent", "first");
        expect(() => createFirstUser("intruder", "second")).toThrow(AlreadySetUpError);
        expect(countUsers()).toBe(1);
        expect(getUserByUsername("intruder")).toBeNull();
    });

    test("only one of many attempts to create the first user succeeds", async () => {
        const outcomes = Array.from({ length: 12 }, (_, number) => {
            try {
                createFirstUser(`claimant${number}`, "hash");
                return "created";
            } catch (error) {
                return error instanceof AlreadySetUpError ? "refused" : "failed";
            }
        });
        expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome === "refused")).toHaveLength(11);
        expect(countUsers()).toBe(1);
    });

    test("looking up by username ignores case", async () => {
        createFirstUser("Parent", "hash");
        const usernames = ["Parent", "parent", "PARENT", "pArEnT"].map((name) => getUserByUsername(name)?.username);
        expect(usernames).toEqual(["Parent", "Parent", "Parent", "Parent"]);
    });

    test("unknown users are null", async () => {
        expect(getUserByUsername("nobody")).toBeNull();
        expect(getUserById(99)).toBeNull();
    });

    test("updating the password replaces the hash", async () => {
        const user = createFirstUser("parent", "old-hash");
        updatePassword(user.id, "new-hash");
        expect(getUserById(user.id)?.passwordHash).toBe("new-hash");
    });

    test("updating the password of a missing account reports not found", async () => {
        expect(() => updatePassword(999, "x")).toThrow(NotFoundError);
    });

    test("deleting users keeps videos and makes setup possible again", async () => {
        const video = newVideo(randomVideoId());
        allowVideo(video);
        createFirstUser("parent", "hash");
        expect(deleteUsers()).toBe(1);
        expect(videoOf(video.youtubeId).title).toBe(video.title);
        expect(createFirstUser("newparent", "hash").username).toBe("newparent");
    });

    test("deleting users with no accounts removes nothing", async () => {
        expect(deleteUsers()).toBe(0);
    });

    test("a user id is never reused after a reset", async () => {
        const first = createFirstUser("parent", "hash");
        deleteUsers();
        const second = createFirstUser("parent", "hash");
        expect(second.id).not.toBe(first.id);
        expect(getUserById(first.id)).toBeNull();
    });
});
