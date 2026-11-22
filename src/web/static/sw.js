// Tube Stop's service worker. The server puts two values in front of this file: BUILD, a fingerprint
// of the files below, and ASSETS, the list of files to keep. It does four things:
//   - keeps the app's own files, so pages draw without a connection
//   - keeps pages and thumbnails as they are browsed, and uses them when the server cannot be reached
//   - keeps the videos the child has pinned on this device, and plays them from the device, with seeking
//   - holds back "played" and "watched" reports made without a connection, and sends them later
/* global BUILD, ASSETS */

const SHELL = `tubestop-shell-${BUILD}`;
const PAGES = "tubestop-pages";
const THUMBS = "tubestop-thumbs";
const VIDEOS = "tubestop-videos";

const pageTimeoutMs = 3000; // how long to wait for the server before showing a kept copy of a page
const reportTimeoutMs = 5000;
const spareSpace = 0.9; // use at most this much of the room the browser says is free
const pollMs = 2000; // how often to ask whether the server has finished getting a video ready
const readyWaitMs = 4 * 60 * 1000; // after this, try again the next time the app is opened

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

// ---- what the device keeps

const openDb = () =>
  new Promise((resolve, reject) => {
    const opening = indexedDB.open("tubestop", 2);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      if (!db.objectStoreNames.contains("reports")) {
        db.createObjectStore("reports", { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("pins")) {
        db.createObjectStore("pins", { keyPath: "id" });
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });

async function store(name, mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(name, mode);
    const result = work(transaction.objectStore(name));
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

// ---- reports made without a connection

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
  await store("reports", "readwrite", (reports) => reports.add(new URL(request.url).pathname));
  return new Response(null, { status: 202 });
}

async function sendKeptReports() {
  const keys = await store("reports", "readonly", (reports) => reports.getAllKeys());
  const paths = await store("reports", "readonly", (reports) => reports.getAll());
  for (const [index, key] of keys.entries()) {
    try {
      const response = await fetch(paths[index], { method: "POST" });
      if (response.status >= 500) {
        return;
      }
    } catch (error) {
      return;
    }
    await store("reports", "readwrite", (reports) => reports.delete(key));
  }
}

// ---- pinned videos
//
// A pin is the child's wish to have a video on this device. It is kept in IndexedDB (with enough about the
// video to show it without the server); the video itself is kept in the cache once it has been downloaded.

const idOf = (request) => new URL(request.url).pathname.split("/").pop();
const allPins = () => store("pins", "readonly", (pins) => pins.getAll());
const getPin = (id) => store("pins", "readonly", (pins) => pins.get(id));
const putPin = (pin) => store("pins", "readwrite", (pins) => pins.put(pin));
const deletePin = (id) => store("pins", "readwrite", (pins) => pins.delete(id));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Gone extends Error {}
class Unfinished extends Error {}

let limit = 10 * 2 ** 30; // the most to keep, as last told by a page
let held = null; // id -> size of each video in the cache; null until read
let running = null; // the download loop, while it is going
const progress = new Map(); // id -> what is happening to a pin that is not in the cache yet
const controllers = new Map(); // id -> how to stop its download
const full = new Set(); // ids that could not be pinned for lack of room

async function heldVideos() {
  if (held === null) {
    held = new Map();
    const cache = await caches.open(VIDEOS);
    for (const request of await cache.keys()) {
      held.set(idOf(request), Number((await cache.match(request)).headers.get("Content-Length")) || 1);
    }
  }
  return held;
}

async function tell(message) {
  for (const client of await self.clients.matchAll({ type: "window" })) {
    client.postMessage(message);
  }
}

// What every open page needs to draw the pin buttons, the Pinned row and the badges.
async function broadcast() {
  const kept = await heldVideos();
  const pins = (await allPins())
    .sort((a, b) => b.pinnedAt - a.pinnedAt)
    .map((pin) => ({
      ...pin,
      ...(kept.has(pin.id) ? { state: "saved" } : (progress.get(pin.id) ?? { state: "waiting" })),
    }));
  await tell({ type: "state", pins, full: [...full] });
}

function setProgress(id, value) {
  progress.set(id, value);
  broadcast().catch(() => {});
}

// Takes a pin away, and its video with it.
async function removePin(id) {
  controllers.get(id)?.abort();
  await deletePin(id);
  await (await caches.open(VIDEOS)).delete(`/video/${id}`);
  (await heldVideos()).delete(id);
  progress.delete(id);
}

// How many more bytes of video fit: within the limit, and within the room the browser has left.
async function roomLeft() {
  const used = [...(await heldVideos()).values()].reduce((sum, size) => sum + size, 0);
  let budget = limit;
  const estimate = (await navigator.storage?.estimate?.()) ?? {};
  if (estimate.quota) {
    budget = Math.min(budget, Math.floor((estimate.quota - estimate.usage + used) * spareSpace));
  }
  return budget - used;
}

// The server only has a file once it has fetched it, which is the same wait as pressing play on a new video.
async function untilReady(id, signal) {
  const status = async () => {
    const response = await fetch(`/status/${id}`, { signal });
    if (response.status === 404) {
      throw new Gone();
    }
    return response.json();
  };
  if ((await status()).ready) {
    return;
  }
  await fetch(`/api/videos/${id}/prepare`, { method: "POST", signal });
  for (let waited = 0; waited < readyWaitMs; waited += pollMs) {
    await sleep(pollMs);
    const now = await status();
    if (now.ready) {
      return;
    }
    if (now.failed) {
      throw new Error("the server could not get the video");
    }
  }
  throw new Unfinished();
}

async function download(id) {
  const controller = new AbortController();
  controllers.set(id, controller);
  try {
    setProgress(id, { state: "preparing" });
    await untilReady(id, controller.signal);
    const [videos, pages, thumbs] = await Promise.all([VIDEOS, PAGES, THUMBS].map((name) => caches.open(name)));
    // The page and picture are small; the video is the point, so they may fail without stopping it.
    await Promise.allSettled([pages.add(`/watch/${id}`), thumbs.add(`/thumb/${id}`)]);
    const response = await fetch(`/video/${id}`, { cache: "no-store", signal: controller.signal });
    if (response.status === 404) {
      throw new Gone();
    }
    if (!response.ok || !response.body) {
      throw new Error(`the server answered ${response.status}`);
    }
    const total = Number(response.headers.get("Content-Length")) || 0;
    if (total > (await roomLeft())) {
      await response.body.cancel();
      await deletePin(id);
      full.add(id);
      return;
    }
    let done = 0;
    let lastTold = 0;
    setProgress(id, { state: "downloading", done, total });
    const counted = response.body.pipeThrough(
      new TransformStream({
        transform(chunk, output) {
          done += chunk.byteLength;
          if (Date.now() - lastTold > 500) {
            lastTold = Date.now();
            setProgress(id, { state: "downloading", done, total });
          }
          output.enqueue(chunk);
        },
      }),
    );
    // The copy only appears in the cache once it is whole.
    await videos.put(`/video/${id}`, new Response(counted, { status: 200, headers: response.headers }));
    (await heldVideos()).set(id, total || done || 1);
    if (!(await getPin(id))) {
      await removePin(id); // unpinned while it downloaded
    }
  } finally {
    controllers.delete(id);
    progress.delete(id);
  }
}

// Downloads the pinned videos that are not here yet, one at a time. Each is tried once per run.
function work() {
  running ??= (async () => {
    const tried = new Set();
    try {
      for (;;) {
        const kept = await heldVideos();
        const next = (await allPins()).find((pin) => !kept.has(pin.id) && !tried.has(pin.id));
        if (!next) {
          return;
        }
        tried.add(next.id);
        try {
          await download(next.id);
        } catch (error) {
          if (error instanceof Gone) {
            await removePin(next.id);
          } else if (error instanceof Unfinished) {
            /* still waiting: tried again next time */
          } else if (error.name === "QuotaExceededError") {
            await removePin(next.id);
            full.add(next.id);
          } else if (error.name !== "AbortError") {
            if (error instanceof TypeError) {
              return; // no connection: the rest would fail too
            }
            progress.set(next.id, { state: "failed" });
          }
        }
        await broadcast();
      }
    } finally {
      running = null;
      await broadcast().catch(() => {});
    }
  })();
  return running;
}

// Anything the server no longer allows is removed, and so is any saved video nobody has pinned.
async function tidy(reachable) {
  held = null;
  if (reachable) {
    const pins = await allPins();
    if (pins.length > 0) {
      try {
        const response = await fetch(`/api/offline?ids=${pins.map((pin) => pin.id).join(",")}`, { cache: "no-store" });
        if (response.ok) {
          const { allowed } = await response.json();
          for (const pin of pins) {
            if (!allowed.includes(pin.id)) {
              await removePin(pin.id);
            }
          }
        }
      } catch (error) {
        /* no connection after all: checked next time */
      }
    }
  }
  const wanted = new Set((await allPins()).map((pin) => pin.id));
  for (const id of [...(await heldVideos()).keys()]) {
    if (!wanted.has(id)) {
      await removePin(id);
    }
  }
}

// What the pages ask for. Every page says how much room the server allows each device.
self.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.maxBytes > 0) {
    limit = message.maxBytes;
  }
  event.waitUntil(
    (async () => {
      if (message?.type === "sync") {
        if (message.reachable) {
          await sendKeptReports();
        }
        await tidy(message.reachable);
        await broadcast();
        if (message.reachable && message.downloads) {
          await work();
        }
      } else if (message?.type === "pin") {
        const { id, title, channel, duration } = message;
        full.delete(id);
        await putPin({ id, title, channel, duration, pinnedAt: Date.now() });
        await broadcast();
        await work();
      } else if (message?.type === "unpin") {
        await removePin(message.id);
        full.delete(message.id);
        await broadcast();
      }
    })(),
  );
});
