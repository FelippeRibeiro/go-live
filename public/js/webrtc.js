const params = new URLSearchParams(window.location.search);
const roomId = params.get("room") || "";
const role = params.get("role") || "subscriber";
const password = params.get("password") || "";

const preview = document.getElementById("preview");
const remote = document.getElementById("remote");
const stageFrame = document.getElementById("stage-frame");
const stageHint = document.getElementById("stage-hint");
const hostControls = document.getElementById("host-controls");
const viewerControls = document.getElementById("viewer-controls");
const btnShare = document.getElementById("btn-share");
const btnStop = document.getElementById("btn-stop");
const btnFullscreen = document.getElementById("btn-fullscreen");
const btnFullscreenHost = document.getElementById("btn-fullscreen-host");
const btnFullscreenViewer = document.getElementById("btn-fullscreen-viewer");
const statusEl = document.getElementById("room-status");
const errorEl = document.getElementById("room-error");
const roomIdEl = document.getElementById("room-id");
const roomNameEl = document.getElementById("room-name");
const roleBadge = document.getElementById("role-badge");

roomIdEl.textContent = roomId;
roleBadge.textContent = role === "publisher" ? "Host" : "Espectador";

if (role === "publisher") {
  hostControls.hidden = false;
  if (viewerControls) viewerControls.hidden = true;
} else if (viewerControls) {
  viewerControls.hidden = false;
}

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

  // Acumula áudio + vídeo no mesmo MediaStream (SFU dispara ontrack por track).
  pc.ontrack = (ev) => {
    let stream = remote.srcObject;
    if (!(stream instanceof MediaStream)) {
      stream = new MediaStream();
      remote.srcObject = stream;
    }
    if (!stream.getTracks().some((t) => t.id === ev.track.id)) {
      stream.addTrack(ev.track);
    }
    setHint(false);
    setStatus("Recebendo transmissão");
    remote.play().catch(() => {
      /* autoplay com áudio pode exigir gesto do usuário */
    });
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
        setStatus(
          role === "publisher"
            ? "Pronto. Clique em Compartilhar tela."
            : "Na sala. Aguardando transmissão…"
        );
        if (role === "subscriber") setHint(true, "Aguardando transmissão…");
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
        setHint(true, "Transmissão encerrada — aguardando o host…");
        setStatus(msg.message || "Host saiu. A sala continua aberta.");
        if (remote.srcObject) {
          remote.srcObject.getTracks().forEach((t) => t.stop());
          remote.srcObject = null;
        }
        if (pc) {
          pc.close();
          pc = null;
        }
        break;

      case "error":
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
  }
}

function stopShare() {
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
  if (pc) {
    pc.close();
    pc = null;
  }
  btnShare.hidden = false;
  btnStop.hidden = true;
  setHint(true, "Compartilhamento parado");
  setStatus("Compartilhamento parado — recarregue a página para transmitir de novo");
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
btnFullscreenHost?.addEventListener("click", toggleFullscreen);
btnFullscreenViewer?.addEventListener("click", toggleFullscreen);

// Duplo clique no palco / vídeos → tela cheia
stageFrame?.addEventListener("dblclick", toggleFullscreen);

btnShare?.addEventListener("click", startShare);
btnStop?.addEventListener("click", stopShare);

connect();
