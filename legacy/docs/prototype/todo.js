(() => {
  const form = document.querySelector("#approval-form");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const note = document.querySelector("#approval-note");
    const validation = document.querySelector("#note-validation");
    if (!note.value.trim()) {
      validation.hidden = false;
      note.setAttribute("aria-invalid", "true");
      note.focus();
      return;
    }
    validation.hidden = true;
    form.hidden = true;
    document.querySelector("#saved-result").hidden = false;
    document.querySelector("#saved-title").focus();
  });
})();
