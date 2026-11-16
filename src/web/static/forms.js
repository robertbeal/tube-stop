// Shows that a form has been sent: its button is disabled and shows a spinner, so a click never looks as if
// nothing happened and cannot be sent twice. A button can say what it is doing with data-busy-label.
(() => {
  // Screen readers hear the same thing through a live region that is on the page before anything is sent.
  const status = document.createElement("div");
  status.className = "visually-hidden";
  status.setAttribute("role", "status");
  document.body.append(status);

  const busy = new Map(); // each busy button, with what it showed before

  document.addEventListener("submit", (event) => {
    const button = event.submitter ?? event.target.querySelector('button[type="submit"]');
    if (event.defaultPrevented || !button || busy.has(button)) {
      return;
    }
    const label = button.dataset.busyLabel ?? "Working…";
    const spinner = document.createElement("span");
    spinner.className = "spinner-border spinner-border-sm me-2";
    spinner.setAttribute("aria-hidden", "true");

    busy.set(button, [...button.childNodes]);
    button.replaceChildren(spinner, label);
    button.disabled = true;
    status.textContent = label;
  });

  // Coming back with the Back button can show the page as it was left, so put the buttons back.
  addEventListener("pageshow", (event) => {
    if (!event.persisted) {
      return;
    }
    for (const [button, content] of busy) {
      button.replaceChildren(...content);
      button.disabled = false;
    }
    busy.clear();
    status.textContent = "";
  });
})();
