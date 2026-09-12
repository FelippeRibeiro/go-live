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
/** @type {Map<string, RTCIceCandidateInit[]>} */
const pendingCandidates = new Map();
/** @type {MediaStream | null} */
let remoteStream = null;
let isBroadcaster = false;
/** socket id do broadcaster ao qual este espectador está ligado */
let connectedBroadcasterId = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function captureFromLocalVideo() {
  if (localVideo.captureStream) return localVideo.captureStream();
  if (localVideo.mozCaptureStream) return localVideo.mozCaptureStream();
  throw new Error("captureStream não suportado neste navegador");
}

function clearRemoteVideo() {
  if (remoteVideo.srcObject) {
    const s = remoteVideo.srcObject;
    if (s instanceof MediaStream) {
      s.getTracks().forEach((t) => t.stop());
    }
  }
  remoteVideo.removeAttribute("src");
  remoteVideo.srcObject = null;
  remoteVideo.load();
  remoteStream = null;
  connectedBroadcasterId = null;
}

function closePeer(peerId) {
  const pc = peerConnections.get(peerId);
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    try {
      pc.close();
    } catch {
      /* ignore */
    }
    peerConnections.delete(peerId);
  }
  pendingCandidates.delete(peerId);
}

function closeAllPeers() {
  for (const id of [...peerConnections.keys()]) {
    closePeer(id);
  }
}

function queueOrAddCandidate(peerId, candidate) {
  const pc = peerConnections.get(peerId);
  if (!pc) return;
  if (!pc.remoteDescription) {
    const list = pendingCandidates.get(peerId) || [];
    list.push(candidate);
    pendingCandidates.set(peerId, list);
    return;
  }
  return pc.addIceCandidate(candidate);
}

async function flushCandidates(peerId) {
  const pc = peerConnections.get(peerId);
  const list = pendingCandidates.get(peerId) || [];
  pendingCandidates.delete(peerId);
  if (!pc) return;
  for (const c of list) {
    try {
      await pc.addIceCandidate(c);
    } catch (err) {
      console.warn("ICE flush error", err);
    }
  }
}

function createPeerConnection(peerId) {
  closePeer(peerId);

  const pc = new RTCPeerConnection({ iceServers });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("candidate", peerId, event.candidate.toJSON());
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      closePeer(peerId);
    }
  };

  peerConnections.set(peerId, pc);
  return pc;
}

/** Clona tracks para cada peer — captureStream não escala bem reutilizando o mesmo track. */
function addClonedTracks(pc) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    const cloned = track.clone();
    pc.addTrack(cloned, stream);
  }
}

async function startBroadcast() {
  if (!localVideo.src) {
    setStatus("Selecione um arquivo de vídeo primeiro");
    return;
  }

  try {
    clearRemoteVideo();
    closeAllPeers();

    await localVideo.play();
    stream = captureFromLocalVideo();
    isBroadcaster = true;
    socket.emit("broadcaster");
    // Espectadores já na sala pedem de novo via evento "broadcaster"
    btnStart.disabled = true;
    btnStop.disabled = false;
    fileInput.disabled = true;
    setStatus("Transmitindo — outros podem abrir esta URL para assistir");
  } catch (err) {
    isBroadcaster = false;
    stream = null;
    setStatus("Erro ao iniciar: " + (err.message || err));
  }
}

function stopBroadcast() {
  closeAllPeers();
  if (stream) {
    stream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
  }
  stream = null;
  isBroadcaster = false;
  localVideo.pause();
  btnStart.disabled = !localVideo.src;
  btnStop.disabled = true;
  fileInput.disabled = false;
  // Re-registra como possível espectador
  socket.emit("watcher");
  setStatus("Transmissão parada");
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

window.addEventListener("beforeunload", () => {
  closeAllPeers();
});

socket.on("connect", () => {
  setStatus("Conectado — escolha um arquivo ou aguarde uma transmissão");
  if (!isBroadcaster) socket.emit("watcher");
});

socket.on("broadcaster", () => {
  if (isBroadcaster) return;
  clearRemoteVideo();
  closeAllPeers();
  socket.emit("watcher");
  setStatus("Transmissor disponível — conectando…");
});

socket.on("forceStop", () => {
  if (!isBroadcaster) return;
  stopBroadcast();
  setStatus("Outro transmissor assumiu a sala");
});

// Broadcaster: novo espectador (N peers)
socket.on("watcher", async (watcherId) => {
  if (!isBroadcaster || !stream) return;

  const pc = createPeerConnection(watcherId);
  addClonedTracks(pc);

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("offer", watcherId, {
      type: pc.localDescription.type,
      sdp: pc.localDescription.sdp,
    });
    setStatus(`Transmitindo para ${peerConnections.size} espectador(es)`);
  } catch (err) {
    console.warn("offer failed", err);
    closePeer(watcherId);
  }
});

// Espectador: recebe offer
socket.on("offer", async (broadcasterSocketId, description) => {
  if (isBroadcaster) return;

  clearRemoteVideo();
  const pc = createPeerConnection(broadcasterSocketId);
  connectedBroadcasterId = broadcasterSocketId;
  remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  pc.ontrack = (event) => {
    // Acumula tracks (áudio + vídeo) no mesmo MediaStream — evita “fragmentos”
    if (event.streams?.[0]) {
      for (const track of event.streams[0].getTracks()) {
        if (!remoteStream.getTracks().some((t) => t.id === track.id)) {
          remoteStream.addTrack(track);
        }
      }
    } else if (event.track) {
      if (!remoteStream.getTracks().some((t) => t.id === event.track.id)) {
        remoteStream.addTrack(event.track);
      }
    }
    remoteVideo.play().catch(() => {});
    setStatus("Recebendo transmissão");
  };

  try {
    await pc.setRemoteDescription(description);
    await flushCandidates(broadcasterSocketId);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("answer", broadcasterSocketId, {
      type: pc.localDescription.type,
      sdp: pc.localDescription.sdp,
    });
  } catch (err) {
    console.warn("answer failed", err);
    clearRemoteVideo();
    closePeer(broadcasterSocketId);
  }
});

socket.on("answer", async (watcherId, description) => {
  const pc = peerConnections.get(watcherId);
  if (!pc) return;
  try {
    await pc.setRemoteDescription(description);
    await flushCandidates(watcherId);
  } catch (err) {
    console.warn("setRemoteDescription answer failed", err);
  }
});

socket.on("candidate", async (peerId, candidate) => {
  try {
    await queueOrAddCandidate(peerId, candidate);
  } catch (err) {
    console.warn("ICE candidate error", err);
  }
});

// Espectador saiu — só o broadcaster fecha aquele PC
socket.on("disconnectPeer", (peerId) => {
  closePeer(peerId);
  if (isBroadcaster) {
    setStatus(
      peerConnections.size
        ? `Transmitindo para ${peerConnections.size} espectador(es)`
        : "Transmitindo — aguardando espectadores"
    );
  }
});

// Broadcaster saiu / refresh — limpa vídeo remoto de todo mundo
socket.on("broadcasterLeft", () => {
  if (isBroadcaster) return;
  closeAllPeers();
  clearRemoteVideo();
  setStatus("Transmissor saiu — aguardando nova transmissão");
  socket.emit("watcher");
});
