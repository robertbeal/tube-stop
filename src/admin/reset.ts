import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../db/database.ts";
import { deleteUsers } from "./users.ts";

/** Removes the admin account so a new one can be created from the setup page. */
export function resetAdmin(dataDir: string, output: (line: string) => void): void {
    const path = join(dataDir, "tubestop.db");

    // openDatabase would create an empty database here, so a wrong DATA_DIR must be caught first.
    if (!existsSync(path)) {
        throw new Error(`no database at ${path}: is DATA_DIR set to the same folder the app uses?`);
    }
    const database = openDatabase(path);
    const removed = deleteUsers(database);
    database.close();
    output(
        removed === 0
            ? "There was no admin account to remove. Open /admin to set one up."
            : "Removed the admin account. Videos, channels and settings were kept.\n" +
                  "Open /admin in the app to create a new account: the setup code is printed in the app's log.",
    );
}
