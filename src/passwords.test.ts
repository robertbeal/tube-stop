import { describe, expect, test } from "bun:test";
import { PasswordHasher, PasswordRuleError } from "./passwords.ts";

const password = "correct horse battery";
const cheapest = new PasswordHasher(4);

describe("hashing and verifying", () => {
  test("accepts the right password only", async () => {
    const hash = await cheapest.hash(password);
    expect(await cheapest.verify(hash, password)).toBe(true);
    for (const wrong of [
      "",
      "correct horse batter",
      "Correct horse battery",
      `${password} `,
      "wrong password",
    ]) {
      expect(await cheapest.verify(hash, wrong)).toBe(false);
    }
  });

  test("the hash never contains the password and is in bcrypt format", async () => {
    const hash = await cheapest.hash(password);
    expect(hash).not.toContain("correct");
    expect(hash).not.toContain("horse");
    expect(hash.startsWith("$2")).toBe(true);
  });

  test("the same password gives different hashes because of the salt", async () => {
    const first = await cheapest.hash(password);
    const second = await cheapest.hash(password);
    expect(first).not.toBe(second);
    expect(await cheapest.verify(first, password)).toBe(true);
    expect(await cheapest.verify(second, password)).toBe(true);
  });

  test("verifies hashes in the $2a$ form that the Go app produced", async () => {
    const hash = await cheapest.hash(password);
    const goStyle = hash.replace(/^\$2b\$/, "$2a$");
    expect(goStyle.startsWith("$2a$")).toBe(true);
    expect(await cheapest.verify(goStyle, password)).toBe(true);
    expect(await cheapest.verify(goStyle, "wrong password")).toBe(false);
  });
});

describe("password rules", () => {
  test.each([
    ["empty", "", "at least 8"],
    ["seven bytes", "1234567", "at least 8"],
    ["seventy-three bytes", "a".repeat(73), "at most 72"],
    ["multi-byte characters over the byte limit", "é".repeat(37), "at most 72"],
  ])("refuses %s", async (_name, rejected, message) => {
    const attempt = cheapest.hash(rejected);
    await expect(attempt).rejects.toBeInstanceOf(PasswordRuleError);
    await expect(attempt).rejects.toThrow(message);
  });

  test("accepts the boundary lengths", async () => {
    for (const boundary of ["a".repeat(8), "a".repeat(72)]) {
      expect(await cheapest.verify(await cheapest.hash(boundary), boundary)).toBe(true);
    }
  });
});

describe("verify", () => {
  test("never matches a malformed hash", async () => {
    for (const hash of ["", "garbage", "$2a$04$tooshort", "plain-text-password"]) {
      expect(await cheapest.verify(hash, "plain-text-password")).toBe(false);
    }
  });

  test("a seventy-three byte password cannot match a hash of its first seventy-two", async () => {
    const seventyTwo = "a".repeat(72);
    const hash = await cheapest.hash(seventyTwo);
    expect(await cheapest.verify(hash, `${seventyTwo}b`)).toBe(false);
  });
});

describe("needsUpgrade", () => {
  test("is true only for cheaper or malformed hashes", async () => {
    const stronger = new PasswordHasher(5);
    const cheapHash = await cheapest.hash(password);
    const strongHash = await stronger.hash(password);
    expect(stronger.needsUpgrade(cheapHash)).toBe(true);
    expect(stronger.needsUpgrade(strongHash)).toBe(false);
    expect(cheapest.needsUpgrade(strongHash)).toBe(false);
    expect(stronger.needsUpgrade("garbage")).toBe(true);
  });

  test("treats $2a$ hashes by their cost too", async () => {
    const stronger = new PasswordHasher(5);
    const goStyle = (await cheapest.hash(password)).replace(/^\$2b\$/, "$2a$");
    expect(stronger.needsUpgrade(goStyle)).toBe(true);
    expect(cheapest.needsUpgrade(goStyle)).toBe(false);
  });
});

describe("constructing a hasher", () => {
  test.each([-1, 0, 3, 32, 100, 4.5])("rejects cost %p outside bcrypt's range", (cost) => {
    expect(() => new PasswordHasher(cost)).toThrow();
  });
});

test("spending time verifying neither throws nor succeeds", async () => {
  for (const attempt of ["anything", "", "x".repeat(500)]) {
    expect(await cheapest.spendTimeVerifying(attempt)).toBeUndefined();
  }
});
