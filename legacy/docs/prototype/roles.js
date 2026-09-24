(() => {
  const form = document.querySelector("#role-form");
  const restore = document.querySelector("#restore-role");
  const confirmation = document.querySelector("#future-only");
  const validation = document.querySelector("#role-validation");
  const result = document.querySelector("#role-result");
  if (form) form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!confirmation.checked) {
      validation.hidden = false;
      confirmation.focus();
      return;
    }
    validation.hidden = true;
    result.textContent = "已保存为当前版。之后新开始的 prototype 智能体将使用新配置；已经开始工作的智能体保持原配置。";
    result.hidden = false;
    result.focus();
  });
  if (restore) restore.addEventListener("click", () => {
    result.textContent = "已恢复上一版为当前配置。它只用于之后新开始的 prototype 智能体。";
    result.hidden = false;
    result.focus();
  });
})();
