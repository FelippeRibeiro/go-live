const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3002;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

/** @type {string | null} */
let broadcasterId = null;
/** @type {Set<string>} */
const watchers = new Set();

io.on("connection", (socket) => {
  console.log(`+ ${socket.id}`);

  socket.on("broadcaster", () => {
    // Novo transmissor (ou refresh): limpa o anterior e avisa a sala
    if (broadcasterId && broadcasterId !== socket.id) {
      io.to(broadcasterId).emit("forceStop");
    }
    broadcasterId = socket.id;
    watchers.delete(socket.id);
    socket.broadcast.emit("broadcaster");
    console.log(`broadcaster = ${socket.id} (watchers=${watchers.size})`);
  });

  socket.on("watcher", () => {
    if (socket.id === broadcasterId) return;
    watchers.add(socket.id);
    if (broadcasterId) {
      io.to(broadcasterId).emit("watcher", socket.id);
    }
  });

  socket.on("offer", (id, message) => {
    socket.to(id).emit("offer", socket.id, message);
  });

  socket.on("answer", (id, message) => {
    socket.to(id).emit("answer", socket.id, message);
  });

  socket.on("candidate", (id, message) => {
    socket.to(id).emit("candidate", socket.id, message);
  });

  socket.on("disconnect", () => {
    console.log(`- ${socket.id}`);
    watchers.delete(socket.id);

    if (socket.id === broadcasterId) {
      broadcasterId = null;
      // Todos os espectadores devem limpar o vídeo remoto
      socket.broadcast.emit("broadcasterLeft");
      console.log("broadcaster left");
      return;
    }

    // Espectador saiu — só o transmissor precisa fechar aquele peer
    if (broadcasterId) {
      io.to(broadcasterId).emit("disconnectPeer", socket.id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Video P2P em http://localhost:${PORT}`);
});
