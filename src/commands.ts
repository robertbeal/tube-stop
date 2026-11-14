import { join } from "node:path";
import { Store } from "./db/store.ts";

/** Removes every admin account so a new one can be created from the setup page. */
export function resetAdmin(dataDir: string, output: (line: string) => void): void {
  const path = join(dataDir, "tubestop.db");
  if (!Bun.file(path).size) {
    throw new Error(`no database at ${path}: is DATA_DIR set to the same folder the app uses?`);
  }
  const store = new Store(path);
  const removed = store.deleteUsers();
  store.close();
  output(
    removed === 0
      ? "There were no admin accounts to remove. Open /admin to set one up."
      : `Removed ${removed} admin account(s). Videos, channels and settings were kept.\n` +
          "Open /admin in the app to create a new account: the setup code is printed in the app's log.",
  );
}
