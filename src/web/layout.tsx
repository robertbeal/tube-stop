import { raw } from "hono/html";
import type { Child, FC, PropsWithChildren } from "hono/jsx";

type LayoutProps = {
    title: string;
    navbar?: Child;
};

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title, navbar, children }) => (
    <>
        {raw("<!doctype html>")}
        <html lang="en">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <meta name="color-scheme" content="light dark" />
                <title>{title}</title>
                <script src="/static/theme.js" />
                <link rel="stylesheet" href="/static/bootstrap.min.css" />
                <link rel="stylesheet" href="/static/style.css" />
            </head>
            <body>
                <nav class="navbar bg-body-tertiary border-bottom mb-3">
                    <div class="container-xxl">
                        <a class="navbar-brand fw-bold" href="/">
                            Tube Stop
                        </a>
                        {navbar}
                    </div>
                </nav>
                <main class="container-xxl pb-4">{children}</main>
            </body>
        </html>
    </>
);
