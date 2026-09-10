const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3001;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 2e6,
});

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  const peers = [...io.sockets.sockets.keys()].filter((id) => id !== socket.id);
  socket.emit("peers", peers);
  socket.broadcast.emit("peer-joined", { id: socket.id });
  console.log(`+ ${socket.id} (${io.engine.clientsCount} online)`);

  // Relays frames JPEG para os outros
  socket.on("frame", (payload) => {
    socket.broadcast.emit("frame", {
      id: socket.id,
      jpeg: payload.jpeg,
    });
  });

  socket.on("disconnect", () => {
    socket.broadcast.emit("peer-left", { id: socket.id });
    console.log(`- ${socket.id} (${io.engine.clientsCount} online)`);
  });
});

server.listen(PORT, () => {
  console.log(`Screen share em http://localhost:${PORT}`);
});
