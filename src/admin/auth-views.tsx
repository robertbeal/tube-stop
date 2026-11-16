import type { FC } from "hono/jsx";
import { Layout } from "../web/layout.tsx";

export type LoginProps = {
    next: string;
    username?: string;
    error?: string;
};

export const LoginPage: FC<LoginProps> = ({ next, username = "", error }) => (
    <Layout title="Admin login · Tube Stop">
        <div class="card auth-card mx-auto mt-4 shadow-sm">
            <div class="card-body p-4">
                <form method="post" action="/admin/login">
                    <h1 class="h4 mb-3">Admin login</h1>
                    {error && (
                        <div class="alert alert-danger" role="alert">
                            {error}
                        </div>
                    )}
                    <input type="hidden" name="next" value={next} />
                    <div class="mb-3">
                        <label class="form-label" for="username">
                            Username
                        </label>
                        <input
                            class="form-control"
                            id="username"
                            name="username"
                            value={username}
                            autocomplete="username"
                            autocapitalize="none"
                            autofocus={username === ""}
                            required
                        />
                    </div>
                    <div class="mb-3">
                        <label class="form-label" for="password">
                            Password
                        </label>
                        <input
                            class="form-control"
                            id="password"
                            type="password"
                            name="password"
                            autocomplete="current-password"
                            autofocus={username !== ""}
                            required
                        />
                    </div>
                    <button type="submit" class="btn btn-primary w-100" data-busy-label="Logging in…">
                        Log in
                    </button>
                </form>
            </div>
        </div>
    </Layout>
);

export const SetupPage: FC<{ username?: string; error?: string }> = ({ username = "", error }) => (
    <Layout title="Set up · Tube Stop">
        <div class="card auth-card mx-auto mt-4 shadow-sm">
            <div class="card-body p-4">
                <form method="post" action="/admin/setup">
                    <h1 class="h4 mb-2">Set up Tube Stop</h1>
                    <p class="text-body-secondary">
                        Create the admin account. The setup code is printed in the app's log (the terminal or container
                        logs where it is running).
                    </p>
                    {error && (
                        <div class="alert alert-danger" role="alert">
                            {error}
                        </div>
                    )}
                    <div class="mb-3">
                        <label class="form-label" for="code">
                            Setup code
                        </label>
                        <input
                            class="form-control"
                            id="code"
                            name="code"
                            autocomplete="off"
                            autocapitalize="characters"
                            spellcheck={false}
                            placeholder="XXXX-XXXX"
                            autofocus
                            required
                        />
                    </div>
                    <div class="mb-3">
                        <label class="form-label" for="username">
                            Username
                        </label>
                        <input
                            class="form-control"
                            id="username"
                            name="username"
                            value={username}
                            autocomplete="username"
                            autocapitalize="none"
                            maxlength={64}
                            required
                        />
                    </div>
                    <div class="mb-3">
                        <label class="form-label" for="password">
                            Password
                        </label>
                        <input
                            class="form-control"
                            id="password"
                            type="password"
                            name="password"
                            autocomplete="new-password"
                            minlength={8}
                            maxlength={72}
                            aria-describedby="password-help"
                            required
                        />
                        <div id="password-help" class="form-text">
                            At least 8 characters.
                        </div>
                    </div>
                    <div class="mb-3">
                        <label class="form-label" for="confirm">
                            Confirm password
                        </label>
                        <input
                            class="form-control"
                            id="confirm"
                            type="password"
                            name="confirm"
                            autocomplete="new-password"
                            minlength={8}
                            maxlength={72}
                            required
                        />
                    </div>
                    <button type="submit" class="btn btn-primary w-100" data-busy-label="Creating…">
                        Create admin account
                    </button>
                </form>
            </div>
        </div>
    </Layout>
);
