const createForm = document.getElementById("create-form");
const joinForm = document.getElementById("join-form");
const errorEl = document.getElementById("home-error");

function showError(msg) {
  errorEl.hidden = !msg;
  errorEl.textContent = msg || "";
}

createForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  const fd = new FormData(createForm);
  const name = String(fd.get("name") || "").trim();
  const password = String(fd.get("password") || "");

  try {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, password }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const data = await res.json();
    const params = new URLSearchParams({
      room: data.room_id,
      role: "publisher",
    });
    if (password) params.set("password", password);
    window.location.href = `/room.html?${params.toString()}`;
  } catch (err) {
    showError(err.message || "Falha ao criar sala");
  }
});

joinForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  showError("");
  const fd = new FormData(joinForm);
  const roomId = String(fd.get("room_id") || "").trim();
  const password = String(fd.get("password") || "");
  if (!/^[a-zA-Z0-9-]+$/.test(roomId)) {
    showError("ID da sala inválido");
    return;
  }
  const params = new URLSearchParams({
    room: roomId,
    role: "subscriber",
  });
  if (password) params.set("password", password);
  window.location.href = `/room.html?${params.toString()}`;
});
