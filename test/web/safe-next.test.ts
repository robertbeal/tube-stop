import { expect, test } from "bun:test";
import { safeNext } from "../../src/web/auth.ts";

const cases: ReadonlyArray<readonly [string, string]> = [
  ["/admin", "/admin"],
  ["/admin?channel=UC1", "/admin?channel=UC1"],
  ["/admin?channel=UC1&page=3", "/admin?channel=UC1&page=3"],
  ["/admin/anything", "/admin/anything"],
  ["", "/admin"],
  ["/", "/admin"],
  ["/adminx", "/admin"],
  ["/administrator", "/admin"],
  ["//evil.example", "/admin"],
  ["//evil.example/admin", "/admin"],
  ["https://evil.example/admin", "/admin"],
  ["/admin/login", "/admin"],
  ["/admin/login?next=/admin", "/admin"],
  ["/admin\\evil", "/admin"],
  ["/admin\r\nSet-Cookie: x=y", "/admin"],
  ["javascript:alert(1)", "/admin"],
  ["/admin?q=%0d%0a", "/admin?q=%0d%0a"],
];

test.each(cases)("safeNext(%j) is %j", (next, expected) => {
  expect(safeNext(next)).toBe(expected);
});
