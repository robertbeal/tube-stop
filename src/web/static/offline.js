// Makes the child's pages work without the server. The service worker (/sw.js) keeps pages and
// saved videos; this script asks it to refresh them, notices when the server cannot be reached, and
// then shows only what is saved on this device.
(() => {
  if (!("serviceWorker" in navigator) || !("caches" in window)) {
    return;
  }

  const root = document.documentElement;
  const onWatchPage = location.pathname.startsWith("/watch/");
  let saved = new Set();
  let offline = false;

  const statusBadge = document.createElement("div");
  statusBadge.className = "offline-status badge text-bg-dark";
  statusBadge.setAttribute("role", "status");
  statusBadge.hidden = true;
  document.body.append(statusBadge);

  const notice = document.createElement("div");
  notice.className = "alert alert-secondary py-2";
  notice.setAttribute("role", "status");
  notice.textContent = "No connection. Showing the videos saved on this device.";
  notice.hidden = true;
  document.querySelector("main")?.prepend(notice);

  function render() {
    root.classList.toggle("offline", offline);
    notice.hidden = !offline;
    for (const card of document.querySelectorAll("a.video-card[data-video-id]")) {
      const isSaved = saved.has(card.dataset.videoId);
      const frame = card.querySelector(".position-relative");
      const badge = frame?.querySelector(".saved-badge");
      if (isSaved && frame && !badge) {
        const added = document.createElement("span");
        added.className = "saved-badge badge text-bg-info position-absolute bottom-0 start-0 m-2";
        added.textContent = "On device";
        frame.append(added);
      } else if (!isSaved && badge) {
        badge.remove();
      }
      const wrapper = card.closest(".col, .shelf-item");
      if (wrapper) {
        wrapper.hidden = offline && !isSaved;
      }
    }
    // What cannot be reached without the server: the "see all" tiles, more pages, and the hide-watched button.
    const needsServer = ".shelf-more, nav[aria-label='Pages'], .hide-watched-form, .channel-bar";
    for (const part of document.querySelectorAll(needsServer)) {
      part.hidden = offline;
    }
    for (const shelf of document.querySelectorAll(".shelf")) {
      shelf.hidden = offline && !shelf.querySelector(".shelf-item:not([hidden]):not(.shelf-more)");
    }
    const hasCards = document.querySelector("a.video-card") !== null;
    const anyShown = document.querySelector(
      ".col:not([hidden]) > a.video-card, .shelf-item:not([hidden]) > a.video-card",
    );
    notice.textContent =
      offline && hasCards && !anyShown
        ? "No connection, and none of these videos are saved on this device."
        : "No connection. Showing the videos saved on this device.";
  }

  async function loadSaved() {
    const cache = await caches.open("tubestop-videos");
    saved = new Set((await cache.keys()).map((request) => new URL(request.url).pathname.split("/").pop()));
  }

  // The list of pinned videos doubles as the check that the server can be reached: a server that is
  // down behind a proxy answers with an error, and one that is out of reach does not answer at all.
  async function fetchList() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch("/api/offline", { cache: "no-store", signal: controller.signal });
      if (response.status >= 500) {
        return { reachable: false };
      }
      return { reachable: true, list: response.ok ? await response.json() : null };
    } catch (error) {
      return { reachable: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async function sync(worker) {
    const { reachable, list } = await fetchList();
    offline = !reachable;
    await loadSaved();
    render();
    if (reachable) {
      // Downloading while a video plays would slow it down, so only reports are sent from the watch page.
      worker.postMessage({ type: "sync", list: onWatchPage ? null : (list ?? null) });
    }
  }

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "progress") {
      statusBadge.textContent = `Saving videos for offline: ${event.data.done + 1} of ${event.data.total}`;
      statusBadge.hidden = false;
    } else if (event.data?.type === "saved") {
      statusBadge.hidden = true;
      saved = new Set(event.data.ids);
      render();
      navigator.storage?.persist?.().catch(() => {});
    }
  });

  navigator.serviceWorker
    .register("/sw.js")
    .then(() => navigator.serviceWorker.ready)
    .then((registration) => {
      const run = () => sync(registration.active);
      window.addEventListener("online", run);
      window.addEventListener("offline", run);
      return run();
    })
    .catch(() => {});
})();
