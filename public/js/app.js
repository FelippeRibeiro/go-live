const createForm = document.getElementById("create-form");
const joinForm = document.getElementById("join-form");
const errorEl = document.getElementById("home-error");
const hubGrid = document.getElementById("hub-grid");
const hubEmpty = document.getElementById("hub-empty");
const hubStatus = document.getElementById("hub-status");

function showError(msg) {
  errorEl.hidden = !msg;
  errorEl.textContent = msg || "";
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHub(rooms) {
  if (!hubGrid) return;
  const list = Array.isArray(rooms) ? rooms : [];

  if (list.length === 0) {
    hubGrid.innerHTML = "";
    hubEmpty.hidden = false;
    return;
  }

  hubEmpty.hidden = true;
  hubGrid.innerHTML = list
    .map((room) => {
      const live = Boolean(room.live);
      const viewers = Number(room.viewers) || 0;
      const name = escapeHTML(room.name || "Live");
      const id = escapeHTML(room.room_id || "");
      return `
        <a class="hub-card" href="/room.html?room=${encodeURIComponent(room.room_id)}&role=subscriber">
          <div class="hub-thumb ${live ? "is-live" : ""}">
            <span class="hub-thumb-label">LIVE</span>
            ${live ? `<span class="hub-live-dot" aria-hidden="true"></span>` : ""}
          </div>
          <div class="hub-card-meta">
            <strong class="hub-card-name">${name}</strong>
            <span class="hub-card-sub">${id} · ${viewers} assistindo</span>
          </div>
        </a>
      `;
    })
    .join("");
}

async function loadHubOnce() {
  try {
    const res = await fetch("/api/rooms");
    if (!res.ok) return;
    const data = await res.json();
    renderHub(data.rooms || []);
  } catch {
    /* hub WS cobre em seguida */
  }
}

function connectHub() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/hub`);

  ws.onopen = () => {
    if (hubStatus) hubStatus.textContent = "Ao vivo";
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.action === "rooms") {
      renderHub(msg.rooms || []);
    }
  };

  ws.onclose = () => {
    if (hubStatus) hubStatus.textContent = "Reconectando…";
    setTimeout(connectHub, 2000);
  };

  ws.onerror = () => {
    ws.close();
  };
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

loadHubOnce();
connectHub();
