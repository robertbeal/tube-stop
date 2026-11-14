(() => {
  const v = document.getElementById("v");
  const speed = document.getElementById("speed");
  const markA = document.getElementById("markA");
  const markB = document.getElementById("markB");
  const toggle = document.getElementById("loopToggle");
  const clear = document.getElementById("clearLoop");
  const info = document.getElementById("loopInfo");
  let a = null,
    b = null,
    looping = false;

  const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

  function refresh() {
    toggle.disabled = !(a !== null && b !== null && b > a);
    toggle.textContent = looping ? "Loop on" : "Loop off";
    toggle.classList.toggle("active", looping);
    info.textContent = (a !== null ? "A " + fmt(a) : "") + (b !== null ? "  B " + fmt(b) : "");
  }

  speed.addEventListener("change", () => {
    v.playbackRate = parseFloat(speed.value);
  });
  v.addEventListener("loadedmetadata", () => {
    v.playbackRate = parseFloat(speed.value);
  });
  markA.addEventListener("click", () => {
    a = v.currentTime;
    if (b !== null && b <= a) b = null;
    looping = false;
    refresh();
  });
  markB.addEventListener("click", () => {
    if (a === null || v.currentTime <= a) return;
    b = v.currentTime;
    looping = true;
    refresh();
  });
  toggle.addEventListener("click", () => {
    looping = !looping;
    refresh();
  });
  clear.addEventListener("click", () => {
    a = b = null;
    looping = false;
    refresh();
  });
  v.addEventListener("timeupdate", () => {
    if (looping && b !== null && v.currentTime >= b) v.currentTime = a;
  });
  refresh();

  const id = v.dataset.id;
  const post = (path) => fetch(path, { method: "POST" });

  // Count a play once per page visit, when the video actually starts.
  v.addEventListener("play", () => post(`/api/videos/${id}/played`).catch(() => {}), { once: true });

  // Not downloaded yet: ask the server to fetch it, then poll until it is ready.
  if (v.dataset.ready !== "true") {
    const wait = document.getElementById("wait");
    const fail = document.getElementById("fail");

    const poll = async () => {
      try {
        const s = await (await fetch(`/status/${id}`)).json();
        if (s.ready) {
          v.src = `/video/${id}`;
          wait.hidden = true;
          v.play().catch(() => {});
          return;
        }
        if (s.failed) {
          wait.hidden = true;
          fail.hidden = false;
          return;
        }
      } catch (e) {
        /* keep polling */
      }
      setTimeout(poll, 2000);
    };

    const prepare = async () => {
      fail.hidden = true;
      wait.hidden = false;
      try {
        await post(`/api/videos/${id}/prepare`);
      } catch (e) {
        /* the poll will show the outcome */
      }
      poll();
    };

    document.getElementById("retry").addEventListener("click", (e) => {
      e.preventDefault();
      prepare();
    });
    prepare();
  }
})();
