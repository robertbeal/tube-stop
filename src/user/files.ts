import { stat } from "node:fs/promises";

type ByteRange = { start: number; end: number } | "unsatisfiable" | undefined;

/**
 * Reads a single `Range: bytes=...` header against a file of `size` bytes. Undefined means
 * there is no usable range, so the whole file is served; multiple ranges are not supported.
 */
export function parseRange(header: string | null, size: number): ByteRange {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
    if (match === null || (match[1] === "" && match[2] === "")) {
        return undefined;
    }
    const [first, last] = [match[1] ?? "", match[2] ?? ""];
    const range =
        first === ""
            ? { start: Math.max(0, size - Number(last)), end: size - 1 } // the final N bytes
            : { start: Number(first), end: last === "" ? size - 1 : Math.min(Number(last), size - 1) };
    return range.start >= size || range.start > range.end ? "unsatisfiable" : range;
}

/**
 * Serves a file with Range support (so seeking works) and conditional requests. Anything
 * unreadable is a 404; callers decide which paths are allowed.
 */
export async function serveFile(
    request: Request,
    path: string,
    extraHeaders: Record<string, string> = {},
): Promise<Response> {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || !info.isFile()) {
        return new Response("not found", { status: 404 });
    }
    const file = Bun.file(path);
    const lastModified = new Date(Math.floor(info.mtimeMs / 1000) * 1000);
    const headers = new Headers(extraHeaders);
    headers.set("Last-Modified", lastModified.toUTCString());
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Type", file.type);

    const since = Date.parse(request.headers.get("if-modified-since") ?? "");
    if (!Number.isNaN(since) && lastModified.getTime() <= since) {
        return new Response(null, { status: 304, headers });
    }

    const range = parseRange(request.headers.get("range"), info.size);
    if (range === "unsatisfiable") {
        headers.set("Content-Range", `bytes */${info.size}`);
        return new Response("requested range not satisfiable", { status: 416, headers });
    }
    if (range === undefined) {
        headers.set("Content-Length", String(info.size));
        return new Response(file, { status: 200, headers });
    }
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${info.size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(file.slice(range.start, range.end + 1), { status: 206, headers });
}
