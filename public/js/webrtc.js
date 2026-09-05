const params = new URLSearchParams(window.location.search);
const roomId = params.get("room") || "";
const role = params.get("role") || "subscriber";
const password = params.get("password") || "";

const preview = document.getElementById("preview");
const remote = document.getElementById("remote");
const stageFrame = document.getElementById("stage-frame");
const stageHint = document.getElementById("stage-hint");
const hostControls = document.getElementById("host-controls");
const btnShare = document.getElementById("btn-share");
const btnStop = document.getElementById("btn-stop");
const btnFullscreen = document.getElementById("btn-fullscreen");
const shareHint = document.getElementById("share-hint");
const statusEl = document.getElementById("room-status");
const errorEl = document.getElementById("room-error");
const roomIdEl = document.getElementById("room-id");
const roomNameEl = document.getElementById("room-name");
const roleBadge = document.getElementById("role-badge");

let currentRole = role;

roomIdEl.textContent = roomId;
roleBadge.textContent = currentRole === "publisher" ? "Host" : "Espectador";

function updateRoleUI() {
  roleBadge.textContent = currentRole === "publisher" ? "Host" : "Espectador";
  if (shareHint) {
    shareHint.textContent =
      currentRole === "publisher"
        ? "Compartilhe o ID da sala com quem for assistir. Use ⛶ ou duplo clique para tela cheia."
        : "Você pode transmitir se não houver live ativa. Use ⛶ ou duplo clique para tela cheia.";
  }
}

updateRoleUI();

function setStatus(msg) {
  statusEl.textContent = msg || "";
}

function setError(msg) {
  errorEl.hidden = !msg;
  errorEl.textContent = msg || "";
}

function setHint(visible, text) {
  if (text) stageHint.textContent = text;
  stageHint.style.display = visible ? "grid" : "none";
}

if (!roomId || !/^[a-zA-Z0-9-]+$/.test(roomId)) {
  setError("Sala inválida. Volte e crie ou entre com um ID válido.");
  throw new Error("invalid room");
}

const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

/** Bitrate alto para tela local (8 Mbps) — o browser adapta se a rede não aguentar. */
const VIDEO_MAX_BITRATE = 8_000_000;
const VIDEO_MAX_FRAMERATE = 30;

let pc = null;
let localStream = null;
let micStream = null;
let ws = null;
let publishRequestPending = false;
const pendingCandidates = [];

function setStatus(msg) {
  statusEl.textContent = msg || "";
}

function setError(msg) {
  errorEl.hidden = !msg;
  errorEl.textContent = msg || "";
}

function setHint(visible, text) {
  if (text) stageHint.textContent = text;
  stageHint.style.display = visible ? "grid" : "none";
}

if (!roomId || !/^[a-zA-Z0-9-]+$/.test(roomId)) {
  setError("Sala inválida. Volte e crie ou entre com um ID válido.");
  throw new Error("invalid room");
}

const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

/** Bitrate alto para tela local (8 Mbps) — o browser adapta se a rede não aguentar. */
const VIDEO_MAX_BITRATE = 8_000_000;
const VIDEO_MAX_FRAMERATE = 30;

let pc = null;
let localStream = null;
let micStream = null;
let ws = null;
const pendingCandidates = [];

function wsURL() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

async function ensurePC() {
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers });

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      send({
        action: "candidate",
        candidate: {
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
        },
      });
    }
  };

  pc.onconnectionstatechange = () => {
    setStatus(`Conexão: ${pc.connectionState}`);
  };

  // SFU dispara ontrack por mídia — monta um MediaStream novo por sessão.
  pc.ontrack = (ev) => {
    let stream = remote.srcObject;
    if (!(stream instanceof MediaStream)) {
      stream = new MediaStream();
      remote.srcObject = stream;
    }
    // Remove track antiga do mesmo kind (restart da live).
    for (const old of stream.getTracks()) {
      if (old.kind === ev.track.kind) {
        stream.removeTrack(old);
      }
    }
    stream.addTrack(ev.track);
    // Reatribui para forçar o <video> redesenhar após restart.
    remote.srcObject = stream;
    setHint(false);
    setStatus("Recebendo transmissão");
    remote.play().catch(() => {});
  };

  return pc;
}

