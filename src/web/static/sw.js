// Tube Stop's service worker. The server puts two values in front of this file: BUILD, a fingerprint
// of the files below, and ASSETS, the list of files to keep. It does four things:
//   - keeps the app's own files, so pages draw without a connection
//   - keeps pages and thumbnails as they are browsed, and uses them when the server cannot be reached
//   - keeps the videos the server says are pinned (see sync), and plays them from the device, with seeking
//   - holds back "played" and "watched" reports made without a connection, and sends them later
/* global BUILD, ASSETS */

const SHELL = `tubestop-shell-${BUILD}`;
const PAGES = "tubestop-pages";
const THUMBS = "tubestop-thumbs";
const VIDEOS = "tubestop-videos";

const pageTimeoutMs = 3000; // how long to wait for the server before showing a kept copy of a page
const reportTimeoutMs = 5000;
const spareSpace = 0.9; // use at most this much of the room the browser says is free

const pagePath = /^\/(?:(?:topic|watch)\/[^/]+|other|watched)?$/;
const reportPath = /^\/api\/videos\/[\w-]{11}\/(?:played|watched)$/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("tubestop-shell-") && name !== SHELL) {
          await caches.delete(name);
        }
      }
      await self.clients.claim();
    })(),
  );
});

const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve(null), ms));

// ---- answering requests

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  if (request.method === "POST" && reportPath.test(url.pathname)) {
    event.respondWith(report(request));
  } else if (request.method !== "GET") {
    return;
  } else if (url.pathname.startsWith("/video/")) {
    event.respondWith(video(request, url));
  } else if (url.pathname.startsWith("/thumb/")) {
    event.respondWith(thumbnail(request));
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(request, { cacheName: SHELL }).then((kept) => kept ?? fetch(request)));
  } else if (request.mode === "navigate" && pagePath.test(url.pathname)) {
    event.respondWith(page(event));
  }
});

// The server first. A kept copy stands in when it cannot be reached, is slow, or is failing.
async function page(event) {
  const { request } = event;
  const cache = await caches.open(PAGES);
  const kept = await cache.match(request.url);
  try {
    const response = await (kept ? Promise.race([fetch(request), timeout(pageTimeoutMs)]) : fetch(request));
    if (response === null || (response.status >= 500 && kept)) {
      return kept;
    }
    if (response.ok) {
      event.waitUntil(cache.put(request.url, response.clone()));
    }
    return response;
  } catch (error) {
    return kept ?? (await cache.match("/")) ?? offlinePage();
  }
}

function offlinePage() {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tube Stop</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:3rem 1rem">
<h1>No connection</h1><p>Tube Stop can't be reached, and nothing has been saved on this device yet.</p>`;
  return new Response(body, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// A thumbnail never changes, so the kept copy is used first.
async function thumbnail(request) {
  const cache = await caches.open(THUMBS);
  const kept = await cache.match(request.url);
  if (kept) {
    return kept;
  }
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request.url, response.clone());
  }
  return response;
}

// A saved video is played from the device whether or not the server is there.
async function video(request, url) {
  const kept = await (await caches.open(VIDEOS)).match(url.pathname);
  return kept ? part(request, kept) : fetch(request);
}

// The cache only holds whole files, so the piece a player asks for (to start part way, or to seek) is cut out here.
async function part(request, kept) {
  const blob = await kept.blob();
  const size = blob.size;
  const headers = { "Content-Type": kept.headers.get("Content-Type") || "video/mp4", "Accept-Ranges": "bytes" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") ?? "");
  if (range === null || (range[1] === "" && range[2] === "")) {
    return new Response(blob, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
  }
  const start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
  const end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
  });
}

// ---- reports made without a connection

