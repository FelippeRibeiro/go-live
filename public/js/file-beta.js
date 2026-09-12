const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

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
/** @type {WebSocket | null} */
let ws = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function captureFromLocalVideo() {
  if (localVideo.captureStream) return localVideo.captureStream();
  if (localVideo.mozCaptureStream) return localVideo.mozCaptureStream();
  throw new Error("captureStream não suportado neste navegador");
}

function clearRemoteVideo() {
  if (remoteVideo.srcObject instanceof MediaStream) {
    remoteVideo.srcObject.getTracks().forEach((t) => t.stop());
  }
  remoteVideo.srcObject = null;
  remoteVideo.load();
  remoteStream = null;
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
  for (const id of [...peerConnections.keys()]) closePeer(id);
}

function queueOrAddCandidate(peerId, candidate) {
  const pc = peerConnections.get(peerId);
  if (!pc) return Promise.resolve();
  if (!pc.remoteDescription) {
    const list = pendingCandidates.get(peerId) || [];
    list.push(candidate);
    pendingCandidates.set(peerId, list);
    return Promise.resolve();
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
      send({
        action: "candidate",
        to: peerId,
        candidate: event.candidate.toJSON(),
      });
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

function addClonedTracks(pc) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    pc.addTrack(track.clone(), stream);
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
    send({ action: "broadcaster" });
    btnStart.disabled = true;
    btnStop.disabled = false;
    fileInput.disabled = true;
    setStatus("Transmitindo — compartilhe esta URL para outros assistirem");
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
  send({ action: "watcher" });
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
window.addEventListener("beforeunload", () => closeAllPeers());

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws/file`);

  ws.onopen = () => {
    setStatus("Conectado — escolha um arquivo ou aguarde uma transmissão");
    if (!isBroadcaster) send({ action: "watcher" });
  };

  ws.onclose = () => {
    setStatus("Desconectado — reconectando…");
    setTimeout(connect, 1500);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    switch (msg.action) {
      case "broadcaster":
        if (isBroadcaster) break;
        clearRemoteVideo();
        closeAllPeers();
        send({ action: "watcher" });
        setStatus("Transmissor disponível — conectando…");
        break;

      case "forceStop":
        if (!isBroadcaster) break;
        stopBroadcast();
        setStatus("Outro transmissor assumiu");
        break;

      case "watcher": {
        if (!isBroadcaster || !stream || !msg.id) break;
        const pc = createPeerConnection(msg.id);
        addClonedTracks(pc);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          send({
            action: "offer",
            to: msg.id,
            sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          });
          setStatus(`Transmitindo para ${peerConnections.size} espectador(es)`);
        } catch (err) {
          console.warn("offer failed", err);
          closePeer(msg.id);
        }
        break;
      }

      case "offer": {
        if (isBroadcaster || !msg.from || !msg.sdp) break;
        clearRemoteVideo();
        const pc = createPeerConnection(msg.from);
        remoteStream = new MediaStream();
        remoteVideo.srcObject = remoteStream;
        pc.ontrack = (event) => {
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
          await pc.setRemoteDescription(msg.sdp);
          await flushCandidates(msg.from);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send({
            action: "answer",
            to: msg.from,
            sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          });
        } catch (err) {
          console.warn("answer failed", err);
          clearRemoteVideo();
          closePeer(msg.from);
        }
        break;
      }

      case "answer": {
        if (!msg.from || !msg.sdp) break;
        const pc = peerConnections.get(msg.from);
        if (!pc) break;
        try {
          await pc.setRemoteDescription(msg.sdp);
          await flushCandidates(msg.from);
        } catch (err) {
          console.warn("answer apply failed", err);
        }
        break;
      }

      case "candidate": {
        if (!msg.from || !msg.candidate) break;
        try {
          await queueOrAddCandidate(msg.from, msg.candidate);
        } catch (err) {
          console.warn("ICE error", err);
        }
        break;
      }

      case "disconnectPeer":
        if (msg.id) closePeer(msg.id);
        if (isBroadcaster) {
          setStatus(
            peerConnections.size
              ? `Transmitindo para ${peerConnections.size} espectador(es)`
              : "Transmitindo — aguardando espectadores"
          );
        }
        break;

      case "broadcasterLeft":
        if (isBroadcaster) break;
        closeAllPeers();
        clearRemoteVideo();
        setStatus("Transmissor saiu — aguardando nova transmissão");
        send({ action: "watcher" });
        break;
    }
  };
}

connect();