async function flushCandidates() {
  if (!pc?.remoteDescription) return;
  while (pendingCandidates.length) {
    const c = pendingCandidates.shift();
    try {
      await pc.addIceCandidate(c);
    } catch (err) {
      console.warn("ICE candidate error", err);
    }
  }
}

async function handleOffer(sdp) {
  // Offer do SFU após stop/start: PC limpa evita estado SDP quebrado.
  if (pc) {
    pc.close();
    pc = null;
  }
  pendingCandidates.length = 0;
  remote.srcObject = null;

  const peer = await ensurePC();
  await peer.setRemoteDescription({ type: "offer", sdp });
  await flushCandidates();
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  send({ action: "answer", sdp: answer.sdp, type: "answer" });
}

async function handleAnswer(sdp) {
  if (!pc) return;
  await pc.setRemoteDescription({ type: "answer", sdp });
  await flushCandidates();
}

async function handleCandidate(candidate) {
  const init = {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
  };
  if (!pc || !pc.remoteDescription) {
    pendingCandidates.push(init);
    return;
  }
  try {
    await pc.addIceCandidate(init);
  } catch (err) {
    console.warn("ICE candidate error", err);
  }
}

function connect() {
  setStatus("Conectando…");
  ws = new WebSocket(wsURL());

  ws.onopen = () => {
    send({
      action: "join",
      room_id: roomId,
      password,
      role,
    });
  };

  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    switch (msg.action) {
      case "joined":
        roomNameEl.textContent = msg.name || "Sala";
        currentRole = msg.role || currentRole;
        updateRoleUI();
        setStatus(
          currentRole === "publisher"
            ? "Pronto. Clique em Compartilhar tela."
            : "Na sala. Aguardando transmissão…"
        );
        if (currentRole === "subscriber") setHint(true, "Aguardando transmissão…");
        break;

      case "offer":
        await handleOffer(msg.sdp);
        break;

      case "answer":
        await handleAnswer(msg.sdp);
        break;

      case "candidate":
        if (msg.candidate) await handleCandidate(msg.candidate);
        break;

      case "ended":
        setHint(true, "Aguardando transmissão…");
        setStatus(
          currentRole === "publisher"
            ? "Pronto. Clique em Compartilhar tela."
            : (msg.message === "stream stopped"
              ? "Transmissão pausada — aguardando o host…"
              : "Host saiu. A sala continua aberta.")
        );
        clearRemoteMedia();
        break;

      case "stopped":
        setHint(true, "Compartilhamento parado");
        setStatus("Pronto. Clique em Compartilhar tela.");
        break;

      case "live_active":
        publishRequestPending = false;
        alert(msg.message || "Já existe uma transmissão ativa nesta sala.");
        setStatus("Transmissão ativa — aguarde para transmitir.");
        break;

      case "publish_ok":
        currentRole = "publisher";
        updateRoleUI();
        publishRequestPending = false;
        await startShare();
        break;

      case "error":
        publishRequestPending = false;
        if (msg.message) {
          // Erros de host presente: alert claro para o guest.
          if (/host/i.test(msg.message) || /publisher/i.test(msg.message)) {
            alert(msg.message);
          }
        }
        setError(msg.message || "Erro de sinalização");
        break;
    }
  };

  ws.onclose = () => {
    setStatus("Desconectado do servidor");
  };

  ws.onerror = () => {
    setError("Falha na conexão WebSocket");
  };
}

function clearRemoteMedia() {
  // Não chamar track.stop() em tracks remotas — só solta o elemento e a PC.
  remote.srcObject = null;
  pendingCandidates.length = 0;
  if (pc) {
    pc.close();
    pc = null;
  }
}

