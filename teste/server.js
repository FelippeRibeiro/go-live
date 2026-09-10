const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // chunks de áudio PCM — um pouco maior que o default ajuda
  maxHttpBufferSize: 1e6,
});

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  const peers = [...io.sockets.sockets.keys()].filter((id) => id !== socket.id);
  socket.emit("peers", peers);
  socket.broadcast.emit("peer-joined", { id: socket.id });

  console.log(`+ ${socket.id} (${io.engine.clientsCount} online)`);

  // Relays PCM bruto para todos os outros (sem processar no servidor)
  socket.on("audio", (payload) => {
    // payload: { sampleRate, channels, pcm: ArrayBuffer }
    socket.broadcast.emit("audio", {
      id: socket.id,
      sampleRate: payload.sampleRate,
      channels: payload.channels,
      pcm: payload.pcm,
    });
  });

  socket.on("disconnect", () => {
    socket.broadcast.emit("peer-left", { id: socket.id });
    console.log(`- ${socket.id} (${io.engine.clientsCount} online)`);
  });
});

server.listen(PORT, () => {
  console.log(`Mic share em http://localhost:${PORT}`);
});
