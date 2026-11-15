import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { stubYtDlp, temporaryDirectory } from "../tests/helpers.ts";

type Child = Bun.Subprocess<"ignore", "pipe", "pipe">;

const children: Child[] = [];

afterEach(async () => {
    const running = children.splice(0);
    for (const child of running) {
        child.kill("SIGKILL");
    }
    await Promise.all(running.map((child) => child.exited));
});

function freePort(): number {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const { port } = probe;
    probe.stop(true);
    return port ?? 0;
}

async function environmentFor(port: string): Promise<Record<string, string>> {
    const directory = await temporaryDirectory();
    const stub = await stubYtDlp("exit 1");
    return {
        ...process.env,
        PORT: port,
        HOST: "127.0.0.1",
        DATA_DIR: join(directory, "data"),
        MEDIA_DIR: join(directory, "media"),
        CACHE_DIR: join(directory, "cache"),
        YTDLP_BIN: stub.binary,
    } as Record<string, string>;
}

function start(env: Record<string, string>, ...commandArguments: string[]): Child {
    const child = Bun.spawn(["bun", "src/main.ts", ...commandArguments], {
        env,
        stdout: "pipe",
        stderr: "pipe",
    });
    children.push(child);
    return child;
}

async function untilListening(port: number, child: Child): Promise<void> {
    const deadline = performance.now() + 15_000;
    const attempt = async (): Promise<void> => {
        if (child.exitCode !== null) {
            throw new Error(`app exited early with ${child.exitCode}: ${await new Response(child.stderr).text()}`);
        }
        const reachable = await fetch(`http://127.0.0.1:${port}/`).then(
            () => true,
            () => false,
        );
        if (reachable) {
            return;
        }
        if (performance.now() > deadline) {
            throw new Error("app did not start listening in time");
        }
        await Bun.sleep(50);
        return attempt();
    };
    await attempt();
}

async function startedApp(): Promise<{ child: Child; base: string }> {
    const port = freePort();
    const child = start(await environmentFor(String(port)));
    await untilListening(port, child);
    return { child, base: `http://127.0.0.1:${port}` };
}

async function readUntil(stream: ReadableStream<Uint8Array>, pattern: RegExp): Promise<string> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    const accumulate = async (text: string): Promise<string> => {
        if (pattern.test(text)) {
            reader.releaseLock();
            return text;
        }
        const { done, value } = await reader.read();
        if (done) {
            reader.releaseLock();
            return text;
        }
        return accumulate(text + decoder.decode(value));
    };
    return accumulate("");
}

describe("main", () => {
    test("serves the child page", async () => {
        const { base } = await startedApp();

        const response = await fetch(`${base}/`);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
    });

    test("sends /admin to setup and prints the setup code to its log", async () => {
        const { child, base } = await startedApp();

        const response = await fetch(`${base}/admin`, { redirect: "manual" });
        const log = await readUntil(child.stdout, /setup code: [A-Z0-9]{4}-[A-Z0-9]{4}/);

        expect(response.status).toBe(303);
        expect(new URL(response.headers.get("location") ?? "", base).pathname).toBe("/admin/setup");
        expect(log).toMatch(/setup code: [A-Z0-9]{4}-[A-Z0-9]{4}/);
    });

    test("shuts down cleanly on SIGTERM", async () => {
        const { child } = await startedApp();

        child.kill("SIGTERM");
        const exitCode = await Promise.race([child.exited, Bun.sleep(5000).then(() => "timed out" as const)]);

        expect(exitCode).toBe(0);
    });

    test("refuses to start with an invalid configuration", async () => {
        const child = start(await environmentFor("abc"));

        const [exitCode, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);

        expect(exitCode).not.toBe(0);
        expect(errors).toContain("invalid configuration");
        expect(errors).toContain("PORT");
    });

    test("exits non-zero on an unknown command", async () => {
        const child = start(await environmentFor("8080"), "explode");

        const [exitCode, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);

        expect(exitCode).not.toBe(0);
        expect(errors).toContain("explode");
    });
});
