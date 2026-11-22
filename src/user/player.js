(() => {
  const byId = (id) => document.getElementById(id);
  const v = byId("v");
  const player = byId("player");
  const controls = byId("controls");
  const transport = byId("transport");
  const surface = byId("surface");
  const playPause = byId("playPause");
  const skipBack = byId("skipBack");
  const skipForward = byId("skipForward");
  const seek = byId("seek");
  const seekTrack = byId("seekTrack");
  const elapsed = byId("elapsed");
  const durationText = byId("duration");
  const settingsButton = byId("settingsButton");
  const settings = byId("settings");
  const fullscreenButton = byId("fullscreenButton");
  const markA = byId("markA");
  const markB = byId("markB");
  const toggle = byId("loopToggle");
  const clear = byId("clearLoop");
  const info = byId("loopInfo");
  const announce = byId("announce");
  const speeds = settings.querySelectorAll('input[name="speed"]');
  const skipSeconds = 10;
  const seekSeconds = 5;
  const hideAfterMs = 3000;

  // Our own controls replace the browser's. Without this script, the browser's stay.
  v.controls = false;
  controls.hidden = false;

  let a = null;
  let b = null;
  let looping = false;

  const fmt = (t) => {
    const s = Math.max(0, Math.floor(t));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
  };

  // "1 minute 23 seconds": what a screen reader should say, not "83".
  const spoken = (t) => {
    const s = Math.max(0, Math.floor(t));
    const units = [
      [Math.floor(s / 3600), "hour"],
      [Math.floor((s % 3600) / 60), "minute"],
      [s % 60, "second"],
    ];
    const parts = units.filter(([n]) => n > 0).map(([n, name]) => `${n} ${name}${n === 1 ? "" : "s"}`);
    return parts.length > 0 ? parts.join(" ") : "0 seconds";
  };

  // Say something through the polite live region. Clearing first makes repeated messages read again.
  const say = (message) => {
    announce.textContent = "";
    setTimeout(() => {
      announce.textContent = message;
    }, 50);
  };

  const length = () => (Number.isFinite(v.duration) ? v.duration : 0);
  const percent = (t) => (length() > 0 ? Math.min(100, (t / length()) * 100) : 0);

  let spokenSecond = -1;
  function renderTime() {
    const total = length();
    seek.max = String(Math.floor(total));
    seek.value = String(Math.floor(v.currentTime));
    elapsed.textContent = fmt(v.currentTime);
    durationText.textContent = fmt(total);
    seekTrack.style.setProperty("--progress", `${percent(v.currentTime)}%`);
    const second = Math.floor(v.currentTime);
    if (second !== spokenSecond) {
      spokenSecond = second;
      seek.setAttribute("aria-valuetext", `${spoken(v.currentTime)} of ${spoken(total)}`);
    }
  }

  function renderLoop() {
    toggle.disabled = !(a !== null && b !== null && b > a);
    toggle.setAttribute("aria-pressed", String(looping));
    toggle.classList.toggle("active", looping);
    info.textContent = (a !== null ? `Start ${fmt(a)}` : "") + (b !== null ? `  End ${fmt(b)}` : "");
    seekTrack.style.setProperty("--loop-start", `${a !== null ? percent(a) : 0}%`);
    seekTrack.style.setProperty("--loop-end", `${a !== null && b !== null ? percent(b) : 0}%`);
  }

  function renderPlayState() {
    const ended = v.ended;
    const playing = !v.paused && !ended;
    player.classList.toggle("is-playing", playing);
    player.classList.toggle("is-ended", ended);
    playPause.setAttribute("aria-label", ended ? "Replay" : playing ? "Pause" : "Play");
  }

  // ---- showing and hiding the controls
  let hideTimer;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const keyboardFocusInside = () => {
    const active = document.activeElement;
    return controls.contains(active) && active.matches(":focus-visible");
  };

  function scheduleHide() {
    clearTimeout(hideTimer);
    const staysVisible = v.paused || v.ended || !settings.hidden || reducedMotion.matches || keyboardFocusInside();
    if (!staysVisible) {
      hideTimer = setTimeout(() => player.classList.add("controls-hidden"), hideAfterMs);
    }
  }

  function showControls() {
    player.classList.remove("controls-hidden");
    scheduleHide();
  }

  // The first tap on a hidden control only brings the controls back; it must not also press a button.
  let wasHidden = false;
  controls.addEventListener(
    "pointerdown",
    () => {
      wasHidden = player.classList.contains("controls-hidden");
    },
    true,
  );
  controls.addEventListener(
    "click",
    (event) => {
      if (wasHidden) {
        event.preventDefault();
        event.stopPropagation();
        wasHidden = false;
        showControls();
      }
    },
    true,
  );

  player.addEventListener("pointermove", showControls);
  controls.addEventListener("focusin", showControls);
  ["play", "pause", "ended"].forEach((name) =>
    v.addEventListener(name, () => {
      renderPlayState();
      showControls();
    }),
  );

  surface.addEventListener("click", () => {
    if (player.classList.contains("controls-hidden")) {
      showControls();
    } else {
      togglePlay();
    }
  });

  // ---- playing, skipping and seeking
  function togglePlay() {
    if (v.ended) {
      v.currentTime = 0;
    }
    if (v.paused || v.ended) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }

  function skipBy(seconds) {
    v.currentTime = Math.min(Math.max(0, v.currentTime + seconds), length() || v.currentTime + seconds);
    renderTime();
  }

  playPause.addEventListener("click", togglePlay);
  skipBack.addEventListener("click", () => skipBy(-skipSeconds));
  skipForward.addEventListener("click", () => skipBy(skipSeconds));
  seek.addEventListener("input", () => {
    v.currentTime = seek.valueAsNumber;
    renderTime();
    showControls();
  });
  seek.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      skipBy(event.key === "ArrowLeft" ? -seekSeconds : seekSeconds);
    }
  });

  ["timeupdate", "durationchange", "loadedmetadata", "seeked"].forEach((name) => v.addEventListener(name, renderTime));
  v.addEventListener("loadedmetadata", () => {
    v.playbackRate = parseFloat(settings.querySelector('input[name="speed"]:checked').value);
    renderLoop();
  });

  // ---- speed and loop
  function closeSettings(returnFocus) {
    settings.hidden = true;
    settingsButton.setAttribute("aria-expanded", "false");
    if (returnFocus) {
      settingsButton.focus();
    }
    scheduleHide();
  }

  settingsButton.addEventListener("click", () => {
    if (settings.hidden) {
      settings.hidden = false;
      settingsButton.setAttribute("aria-expanded", "true");
      settings.querySelector('input[name="speed"]:checked').focus();
      showControls();
    } else {
      closeSettings(true);
    }
  });
  document.addEventListener("click", (event) => {
    if (!settings.hidden && !settings.contains(event.target) && !settingsButton.contains(event.target)) {
      closeSettings(false);
    }
  });

  speeds.forEach((radio) =>
    radio.addEventListener("change", () => {
      v.playbackRate = parseFloat(radio.value);
      say(`Speed ${radio.value} times`);
    }),
  );

  markA.addEventListener("click", () => {
    a = v.currentTime;
    if (b !== null && b <= a) {
      b = null;
    }
    looping = false;
    renderLoop();
    say(`Loop start set at ${spoken(a)}`);
  });
  markB.addEventListener("click", () => {
    if (a === null || v.currentTime <= a) {
      say("Set the start first, then set the end later in the video");
      return;
    }
    b = v.currentTime;
    looping = true;
    renderLoop();
    say(`Loop on, from ${spoken(a)} to ${spoken(b)}`);
  });
  toggle.addEventListener("click", () => {
    looping = !looping;
    renderLoop();
    say(looping ? "Loop on" : "Loop off");
  });
  clear.addEventListener("click", () => {
    a = null;
    b = null;
    looping = false;
    renderLoop();
    say("Loop cleared");
  });
  v.addEventListener("timeupdate", () => {
    if (looping && b !== null && v.currentTime >= b) {
      v.currentTime = a;
    }
  });

  // ---- full screen
  const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  const canFullscreen = Boolean(player.requestFullscreen || player.webkitRequestFullscreen || v.webkitEnterFullscreen);
  fullscreenButton.hidden = !canFullscreen;

  async function toggleFullscreen() {
    if (fullscreenElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (player.requestFullscreen) {
      await player.requestFullscreen().catch(() => {});
      // Where it is allowed (Android), keep the screen sideways while the video fills it.
      try {
        await screen.orientation.lock("landscape");
      } catch (e) {
        /* not supported here: the screen follows the device */
      }
    } else if (player.webkitRequestFullscreen) {
      player.webkitRequestFullscreen();
    } else if (v.webkitEnterFullscreen) {
      v.webkitEnterFullscreen();
    }
  }

  function renderFullscreen() {
    const on = Boolean(fullscreenElement());
    player.classList.toggle("is-fullscreen", on);
    fullscreenButton.setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
    if (!on) {
      try {
        screen.orientation.unlock();
      } catch (e) {
        /* nothing was locked */
      }
    }
  }

  fullscreenButton.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", renderFullscreen);
  document.addEventListener("webkitfullscreenchange", renderFullscreen);

  // ---- keyboard: only while focus is in the player, and never taking keys from a focused control
  player.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !settings.hidden) {
      event.preventDefault();
      closeSettings(true);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const onControl = event.target.closest("button, input, a, select");
    if (event.key === "ArrowLeft" && !onControl) {
      skipBy(-skipSeconds);
    } else if (event.key === "ArrowRight" && !onControl) {
      skipBy(skipSeconds);
    } else if ((event.key === "k" || event.key === " ") && !onControl) {
      event.preventDefault();
      togglePlay();
    } else if (event.key === "f" && !event.target.matches("input[type=text]")) {
      toggleFullscreen();
    } else {
      return;
    }
    showControls();
  });

  renderTime();
  renderLoop();
  renderPlayState();
  scheduleHide();

  // ---- getting the video ready
  const id = v.dataset.id;
  const post = (path) => fetch(path, { method: "POST" });

  // Count a play once per page visit, when the video actually starts.
  v.addEventListener("play", () => post(`/api/videos/${id}/played`).catch(() => {}), { once: true });

  // "Watched" means the child got most of the way through by actually playing it, not by seeking
  // ahead: past 90% of the video or into its last 30 seconds, with at least half of it played.
  const watchedFraction = 0.9;
  const creditsSeconds = 30;
  const playedFraction = 0.5;
  const maxStepSeconds = 2; // a bigger jump between updates is a seek, not playing
  let playedSeconds = 0;
  let lastTime = null;
  let reportedWatched = false;

  const reportWatchedWhenDone = () => {
    const total = length();
    if (reportedWatched || total <= 0) {
      return;
    }
    const nearEnd = v.currentTime >= Math.min(total * watchedFraction, total - creditsSeconds) || v.ended;
    if (nearEnd && playedSeconds >= total * playedFraction) {
      reportedWatched = true;
      post(`/api/videos/${id}/watched`).catch(() => {
        reportedWatched = false;
      });
    }
  };

  v.addEventListener("timeupdate", () => {
    const step = lastTime === null ? 0 : v.currentTime - lastTime;
    lastTime = v.currentTime;
    if (!v.paused && step > 0 && step <= maxStepSeconds) {
      playedSeconds += step;
    }
    reportWatchedWhenDone();
  });
  v.addEventListener("seeking", () => {
    lastTime = null;
  });
  v.addEventListener("ended", reportWatchedWhenDone);

  // Without a connection, only the videos pinned on this device can play. The bar across the top says there is no
  // connection; this says what that means for this video, and the page loads again by itself when it is back.
  const showNotPinned = () => {
    byId("wait").hidden = true;
    byId("fail").hidden = true;
    byId("offline-fail").hidden = false;
    transport.inert = true;
    say("This video isn't pinned, so it can't play without a connection");
    for (const name of ["online", "tubestop:reachable"]) {
      window.addEventListener(name, () => location.reload(), { once: true });
    }
  };

  // A video that will not load might be missing, or the server might be out of reach: ask.
  v.addEventListener("error", async () => {
    if (!byId("offline-fail").hidden) {
      return;
    }
    try {
      const response = await fetch("/api/offline", { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (response.status >= 500) {
        showNotPinned();
      }
    } catch (e) {
      showNotPinned();
    }
  });

  // A video pinned on this device plays from it, whether or not the server has a file or can be reached.
  const pinnedHere = async () => {
    try {
      return Boolean(await (await caches.open("tubestop-videos")).match(`/video/${id}`));
    } catch (e) {
      return false; // no cache here (an insecure address, or a browser without one)
    }
  };

  // Not downloaded yet: ask the server to fetch it, then poll until it is ready.
  if (v.dataset.ready !== "true") {
    const wait = byId("wait");
    const fail = byId("fail");

    const poll = async () => {
      try {
        const s = await (await fetch(`/status/${id}`)).json();
        if (s.ready) {
          v.src = `/video/${id}`;
          wait.hidden = true;
          transport.inert = false;
          say("The video is ready");
          v.play().catch(() => {});
          return;
        }
        if (s.failed) {
          wait.hidden = true;
          fail.hidden = false;
          return;
        }
      } catch (e) {
        showNotPinned();
        return;
      }
      setTimeout(poll, 2000);
    };

    const prepare = async () => {
      fail.hidden = true;
      wait.hidden = false;
      try {
        await post(`/api/videos/${id}/prepare`);
      } catch (e) {
        showNotPinned();
        return;
      }
      poll();
    };

    byId("retry").addEventListener("click", (e) => {
      e.preventDefault();
      prepare();
    });
    pinnedHere().then((here) => {
      if (here) {
        v.src = `/video/${id}`;
        wait.hidden = true;
        transport.inert = false;
        v.play().catch(() => {});
      } else {
        prepare();
      }
    });
  }
})();
