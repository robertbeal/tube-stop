import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../shared/config.ts";

/** Removes the admin account so a new one can be created from the setup page. */
export async function resetAdmin(output: (line: string) => void): Promise<void> {
    const path = join(config.dataDir, "tubestop.db");

    // Importing users.ts opens the database, which would create an empty one here, so a wrong DATA_DIR must be caught first.
    if (!existsSync(path)) {
        throw new Error(`no database at ${path}: is DATA_DIR set to the same folder the app uses?`);
    }
    const { deleteUsers } = await import("./users.ts");
    const removed = deleteUsers();
    output(
        removed === 0
            ? "There was no admin account to remove. Open /admin to set one up."
            : "Removed the admin account. Videos, channels and settings were kept.\n" +
                  "Open /admin in the app to create a new account: the setup code is printed in the app's log.",
    );
}
