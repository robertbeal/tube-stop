import { describe, expect, test } from "bun:test";
import {
  createPasswordHasher,
  hashPassword,
  needsUpgrade,
  PasswordRuleError,
  spendTimeVerifying,
  verifyPassword,
} from "./passwords.ts";

const password = "correct horse battery";
const cheapest = createPasswordHasher(4);

describe("hashing and verifying", () => {
  test("accepts the right password only", async () => {
    const hash = await hashPassword(cheapest, password);
    expect(await verifyPassword(hash, password)).toBe(true);
    for (const wrong of [
      "",
      "correct horse batter",
      "Correct horse battery",
      `${password} `,
      "wrong password",
    ]) {
      expect(await verifyPassword(hash, wrong)).toBe(false);
    }
  });

  test("the hash never contains the password and is in bcrypt format", async () => {
    const hash = await hashPassword(cheapest, password);
    expect(hash).not.toContain("correct");
    expect(hash).not.toContain("horse");
    expect(hash.startsWith("$2")).toBe(true);
  });

  test("the same password gives different hashes because of the salt", async () => {
    const first = await hashPassword(cheapest, password);
    const second = await hashPassword(cheapest, password);
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, password)).toBe(true);
    expect(await verifyPassword(second, password)).toBe(true);
  });

  test("verifies hashes in the $2a$ form that the Go app produced", async () => {
    const hash = await hashPassword(cheapest, password);
    const goStyle = hash.replace(/^\$2b\$/, "$2a$");
    expect(goStyle.startsWith("$2a$")).toBe(true);
    expect(await verifyPassword(goStyle, password)).toBe(true);
    expect(await verifyPassword(goStyle, "wrong password")).toBe(false);
  });
});

describe("password rules", () => {
  test.each([
    ["empty", "", "at least 8"],
    ["seven bytes", "1234567", "at least 8"],
    ["seventy-three bytes", "a".repeat(73), "at most 72"],
    ["multi-byte characters over the byte limit", "é".repeat(37), "at most 72"],
  ])("refuses %s", async (_name, rejected, message) => {
    const attempt = hashPassword(cheapest, rejected);
    await expect(attempt).rejects.toBeInstanceOf(PasswordRuleError);
    await expect(attempt).rejects.toThrow(message);
  });

  test("accepts the boundary lengths", async () => {
    for (const boundary of ["a".repeat(8), "a".repeat(72)]) {
      expect(await verifyPassword(await hashPassword(cheapest, boundary), boundary)).toBe(true);
    }
  });
});

describe("verify", () => {
  test("never matches a malformed hash", async () => {
    for (const hash of ["", "garbage", "$2a$04$tooshort", "plain-text-password"]) {
      expect(await verifyPassword(hash, "plain-text-password")).toBe(false);
    }
  });

  test("a seventy-three byte password cannot match a hash of its first seventy-two", async () => {
    const seventyTwo = "a".repeat(72);
    const hash = await hashPassword(cheapest, seventyTwo);
    expect(await verifyPassword(hash, `${seventyTwo}b`)).toBe(false);
  });
});

describe("needsUpgrade", () => {
  test("is true only for cheaper or malformed hashes", async () => {
    const stronger = createPasswordHasher(5);
    const cheapHash = await hashPassword(cheapest, password);
    const strongHash = await hashPassword(stronger, password);
    expect(needsUpgrade(stronger, cheapHash)).toBe(true);
    expect(needsUpgrade(stronger, strongHash)).toBe(false);
    expect(needsUpgrade(cheapest, strongHash)).toBe(false);
    expect(needsUpgrade(stronger, "garbage")).toBe(true);
  });

  test("treats $2a$ hashes by their cost too", async () => {
    const stronger = createPasswordHasher(5);
    const goStyle = (await hashPassword(cheapest, password)).replace(/^\$2b\$/, "$2a$");
    expect(needsUpgrade(stronger, goStyle)).toBe(true);
    expect(needsUpgrade(cheapest, goStyle)).toBe(false);
  });
});

describe("constructing a hasher", () => {
  test.each([-1, 0, 3, 32, 100, 4.5])("rejects cost %p outside bcrypt's range", (cost) => {
    expect(() => createPasswordHasher(cost)).toThrow();
  });
});

test("spending time verifying neither throws nor succeeds", async () => {
  for (const attempt of ["anything", "", "x".repeat(500)]) {
    expect(await spendTimeVerifying(cheapest, attempt)).toBeUndefined();
  }
});
