import { describe, expect, test } from "bun:test";
import { randomVideoId } from "../test-helpers.ts";
import { AlreadySetUpError, allowVideo, NotFoundError } from "./store.ts";
import { fixedNow, newVideo, openTestDatabase, videoOf } from "./support.ts";
import {
  countUsers,
  createFirstUser,
  deleteUsers,
  getUserById,
  getUserByUsername,
  updatePassword,
} from "./users.ts";

describe("admin accounts", () => {
  test("creating the first user returns the account", async () => {
    const { store } = await openTestDatabase();
    const user = createFirstUser(store, "parent", "hash-value");
    expect(user).toEqual({ id: user.id, username: "parent", passwordHash: "hash-value" });
    expect(user.id).toBeGreaterThan(0);
    expect(getUserByUsername(store, "parent")).toEqual(user);
    expect(countUsers(store)).toBe(1);
  });

  test("the creation time comes from the clock", async () => {
    const { store, raw } = await openTestDatabase();
    createFirstUser(store, "parent", "hash");
    const row = raw.query<{ created_at: number }, []>("SELECT created_at FROM users").get();
    expect(row?.created_at).toBe(fixedNow);
  });

  test("creating a user is refused once an account exists", async () => {
    const { store } = await openTestDatabase();
    createFirstUser(store, "parent", "first");
    expect(() => createFirstUser(store, "intruder", "second")).toThrow(AlreadySetUpError);
    expect(countUsers(store)).toBe(1);
    expect(getUserByUsername(store, "intruder")).toBeNull();
  });

  test("only one of many attempts to create the first user succeeds", async () => {
    const { store } = await openTestDatabase();
    const outcomes = Array.from({ length: 12 }, (_, number) => {
      try {
        createFirstUser(store, `claimant${number}`, "hash");
        return "created";
      } catch (error) {
        return error instanceof AlreadySetUpError ? "refused" : "failed";
      }
    });
    expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "refused")).toHaveLength(11);
    expect(countUsers(store)).toBe(1);
  });

  test("looking up by username ignores case", async () => {
    const { store } = await openTestDatabase();
    createFirstUser(store, "Parent", "hash");
    const usernames = ["Parent", "parent", "PARENT", "pArEnT"].map(
      (name) => getUserByUsername(store, name)?.username,
    );
    expect(usernames).toEqual(["Parent", "Parent", "Parent", "Parent"]);
  });

  test("unknown users are null", async () => {
    const { store } = await openTestDatabase();
    expect(getUserByUsername(store, "nobody")).toBeNull();
    expect(getUserById(store, 99)).toBeNull();
  });

  test("updating the password replaces the hash", async () => {
    const { store } = await openTestDatabase();
    const user = createFirstUser(store, "parent", "old-hash");
    updatePassword(store, user.id, "new-hash");
    expect(getUserById(store, user.id)?.passwordHash).toBe("new-hash");
  });

  test("updating the password of a missing account reports not found", async () => {
    const { store } = await openTestDatabase();
    expect(() => updatePassword(store, 999, "x")).toThrow(NotFoundError);
  });

  test("deleting users keeps videos and makes setup possible again", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    allowVideo(store, video);
    createFirstUser(store, "parent", "hash");
    expect(deleteUsers(store)).toBe(1);
    expect(videoOf(store, video.youtubeId).title).toBe(video.title);
    expect(createFirstUser(store, "newparent", "hash").username).toBe("newparent");
  });

  test("deleting users with no accounts removes nothing", async () => {
    const { store } = await openTestDatabase();
    expect(deleteUsers(store)).toBe(0);
  });

  test("a user id is never reused after a reset", async () => {
    const { store } = await openTestDatabase();
    const first = createFirstUser(store, "parent", "hash");
    deleteUsers(store);
    const second = createFirstUser(store, "parent", "hash");
    expect(second.id).not.toBe(first.id);
    expect(getUserById(store, first.id)).toBeNull();
  });
});
