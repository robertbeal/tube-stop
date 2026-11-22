import playerStyles from "../user/player.css" with { type: "file" };
import playerScript from "../user/player.js" with { type: "file" };
import bootstrapStyles from "./static/bootstrap.min.css" with { type: "file" };
import bootstrapLicense from "./static/bootstrap-LICENSE.txt" with { type: "file" };
import formsScript from "./static/forms.js" with { type: "file" };
import icon192 from "./static/icons/icon-192.png" with { type: "file" };
import icon512 from "./static/icons/icon-512.png" with { type: "file" };
import iconMaskable512 from "./static/icons/icon-maskable-512.png" with { type: "file" };
import offlineScript from "./static/offline.js" with { type: "file" };
import siteStyles from "./static/style.css" with { type: "file" };
import themeScript from "./static/theme.js" with { type: "file" };

/** The files the pages load. Importing them embeds them, so they are also inside a compiled binary. */
export const staticFiles = {
    "/static/bootstrap-LICENSE.txt": bootstrapLicense,
    "/static/bootstrap.min.css": bootstrapStyles,
    "/static/forms.js": formsScript,
    "/static/icons/icon-192.png": icon192,
    "/static/icons/icon-512.png": icon512,
    "/static/icons/icon-maskable-512.png": iconMaskable512,
    "/static/offline.js": offlineScript,
    "/static/style.css": siteStyles,
    "/static/theme.js": themeScript,
};

/** The files the service worker keeps on the device, so the pages can be drawn without a connection. */
export const precachedFiles: Record<string, string> = {
    ...Object.fromEntries(Object.entries(staticFiles).filter(([route]) => !route.endsWith(".txt"))),
    "/player.css": playerStyles,
    "/player.js": playerScript,
};
