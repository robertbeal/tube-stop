import { resetAdmin } from "./admin/reset.ts";
import { serve } from "./serve.ts";
import "./shared/config.ts"; // checks the environment first, and exits with a message if it is invalid

async function main(): Promise<void> {
    const [command] = process.argv.slice(2);

    if (command === undefined) {
        return serve();
    }

    if (command === "reset-admin") {
        return resetAdmin(console.log);
    }

    throw new Error(`unknown command "${command}" (the only command is: reset-admin)`);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
