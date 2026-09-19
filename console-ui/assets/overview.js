/**
 * Keeps the overview current while it stays open.
 *
 * The server renders the first paint, so the page is readable before this
 * script runs. This script only asks the same service for the same block every
 * thirty seconds -- under the requirement's one-minute ceiling -- and again the
 * moment the page returns to the foreground. On a failed read the last good
 * block stays on screen and a retry banner appears; the block is replaced only
 * after the replacement arrived, so nothing blanks or moves while reading.
 */
(() => {
  const REFRESH_MS = 30000;
  const body = document.getElementById("overview-body");
  const refreshed = document.getElementById("refreshed-at");
  const errorBox = document.getElementById("overview-error");
  if (!body || !refreshed) return;
  let inFlight = false;

  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
      const response = await fetch("/overview/sections", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("overview read failed");
      const payload = await response.json();
      if (typeof payload.body !== "string" || typeof payload.refreshed !== "string") {
        throw new Error("overview read returned an unexpected payload");
      }
      body.innerHTML = payload.body;
      refreshed.textContent = payload.refreshed;
      if (errorBox) errorBox.hidden = true;
    } catch {
      // The read failed; the content already on screen is still the last truth.
      if (errorBox) errorBox.hidden = false;
    } finally {
      inFlight = false;
    }
  }

  window.setInterval(() => void refresh(), REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });
})();
