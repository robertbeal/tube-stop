import { raw } from "hono/html";
import type { Child, FC, PropsWithChildren } from "hono/jsx";

type LayoutProps = {
    title: string;
    navbar?: Child;
    /** Extra elements for the page's <head>. */
    head?: Child;
    /** A button to go back, shown in place of the app's name. */
    back?: { href: string; label: string };
    /** Make the page installable and usable without the server: for the child's pages, not the admin's. */
    offline?: boolean;
};

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({
    title,
    navbar,
    head,
    back,
    offline = false,
    children,
}) => (
    <>
        {raw("<!doctype html>")}
        <html lang="en">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
                <meta name="color-scheme" content="light dark" />
                <title>{title}</title>
                <script src="/static/theme.js" />
                <link rel="stylesheet" href="/static/bootstrap.min.css" />
                <link rel="stylesheet" href="/static/style.css" />
                <script src="/static/forms.js" defer />
                {offline && (
                    <>
                        <link rel="manifest" href="/manifest.webmanifest" />
                        <link rel="icon" href="/static/icons/icon-192.png" />
                        <link rel="apple-touch-icon" href="/static/icons/icon-192.png" />
                        <meta name="theme-color" content="#1c2434" />
                        <script src="/static/offline.js" defer />
                    </>
                )}
                {head}
            </head>
            <body>
                <nav class="navbar bg-body-tertiary border-bottom mb-3">
                    <div class="container-xxl">
                        {back === undefined ? (
                            <a class="navbar-brand fw-bold" href="/">
                                Tube Stop
                            </a>
                        ) : (
                            <a
                                class="btn btn-primary btn-lg back-button"
                                href={back.href}
                                aria-label={`Back to ${back.label.toLowerCase()}`}
                            >
                                <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
                                    <path
                                        fill="currentColor"
                                        d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"
                                    />
                                </svg>
                                {back.label}
                            </a>
                        )}
                        {navbar}
                    </div>
                </nav>
                <main class="container-xxl pb-4">{children}</main>
            </body>
        </html>
    </>
);
