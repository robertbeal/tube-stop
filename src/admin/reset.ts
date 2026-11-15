import { config } from "../shared/config.ts";
import { deleteUsers } from "./users.ts";

/** Removes the admin account so a new one can be created from the setup page. */
export function resetAdmin(output: (line: string) => void): void {
    const removed = deleteUsers();
    output(
        removed === 0
            ? `There was no admin account to remove in ${config.dataDir}. Open /admin to set one up.`
            : `Removed the admin account from ${config.dataDir}. Videos, channels and settings were kept.\n` +
                  "Open /admin in the app to create a new account: the setup code is printed in the app's log.",
    );
}
