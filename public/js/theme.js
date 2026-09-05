const STORAGE_KEY = "go-live-theme";

function getPreferredTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return "dark";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    const next = theme === "dark" ? "light" : "dark";
    btn.textContent = next === "light" ? "Modo claro" : "Modo escuro";
    btn.setAttribute("aria-label", `Alternar para ${next === "light" ? "modo claro" : "modo escuro"}`);
  }
}

function initThemeToggle() {
  applyTheme(getPreferredTheme());
  const btn = document.getElementById("theme-toggle");
  btn?.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  });
}

initThemeToggle();
