const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

const socket = io({ transports: ["websocket"] });
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const fileInput = document.getElementById("fileInput");
const fileName = document.getElementById("file-name");
const btnStart = document.getElementById("btnStart");
const btnStop = document.getElementById("btnStop");
const statusEl = document.getElementById("status");

/** @type {MediaStream | null} */
let stream = null;
/** @type {Map<string, RTCPeerConnection>} */
const peerConnections = new Map();
let isBroadcaster = false;

function setStatus(text) {
  statusEl.textContent = text;
}

function captureFromLocalVideo() {
  if (localVideo.captureStream) return localVideo.captureStream();
  if (localVideo.mozCaptureStream) return localVideo.mozCaptureStream();
  throw new Error("captureStream não suportado neste navegador");
}

async function startBroadcast() {
  if (!localVideo.src) {
    setStatus("Selecione um arquivo de vídeo primeiro");
    return;
  }

  try {
    await localVideo.play();
    stream = captureFromLocalVideo();
    isBroadcaster = true;
    socket.emit("broadcaster");
    btnStart.disabled = true;
    btnStop.disabled = false;
    fileInput.disabled = true;
    setStatus("Transmitindo — abra outra aba para assistir");
  } catch (err) {
    setStatus("Erro ao iniciar: " + (err.message || err));
  }
}

function stopBroadcast() {
  for (const [id, pc] of peerConnections) {
    pc.close();
    peerConnections.delete(id);
  }
  stream = null;
  isBroadcaster = false;
  localVideo.pause();
  btnStart.disabled = !localVideo.src;
  btnStop.disabled = true;
  fileInput.disabled = false;
  setStatus("Transmissão parada");
}

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection({ iceServers });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("candidate", peerId, event.candidate);
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      pc.close();
      peerConnections.delete(peerId);
    }
  };

  peerConnections.set(peerId, pc);
  return pc;
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  if (localVideo.src) URL.revokeObjectURL(localVideo.src);
  localVideo.src = URL.createObjectURL(file);
  localVideo.load();
  fileName.textContent = file.name;
  btnStart.disabled = false;
  setStatus("Arquivo pronto — clique em Iniciar transmissão");
});

btnStart.addEventListener("click", startBroadcast);
btnStop.addEventListener("click", stopBroadcast);

socket.on("connect", () => {
  setStatus("Conectado — escolha um arquivo ou aguarde uma transmissão");
  // Espectadores pedem para assistir; se já houver broadcaster, entram na fila.
  if (!isBroadcaster) socket.emit("watcher");
});

socket.on("broadcaster", () => {
  if (!isBroadcaster) {
    socket.emit("watcher");
    setStatus("Transmissor disponível — conectando…");
  }
});

// Broadcaster: novo espectador
socket.on("watcher", async (watcherId) => {
  if (!isBroadcaster || !stream) return;

  const pc = createPeerConnection(watcherId);
  for (const track of stream.getTracks()) {
    pc.addTrack(track, stream);
  }

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("offer", watcherId, pc.localDescription);
  } catch (err) {
    console.warn("offer failed", err);
    pc.close();
    peerConnections.delete(watcherId);
  }
});

// Espectador: recebe offer
socket.on("offer", async (broadcasterSocketId, description) => {
  if (isBroadcaster) return;

  let pc = peerConnections.get(broadcasterSocketId);
  if (pc) {
    pc.close();
    peerConnections.delete(broadcasterSocketId);
  }

  pc = createPeerConnection(broadcasterSocketId);
  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0] || new MediaStream([event.track]);
    remoteVideo.play().catch(() => {});
    setStatus("Recebendo transmissão");
  };

  try {
    await pc.setRemoteDescription(description);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("answer", broadcasterSocketId, pc.localDescription);
  } catch (err) {
    console.warn("answer failed", err);
  }
});

// Broadcaster: recebe answer
socket.on("answer", async (watcherId, description) => {
  const pc = peerConnections.get(watcherId);
  if (!pc) return;
  try {
    await pc.setRemoteDescription(description);
  } catch (err) {
    console.warn("setRemoteDescription answer failed", err);
  }
});

socket.on("candidate", async (peerId, candidate) => {
  const pc = peerConnections.get(peerId);
  if (!pc) return;
  try {
    await pc.addIceCandidate(candidate);
  } catch (err) {
    console.warn("ICE candidate error", err);
  }
});

socket.on("disconnectPeer", (peerId) => {
  const pc = peerConnections.get(peerId);
  if (pc) {
    pc.close();
    peerConnections.delete(peerId);
  }
  if (!isBroadcaster && remoteVideo.srcObject) {
    remoteVideo.srcObject = null;
    setStatus("Transmissor saiu");
  }
});
