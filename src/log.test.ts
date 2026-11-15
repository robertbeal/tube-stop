import { describe, expect, mock, spyOn, test } from "bun:test";
import { logError, logInfo } from "./log.ts";

const isoTimestamp = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z";

// The test setup silences the logger, so put the real functions back before using them.
function useRealLogger(): void {
    mock.restore();
}

describe("logInfo", () => {
    test("writes a timestamped INFO line to stdout", () => {
        useRealLogger();
        const stdout = spyOn(console, "log").mockImplementation(() => undefined);

        logInfo("sync: Piano Guy: 12 videos");

        expect(stdout.mock.calls).toHaveLength(1);
        expect(stdout.mock.calls[0]?.[0]).toMatch(new RegExp(`^${isoTimestamp} INFO sync: Piano Guy: 12 videos$`));
    });

    test("does not write to stderr", () => {
        useRealLogger();
        spyOn(console, "log").mockImplementation(() => undefined);
        const stderr = spyOn(console, "error").mockImplementation(() => undefined);

        logInfo("fine");

        expect(stderr.mock.calls).toHaveLength(0);
    });
});

describe("logError", () => {
    test("writes a timestamped ERROR line to stderr", () => {
        useRealLogger();
        const stderr = spyOn(console, "error").mockImplementation(() => undefined);

        logError("download: abcdefghijk failed: boom");

        expect(stderr.mock.calls).toHaveLength(1);
        expect(stderr.mock.calls[0]?.[0]).toMatch(
            new RegExp(`^${isoTimestamp} ERROR download: abcdefghijk failed: boom$`),
        );
    });

    test("does not write to stdout", () => {
        useRealLogger();
        const stdout = spyOn(console, "log").mockImplementation(() => undefined);
        spyOn(console, "error").mockImplementation(() => undefined);

        logError("bad");

        expect(stdout.mock.calls).toHaveLength(0);
    });
});
