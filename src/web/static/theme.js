// Follow the device's light or dark setting. This runs in the <head>, before the page is
// drawn, so there is no flash of the wrong theme.
(() => {
  const darkMode = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () =>
    document.documentElement.setAttribute("data-bs-theme", darkMode.matches ? "dark" : "light");
  apply();
  darkMode.addEventListener("change", apply);
})();
