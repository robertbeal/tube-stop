// Makes the child's pages work without the server, and lets the child pin videos to this device.
// The service worker (/sw.js) keeps pages and pinned videos; this script tells it when to refresh them,
// notices when the server cannot be reached, and draws what depends on this device: the pin button, the pinned
// badges, and the "Pinned only" view. Without a connection the pages stay as they were; only playing a video
// that is not pinned fails.
(() => {
  const root = document.documentElement;
  const filterKey = "tubestop-pinned-only";

  // Browsers that block site data throw instead of answering; the settings are then just not remembered.
  const read = (key) => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  };
  const write = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      /* not remembered */
    }
  };

  if (!("serviceWorker" in navigator) || !("caches" in window)) {
    root.classList.remove("pinned-only"); // set early by the page, to avoid a flash of the whole list
    return;
  }

  const onWatchPage = location.pathname.startsWith("/watch/");
  const onHomePage = location.pathname === "/" && location.search === "";
  const limitKey = "tubestop-max-bytes";
  const listsKey = "tubestop-lists-fetched";
  const defaultLimit = 10 * 2 ** 30;
  const listsEveryMs = 10 * 60 * 1000;
  const recheckMs = 15 * 1000;

  let worker = null;
  let ready = false; // the worker has said what is pinned
  let pins = [];
  let full = new Set();
  let offline = false;
  let pinnedOnly = read(filterKey) === "1";
  let viewKey = "";

  // Only the pages that list videos have the button, and so a pinned-only view.
  const filterButton = document.getElementById("pinnedToggle");

  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  };
  const maxBytes = () => Number(read(limitKey)) || defaultLimit;
  const post = (message) => worker?.postMessage({ ...message, maxBytes: maxBytes() });
  const percent = (pin) => (pin.total > 0 ? Math.floor((pin.done / pin.total) * 100) : 0);
  const working = (pin) => pin.state === "preparing" || pin.state === "downloading";
  const main = document.querySelector("main");

  const formatDuration = (seconds) => {
    if (!(seconds > 0)) {
      return "";
    }
    const pad = (value) => String(value).padStart(2, "0");
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
  };

  const statusBadge = make("div", "offline-status badge text-bg-dark");
  statusBadge.setAttribute("role", "status");
  statusBadge.hidden = true;
  document.body.append(statusBadge);

  // The bar across the top that says there is no connection. It is the only place that says so.
  const bar = make("div", "connection-bar text-bg-primary");
  bar.setAttribute("role", "status");
  const barInner = make("div", "connection-bar-inner");
  const barText = make("div", "connection-bar-text");
  barInner.append(barText);
  bar.append(barInner);
  document.body.prepend(bar);
  new ResizeObserver(() => root.style.setProperty("--connection-bar-height", `${bar.offsetHeight}px`)).observe(bar);

  // ---- the "Pinned only" view: drawn here, because each device has its own pins

  function pinnedCard(pin, tag, wrapperClass) {
    const wrapper = make(tag, wrapperClass);
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
      frame.append(
        make("span", "badge text-bg-dark position-absolute bottom-0 end-0 m-2", formatDuration(pin.duration)),
      );
    }
    if (pin.watchedAt > 0) {
      frame.append(make("span", "badge text-bg-success position-absolute top-0 end-0 m-2", "✓ Watched"));
    }
    const body = make("div", "card-body p-2");
    body.append(
      make("h2", "card-title h6 mb-1 video-title", pin.title),
      make("p", "card-text small text-body-secondary mb-0", pin.channel),
    );
    card.append(frame, body);
    wrapper.append(card);
    return wrapper;
  }

  // What part of the collection a list of videos shows: a topic, the videos with none, the watched ones, a channel.
  function contextOfLink(href) {
    const topic = /^\/topic\/([^/?]+)/.exec(href);
    if (topic) {
      return { kind: "topic", slug: decodeURIComponent(topic[1]) };
    }
    return href === "/other" ? { kind: "other" } : href === "/watched" ? { kind: "watched" } : { kind: "all" };
  }

  function contextOfPage() {
    const channel = new URLSearchParams(location.search).get("channel");
    return location.pathname === "/" && channel ? { kind: "channel", id: channel } : contextOfLink(location.pathname);
  }

  const isIn = (pin, context) =>
    context.kind === "topic"
      ? (pin.topics ?? []).includes(context.slug)
      : context.kind === "other"
        ? (pin.topics ?? []).length === 0
        : context.kind === "watched"
          ? pin.watchedAt > 0
          : context.kind === "channel"
            ? pin.channelId === context.id
            : true;

  const hidingWatched = () => document.querySelector(".hide-watched-form input[name='hide']")?.value === "0";

  // The pinned videos that belong in a list, in the order the server would give them.
  function pinnedIn(context) {
    const hide = hidingWatched() && context.kind !== "watched";
    const newest = (a, b) =>
      context.kind === "watched"
        ? b.watchedAt - a.watchedAt
        : b.publishedAt - a.publishedAt || b.pinnedAt - a.pinnedAt;
    return pins.filter((pin) => isIn(pin, context) && !(hide && pin.watchedAt > 0)).sort(newest);
  }

  // The page's own lists are left where they are, hidden by the stylesheet; this stands in for them, built from
  // the same sections but with only the pinned videos.
  function renderPinnedView() {
    if (!pinnedOnly || !filterButton) {
      root.classList.remove("pinned-only");
      document.getElementById("pinned-view")?.remove();
      viewKey = "";
      return;
    }
    if (!ready || !main) {
      return; // until the device says what is pinned, the page stays as the page set it
    }
    root.classList.add("pinned-only");
    const key = JSON.stringify([
      location.href,
      hidingWatched(),
      pins.map((pin) => [pin.id, pin.title, pin.topics, pin.channelId, pin.watchedAt, pin.publishedAt, pin.duration]),
    ]);
    if (key === viewKey && document.getElementById("pinned-view")) {
      return;
    }
    viewKey = key;
    document.getElementById("pinned-view")?.remove();
    const view = make("div", "");
    view.id = "pinned-view";
    for (const shelf of main.querySelectorAll(":scope > .shelf")) {
      const found = pinnedIn(contextOfLink(shelf.querySelector(".shelf-heading")?.getAttribute("href") ?? ""));
      if (found.length > 0) {
        const copy = shelf.cloneNode(true);
        copy.hidden = false;
        copy.querySelector(".shelf-row").replaceChildren(...found.map((pin) => pinnedCard(pin, "li", "shelf-item")));
        view.append(copy);
      }
    }
    const grid = main.querySelector(":scope > .row");
    const inGrid = grid ? pinnedIn(contextOfPage()) : [];
    if (grid && inGrid.length > 0) {
      const copy = grid.cloneNode(false);
      copy.append(...inGrid.map((pin) => pinnedCard(pin, "div", "col")));
      view.append(copy);
    }
    if (view.children.length === 0) {
      view.append(make("p", "text-body-secondary", "No pinned videos here."));
    }
    main.append(view);
  }

  function renderFilterButton() {
    if (!filterButton) {
      return;
    }
    filterButton.hidden = !worker;
    filterButton.setAttribute("aria-pressed", String(pinnedOnly));
    filterButton.classList.toggle("btn-success", pinnedOnly);
    filterButton.classList.toggle("btn-outline-secondary", !pinnedOnly);
    document.getElementById("pinnedToggleLabel").textContent = pinnedOnly ? "Show all" : "Pinned only";
  }

  filterButton?.addEventListener("click", () => {
    pinnedOnly = !pinnedOnly;
    write(filterKey, pinnedOnly ? "1" : "0");
    render();
  });

  // ---- badges, the pin button, and what to say without a connection

  function renderBadges() {
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
    }
  }

  // The hide-watched button changes a setting on the server.
  function renderServerButtons() {
    if (offline && !bar.classList.contains("is-visible")) {
      barText.textContent = "📡 No connection. Only pinned videos will play.";
    }
    bar.classList.toggle("is-visible", offline);
    for (const button of document.querySelectorAll(".hide-watched-form button")) {
      button.disabled = offline;
      button.title = offline ? "Needs a connection" : "";
    }
  }

  const pinButton = document.getElementById("pinButton");
  const pinMessage = document.getElementById("pinMessage");

  function renderPinButton() {
    if (!pinButton) {
      return;
    }
    const id = pinButton.dataset.id;
    const pin = pins.find((candidate) => candidate.id === id);
    pinButton.hidden = !worker;
    pinButton.disabled = offline && !pin;
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
      : offline && !pin
        ? "Pinning needs a connection."
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
    const left = offline ? [] : pins.filter((pin) => pin.state !== "saved" && pin.state !== "failed");
    const current = left.find((pin) => pin.state === "downloading");
    statusBadge.hidden = onWatchPage || left.length === 0;
    statusBadge.textContent = `Pinning ${left.length === 1 ? "1 video" : `${left.length} videos`}${current ? `: ${percent(current)}%` : "…"}`;
  }

  function render() {
    root.classList.toggle("offline", offline);
    renderFilterButton();
    renderPinnedView();
    renderBadges();
    renderServerButtons();
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

  // ---- getting ready for the connection to go

  // Tells the device what the page shows, so that every video listed can be opened later without the server.
  function remember(from) {
    const videos = [...from.querySelectorAll("a.video-card[data-title]")].map((card) => ({
      id: card.dataset.videoId,
      title: card.dataset.title,
      channel: card.dataset.channel,
      duration: Number(card.dataset.duration),
    }));
    if (pinButton) {
      videos.push({
        id: pinButton.dataset.id,
        title: pinButton.dataset.title,
        channel: pinButton.dataset.channel,
        duration: Number(pinButton.dataset.duration),
      });
    }
    if (videos.length > 0) {
      post({ type: "remember", videos });
    }
  }

  // The main lists (each topic, the rest, and the watched) are kept as well as the page, so that all of the
  // collection can be looked at, not just what was opened. Only their first page; the rest when they are visited.
  async function keepLists() {
    if (!onHomePage || offline || Date.now() - (Number(read(listsKey)) || 0) < listsEveryMs) {
      return;
    }
    write(listsKey, String(Date.now()));
    const links = new Set([...document.querySelectorAll("main .shelf-heading[href]")].map((a) => a.getAttribute("href")));
    const pages = await caches.open("tubestop-pages");
    for (const link of links) {
      try {
        const response = await fetch(link, { cache: "no-store" });
        if (response.ok) {
          await pages.put(new URL(link, location.href).href, response.clone());
          remember(new DOMParser().parseFromString(await response.text(), "text/html"));
        }
      } catch (error) {
        return;
      }
    }
  }

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
        write(limitKey, String((await response.json()).maxBytes));
      }
      return true;
    } catch (error) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function sync() {
    const wasOffline = offline;
    const reachable = await checkServer();
    offline = !reachable;
    render();
    if (wasOffline && reachable) {
      window.dispatchEvent(new Event("tubestop:reachable"));
    }
    // Downloading while a video plays would slow it down: the watch page only sends reports and checks the pins.
    post({ type: "sync", reachable, downloads: !onWatchPage });
    remember(document);
    keepLists();
  }

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "state") {
      pins = event.data.pins;
      full = new Set(event.data.full);
      ready = true;
      render();
    }
  });

  // If the device never answers, show everything rather than nothing.
  setTimeout(() => {
    if (!ready) {
      root.classList.remove("pinned-only");
    }
  }, 4000);

  navigator.serviceWorker
    .register("/sw.js")
    .then(() => navigator.serviceWorker.ready)
    .then((registration) => {
      worker = registration.active;
      window.addEventListener("online", sync);
      window.addEventListener("offline", sync);
      // A connection can come back without the browser noticing, when only the server was out of reach.
      setInterval(() => offline && sync(), recheckMs);
      return sync();
    })
    .catch(() => root.classList.remove("pinned-only"));
})();
