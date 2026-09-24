(() => {
  const allowed = new Set(["empty", "loading", "error", "waiting"]);
  const requested = new URLSearchParams(window.location.search).get("state");
  const state = allowed.has(requested) ? requested : "default";
  document.querySelectorAll(".state-view").forEach((view) => {
    view.hidden = view.id !== `state-${state}`;
  });
  document.querySelectorAll(".retry").forEach((retry) => {
    retry.addEventListener("click", () => window.location.assign(window.location.pathname));
  });
})();
