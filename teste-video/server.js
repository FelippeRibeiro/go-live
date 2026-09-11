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

io.on("connection", (socket) => {
  console.log(`+ ${socket.id}`);

  socket.on("broadcaster", () => {
    broadcasterId = socket.id;
    socket.broadcast.emit("broadcaster");
    console.log(`broadcaster = ${socket.id}`);
  });

  socket.on("watcher", () => {
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
    socket.broadcast.emit("disconnectPeer", socket.id);
    if (socket.id === broadcasterId) {
      broadcasterId = null;
      console.log("broadcaster left");
    }
  });
});

server.listen(PORT, () => {
  console.log(`Video P2P em http://localhost:${PORT}`);
});
