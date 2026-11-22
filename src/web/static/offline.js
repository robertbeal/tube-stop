// Makes the child's pages work without the server, and lets the child pin videos to this device.
// The service worker (/sw.js) keeps pages and pinned videos; this script tells it when to refresh them,
// notices when the server cannot be reached, draws the pin button, the Pinned row and the badges, and
// then shows only what is on this device.
(() => {
  if (!("serviceWorker" in navigator) || !("caches" in window)) {
    return;
  }

  const root = document.documentElement;
  const onWatchPage = location.pathname.startsWith("/watch/");
  const onHomePage = location.pathname === "/" && location.search === "";
  const limitKey = "tubestop-max-bytes";
  const defaultLimit = 10 * 2 ** 30;

  let worker = null;
  let pins = [];
  let full = new Set();
  let offline = false;

  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  };
  const savedIds = () => new Set(pins.filter((pin) => pin.state === "saved").map((pin) => pin.id));
  const maxBytes = () => Number(localStorage.getItem(limitKey)) || defaultLimit;
  const post = (message) => worker?.postMessage({ ...message, maxBytes: maxBytes() });

  const formatDuration = (seconds) => {
    if (!(seconds > 0)) {
      return "";
    }
    const pad = (value) => String(value).padStart(2, "0");
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
  };

  const percent = (pin) => (pin.total > 0 ? Math.floor((pin.done / pin.total) * 100) : 0);
  const working = (pin) => pin.state === "preparing" || pin.state === "downloading";

  const statusBadge = make("div", "offline-status badge text-bg-dark");
  statusBadge.setAttribute("role", "status");
  statusBadge.hidden = true;
  document.body.append(statusBadge);

  const notice = make("div", "alert alert-secondary py-2");
  notice.setAttribute("role", "status");
  notice.hidden = true;
  document.querySelector("main")?.prepend(notice);

  // ---- the Pinned row on the home page: drawn here because each device has its own

  function pinnedCard(pin) {
    const item = make("li", "shelf-item");
    const card = make("a", "card video-card h-100 text-decoration-none");
    card.href = `/watch/${encodeURIComponent(pin.id)}`;
    card.dataset.videoId = pin.id;
    const frame = make("div", "position-relative");
    const ratio = make("div", "ratio ratio-16x9");
    const picture = make("img", "card-img-top");
    picture.src = `/thumb/${encodeURIComponent(pin.id)}`;
    picture.alt = "";
    picture.loading = "lazy";
    ratio.append(picture);
    frame.append(ratio);
    if (pin.duration > 0) {
      frame.append(make("span", "badge text-bg-dark position-absolute bottom-0 end-0 m-2", formatDuration(pin.duration)));
    }
    const body = make("div", "card-body p-2");
    body.append(make("h2", "card-title h6 mb-1 video-title", pin.title), make("p", "card-text small text-body-secondary mb-0", pin.channel));
    card.append(frame, body);
    item.append(card);
    return item;
  }

  function renderPinnedRow() {
    let shelf = document.getElementById("pinned-shelf");
    if (!onHomePage || pins.length === 0) {
      shelf?.remove();
      return;
    }
    const main = document.querySelector("main");
    if (!shelf) {
      shelf = make("section", "shelf mb-4");
      shelf.id = "pinned-shelf";
      shelf.setAttribute("aria-label", "Pinned");
      shelf.append(make("h2", "h4 mb-2", "📌 Pinned"), make("ul", "shelf-row list-unstyled d-flex gap-3 overflow-x-auto pb-2 mb-0"));
      const before = main.querySelector(".shelf, .row.row-cols-2");
      before ? before.before(shelf) : main.append(shelf);
    }
    const row = shelf.querySelector("ul");
    const wanted = pins.map((pin) => pin.id).join();
    if (row.dataset.ids !== wanted) {
      row.dataset.ids = wanted;
      row.replaceChildren(...pins.map(pinnedCard));
    }
  }

  // ---- drawing everything that depends on what is on this device

  function renderCards() {
    const saved = savedIds();
    for (const card of document.querySelectorAll("a.video-card[data-video-id]")) {
      const pin = pins.find((candidate) => candidate.id === card.dataset.videoId);
      const frame = card.querySelector(".position-relative");
      let badge = frame?.querySelector(".pin-badge");
      if (pin && frame) {
        if (!badge) {
          badge = make("span", "pin-badge badge position-absolute bottom-0 start-0 m-2");
          frame.append(badge);
        }
        badge.classList.toggle("text-bg-primary", pin.state === "saved");
        badge.classList.toggle("text-bg-warning", pin.state !== "saved");
        badge.textContent =
          pin.state === "saved" ? "📌 Pinned" : pin.state === "downloading" ? `Pinning ${percent(pin)}%` : "Pinning…";
      } else {
        badge?.remove();
      }
      const wrapper = card.closest(".col, .shelf-item");
      if (wrapper) {
        wrapper.hidden = offline && !saved.has(card.dataset.videoId);
      }
    }
    // Without the server, the home page is just the pinned videos; other pages show what of them is pinned.
    for (const grid of document.querySelectorAll("main > .row")) {
      grid.hidden = offline && onHomePage;
    }
    const needsServer = ".shelf-more, nav[aria-label='Pages'], .hide-watched-form, .channel-bar";
    for (const part of document.querySelectorAll(needsServer)) {
      part.hidden = offline;
    }
    for (const shelf of document.querySelectorAll(".shelf:not(#pinned-shelf)")) {
      shelf.hidden = offline && (onHomePage || !shelf.querySelector(".shelf-item:not([hidden]):not(.shelf-more)"));
    }
    const pinnedShelf = document.getElementById("pinned-shelf");
    if (pinnedShelf) {
      pinnedShelf.hidden = offline && saved.size === 0;
    }
  }

  function renderNotice() {
    const saved = savedIds();
    const anyShown = document.querySelector(".col:not([hidden]) > a.video-card, .shelf-item:not([hidden]) > a.video-card");
    notice.hidden = !offline;
    notice.textContent =
      saved.size === 0
        ? "No connection, and no videos are pinned on this device."
        : onHomePage || anyShown || !document.querySelector("a.video-card")
          ? "No connection. Showing the videos pinned on this device."
          : "No connection, and none of these videos are pinned on this device.";
  }

  const pinButton = document.getElementById("pinButton");
  const pinMessage = document.getElementById("pinMessage");

  function renderPinButton() {
    if (!pinButton) {
      return;
    }
    const id = pinButton.dataset.id;
    const pin = pins.find((candidate) => candidate.id === id);
    pinButton.hidden = !worker || (offline && !pin);
    pinButton.setAttribute("aria-pressed", String(Boolean(pin)));
    pinButton.classList.toggle("btn-primary", Boolean(pin));
    pinButton.classList.toggle("btn-outline-primary", !pin);
    pinButton.textContent = !pin
      ? "📌 Pin"
      : pin.state === "saved"
        ? "📌 Pinned"
        : pin.state === "downloading"
          ? `📌 Pinning… ${percent(pin)}%`
          : pin.state === "failed"
            ? "📌 Couldn't pin. Try again"
            : "📌 Pinning…";
    pinMessage.textContent = full.has(id)
      ? "There's no room left on this device. Unpin a video first."
      : pin?.state === "saved"
        ? "On this device. It plays without a connection."
        : pin?.state === "waiting"
          ? offline
            ? "It will be pinned when the server can be reached."
            : "Waiting for its turn."
          : pin && working(pin)
            ? "Keep this page open, or leave: it carries on."
            : "";
  }

  function renderStatus() {
    const busy = pins.filter(working);
    const left = offline ? [] : pins.filter((pin) => pin.state !== "saved" && pin.state !== "failed");
    statusBadge.hidden = onWatchPage || left.length === 0;
    const current = busy.find((pin) => pin.state === "downloading");
    statusBadge.textContent = `Pinning ${left.length === 1 ? "1 video" : `${left.length} videos`}${current ? `: ${percent(current)}%` : "…"}`;
  }

  function render() {
    root.classList.toggle("offline", offline);
    renderPinnedRow();
    renderCards();
    renderNotice();
    renderPinButton();
    renderStatus();
  }

  pinButton?.addEventListener("click", () => {
    const id = pinButton.dataset.id;
    const pin = pins.find((candidate) => candidate.id === id);
    if (pin && pin.state !== "failed") {
      post({ type: "unpin", id });
    } else {
      post({
        type: "pin",
        id,
        title: pinButton.dataset.title,
        channel: pinButton.dataset.channel,
        duration: Number(pinButton.dataset.duration),
      });
      // Asked from a tap, so the browser may offer to keep the data from being cleared when space runs short.
      navigator.storage?.persist?.().catch(() => {});
    }
  });

  // ---- reaching the server

  // Asking how much room the server allows doubles as the check that it can be reached: a server that is
  // down behind a proxy answers with an error, and one that is out of reach does not answer at all.
  async function checkServer() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch("/api/offline", { cache: "no-store", signal: controller.signal });
      if (response.status >= 500) {
        return false;
      }
      if (response.ok) {
        localStorage.setItem(limitKey, String((await response.json()).maxBytes));
      }
      return true;
    } catch (error) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function sync() {
    const reachable = await checkServer();
    offline = !reachable;
    render();
    // Downloading while a video plays would slow it down: the watch page only sends reports and checks the pins.
    post({ type: "sync", reachable, downloads: !onWatchPage });
  }

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "state") {
      pins = event.data.pins;
      full = new Set(event.data.full);
      render();
    }
  });

  navigator.serviceWorker
    .register("/sw.js")
    .then(() => navigator.serviceWorker.ready)
    .then((registration) => {
      worker = registration.active;
      window.addEventListener("online", sync);
      window.addEventListener("offline", sync);
      return sync();
    })
    .catch(() => {});
})();