function clearLocalMedia() {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  preview.srcObject = null;
  preview.hidden = true;
  remote.hidden = false;
  pendingCandidates.length = 0;
  if (pc) {
    pc.close();
    pc = null;
  }
}

async function tuneVideoSender(peer) {
  const sender = peer.getSenders().find((s) => s.track?.kind === "video");
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }
  params.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
  params.encodings[0].maxFramerate = VIDEO_MAX_FRAMERATE;
  params.degradationPreference = "maintain-resolution";
  try {
    await sender.setParameters(params);
  } catch (err) {
    console.warn("setParameters failed", err);
  }
}

async function captureDisplayWithAudio() {
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: VIDEO_MAX_FRAMERATE, max: 60 },
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
    },
    audio: {
      channelCount: 2,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: 48000,
    },
    // Chromium: incluir áudio do sistema quando disponível
    systemAudio: "include",
    selfBrowserSurface: "exclude",
  });

  const videoTrack = displayStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.contentHint = "detail";
  }

  // Linux / alguns browsers não entregam áudio do display — fallback no microfone.
  if (displayStream.getAudioTracks().length === 0) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      for (const t of micStream.getAudioTracks()) {
        displayStream.addTrack(t);
      }
      setStatus("Transmitindo (áudio via microfone — marque “Compartilhar áudio” no diálogo se quiser áudio do sistema)");
    } catch {
      setStatus("Transmitindo sem áudio (navegador não liberou captura de som)");
    }
  }

  return displayStream;
}

async function startShare() {
  setError("");
  try {
    // Garante PC limpa se uma transmissão anterior deixou estado residual.
    if (pc) {
      pc.close();
      pc = null;
    }
    pendingCandidates.length = 0;

    const stream = await captureDisplayWithAudio();
    localStream = stream;
    preview.srcObject = stream;
    preview.muted = true; // evita feedback no host
    preview.hidden = false;
    remote.hidden = true;
    setHint(false);

    const peer = await ensurePC();
    for (const track of stream.getTracks()) {
      peer.addTrack(track, stream);
      track.onended = () => {
        if (track.kind === "video") stopShare();
      };
    }

    await tuneVideoSender(peer);

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    send({ action: "offer", sdp: offer.sdp, type: "offer" });

    btnShare.hidden = true;
    btnStop.hidden = false;
    if (!statusEl.textContent.includes("áudio")) {
      setStatus("Transmitindo");
    }
  } catch (err) {
    setError(err.message || "Não foi possível compartilhar a tela");
    clearLocalMedia();
    btnShare.hidden = false;
    btnStop.hidden = true;
  }
}

function requestShare() {
  setError("");
  if (currentRole === "publisher") {
    startShare();
    return;
  }
  if (publishRequestPending) return;
  publishRequestPending = true;
  setStatus("Verificando se há transmissão ativa…");
  send({ action: "request_publish" });
}

function stopShare() {
  send({ action: "stop" });
  clearLocalMedia();
  btnShare.hidden = false;
  btnStop.hidden = true;
  setHint(true, "Compartilhamento parado");
  setStatus("Pronto. Clique em Compartilhar tela.");
}

// Clique no player do espectador destrava autoplay com áudio.
remote?.addEventListener("click", () => {
  remote.muted = false;
  remote.play().catch(() => {});
});

function isFullscreen() {
  return Boolean(
    document.fullscreenElement ||
      document.webkitFullscreenElement
  );
}

async function toggleFullscreen() {
  const el = stageFrame;
  if (!el) return;
  try {
    if (isFullscreen()) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else if (el.requestFullscreen) {
      await el.requestFullscreen();
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    }
  } catch (err) {
    console.warn("fullscreen failed", err);
  }
}

btnFullscreen?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleFullscreen();
});

// Duplo clique no palco / vídeos → tela cheia
stageFrame?.addEventListener("dblclick", toggleFullscreen);

btnShare?.addEventListener("click", requestShare);
btnStop?.addEventListener("click", stopShare);

connect();
