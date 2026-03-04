const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

let onlineCount = 0;

io.on('connection', (socket) => {
  onlineCount++;
  io.emit('online_count', onlineCount);
  console.log('User connected. Online:', onlineCount);

  socket.on('message', (msg) => {
    socket.broadcast.emit('message', msg); // send to everyone except sender
  });

  socket.on('ping_online', () => {
    io.emit('online_count', io.engine.clientsCount);
  });

  socket.on('disconnect', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    io.emit('online_count', onlineCount);
    console.log('User left. Online:', onlineCount);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('MangoBlox chat server running on port', PORT));