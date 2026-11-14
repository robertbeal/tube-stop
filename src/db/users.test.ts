import { describe, expect, test } from "bun:test";
import { randomVideoId } from "../test-helpers.ts";
import { AlreadySetUpError, NotFoundError } from "./store.ts";
import { fixedNow, newVideo, openTestDatabase, videoOf } from "./support.ts";

describe("admin accounts", () => {
  test("creating the first user returns the account", async () => {
    const { store } = await openTestDatabase();
    const user = store.createFirstUser("parent", "hash-value");
    expect(user).toEqual({ id: user.id, username: "parent", passwordHash: "hash-value" });
    expect(user.id).toBeGreaterThan(0);
    expect(store.userByUsername("parent")).toEqual(user);
    expect(store.userCount()).toBe(1);
  });

  test("the creation time comes from the clock", async () => {
    const { store, raw } = await openTestDatabase();
    store.createFirstUser("parent", "hash");
    const row = raw.query<{ created_at: number }, []>("SELECT created_at FROM users").get();
    expect(row?.created_at).toBe(fixedNow);
  });

  test("creating a user is refused once an account exists", async () => {
    const { store } = await openTestDatabase();
    store.createFirstUser("parent", "first");
    expect(() => store.createFirstUser("intruder", "second")).toThrow(AlreadySetUpError);
    expect(store.userCount()).toBe(1);
    expect(store.userByUsername("intruder")).toBeNull();
  });

  test("only one of many attempts to create the first user succeeds", async () => {
    const { store } = await openTestDatabase();
    const outcomes = Array.from({ length: 12 }, (_, number) => {
      try {
        store.createFirstUser(`claimant${number}`, "hash");
        return "created";
      } catch (error) {
        return error instanceof AlreadySetUpError ? "refused" : "failed";
      }
    });
    expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "refused")).toHaveLength(11);
    expect(store.userCount()).toBe(1);
  });

  test("looking up by username ignores case", async () => {
    const { store } = await openTestDatabase();
    store.createFirstUser("Parent", "hash");
    const usernames = ["Parent", "parent", "PARENT", "pArEnT"].map(
      (name) => store.userByUsername(name)?.username,
    );
    expect(usernames).toEqual(["Parent", "Parent", "Parent", "Parent"]);
  });

  test("unknown users are null", async () => {
    const { store } = await openTestDatabase();
    expect(store.userByUsername("nobody")).toBeNull();
    expect(store.userById(99)).toBeNull();
  });

  test("updating the password replaces the hash", async () => {
    const { store } = await openTestDatabase();
    const user = store.createFirstUser("parent", "old-hash");
    store.updatePassword(user.id, "new-hash");
    expect(store.userById(user.id)?.passwordHash).toBe("new-hash");
  });

  test("updating the password of a missing account reports not found", async () => {
    const { store } = await openTestDatabase();
    expect(() => store.updatePassword(999, "x")).toThrow(NotFoundError);
  });

  test("deleting users keeps videos and makes setup possible again", async () => {
    const { store } = await openTestDatabase();
    const video = newVideo(randomVideoId());
    store.allowVideo(video);
    store.createFirstUser("parent", "hash");
    expect(store.deleteUsers()).toBe(1);
    expect(videoOf(store, video.youtubeId).title).toBe(video.title);
    expect(store.createFirstUser("newparent", "hash").username).toBe("newparent");
  });

  test("deleting users with no accounts removes nothing", async () => {
    const { store } = await openTestDatabase();
    expect(store.deleteUsers()).toBe(0);
  });

  test("a user id is never reused after a reset", async () => {
    const { store } = await openTestDatabase();
    const first = store.createFirstUser("parent", "hash");
    store.deleteUsers();
    const second = store.createFirstUser("parent", "hash");
    expect(second.id).not.toBe(first.id);
    expect(store.userById(first.id)).toBeNull();
  });
});