const openQueue = () =>
  new Promise((resolve, reject) => {
    const opening = indexedDB.open("tubestop", 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("reports", { autoIncrement: true });
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });

async function queue(mode, work) {
  const db = await openQueue();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("reports", mode);
    const result = work(transaction.objectStore("reports"));
    transaction.oncomplete = () => {
      db.close();
      resolve(result.result);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

// Passed on to the server; if that cannot be done, kept until the next time it can.
async function report(request) {
  try {
    const response = await Promise.race([fetch(request), timeout(reportTimeoutMs)]);
    if (response !== null) {
      return response;
    }
  } catch (error) {
    /* no connection: kept below */
  }
  await queue("readwrite", (store) => store.add(new URL(request.url).pathname));
  return new Response(null, { status: 202 });
}

async function sendKeptReports() {
  const keys = await queue("readonly", (store) => store.getAllKeys());
  const paths = await queue("readonly", (store) => store.getAll());
  for (const [index, key] of keys.entries()) {
    try {
      const response = await fetch(paths[index], { method: "POST" });
      if (response.status >= 500) {
        return;
      }
    } catch (error) {
      return;
    }
    await queue("readwrite", (store) => store.delete(key));
  }
}

// ---- saving videos

const idOf = (request) => new URL(request.url).pathname.split("/").pop();

async function tell(message) {
  for (const client of await self.clients.matchAll({ type: "window" })) {
    client.postMessage(message);
  }
}

async function savedVideos(cache) {
  const saved = new Map();
  for (const request of await cache.keys()) {
    saved.set(idOf(request), Number((await cache.match(request)).headers.get("Content-Length")) || 0);
  }
  return saved;
}

// The videos to keep: in the order the server listed them, as many as fit in the limit and the room left.
async function chooseVideos({ maxBytes, videos }, held) {
  let budget = maxBytes;
  const estimate = (await navigator.storage?.estimate?.()) ?? {};
  if (estimate.quota) {
    const heldBytes = [...held.values()].reduce((sum, size) => sum + size, 0);
    budget = Math.min(budget, Math.floor((estimate.quota - estimate.usage + heldBytes) * spareSpace));
  }
  const chosen = [];
  let used = 0;
  for (const entry of videos) {
    if (used + entry.size <= budget) {
      chosen.push(entry);
      used += entry.size;
    }
  }
  return chosen;
}

async function keepVideo(id, { videos, pages, thumbs }) {
  // The page and picture are small; the video is the point, so they may fail without stopping it.
  await Promise.allSettled([pages.add(`/watch/${id}`), thumbs.add(`/thumb/${id}`)]);
  const response = await fetch(`/video/${id}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`the server answered ${response.status}`);
  }
  await videos.put(`/video/${id}`, response);
}

let saving = false;

async function saveVideos(list) {
  const [videos, pages, thumbs] = await Promise.all([VIDEOS, PAGES, THUMBS].map((name) => caches.open(name)));
  const held = await savedVideos(videos);
  const chosen = await chooseVideos(list, held);
  const wanted = new Set(chosen.map((entry) => entry.id));
  for (const id of held.keys()) {
    if (!wanted.has(id)) {
      await videos.delete(`/video/${id}`);
    }
  }
  // A copy of the wrong size is replaced; the old one keeps playing until the new one is complete.
  const todo = chosen.filter((entry) => held.get(entry.id) !== entry.size);
  for (const [index, entry] of todo.entries()) {
    await tell({ type: "progress", done: index, total: todo.length });
    try {
      await keepVideo(entry.id, { videos, pages, thumbs });
    } catch (error) {
      /* tried again the next time the app is opened */
    }
  }
  await tell({ type: "saved", ids: [...(await savedVideos(videos)).keys()] });
}

// The pages ask for this each time they open and the server can be reached; `list` is null when only reports are to be sent.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "sync") {
    return;
  }
  event.waitUntil(
    (async () => {
      await sendKeptReports();
      if (event.data.list === null || saving) {
        return;
      }
      saving = true;
      try {
        await saveVideos(event.data.list);
      } finally {
        saving = false;
      }
    })(),
  );
});
