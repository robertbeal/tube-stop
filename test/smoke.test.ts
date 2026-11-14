import { expect, test } from "bun:test";
import { allow, buildEnvironment, logIn, send } from "./web/harness.ts";

test("the harness builds a working app", async () => {
  const environment = await buildEnvironment();
  allow(environment, { youtubeId: "abcdefghijk", title: "Moonlight Sonata" });
  expect(await (await send(environment, "/")).text()).toContain("Moonlight Sonata");
  const cookie = await logIn(environment);
  expect((await send(environment, "/admin", { cookie })).status).toBe(200);
});
