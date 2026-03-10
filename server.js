const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 10e6   // allows file/image transfers up to 10 MB
});

// ─────────────────────────────────────────────
//  Video call room registry
//  vcRooms[socketId] = { name }
// ─────────────────────────────────────────────
const vcRooms = {};
function vcCount() { return Object.keys(vcRooms).length; }

// ─────────────────────────────────────────────
//  Connections
// ─────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── Send current online count to everyone ──
  io.emit('online_count', io.engine.clientsCount);
  // Also broadcast current vc count so new joiners see it immediately
  socket.emit('vc_count', vcCount());

  // ── Chat ───────────────────────────────────
  socket.on('message', (msg) => {
    socket.broadcast.emit('message', msg);
  });

  socket.on('ping_online', () => {
    io.emit('online_count', io.engine.clientsCount);
  });

  // ── Video call — join ──────────────────────
  // New peer joins the call:
  //   1. Tell them who is already in (vc_call_list)
  //   2. Tell everyone else they joined (vc_join)
  //   3. Broadcast updated count to all (vc_count)
  socket.on('vc_join', ({ name }) => {
    const peers = Object.entries(vcRooms).map(([id, d]) => ({
      socketId: id,
      name: d.name
    }));

    // Send existing peer list to the new joiner
    socket.emit('vc_call_list', {
      peers,
      count: vcCount()
    });

    // Tell everyone else a new person joined
    socket.broadcast.emit('vc_join', {
      socketId: socket.id,
      name,
      count: vcCount() + 1   // +1 because we haven't added them yet
    });

    // Register this peer
    vcRooms[socket.id] = { name };

    // Broadcast updated count to all clients
    io.emit('vc_count', vcCount());
  });

  // ── Video call — leave ─────────────────────
  socket.on('vc_leave', () => {
    if (!vcRooms[socket.id]) return;
    delete vcRooms[socket.id];

    socket.broadcast.emit('vc_leave', {
      socketId: socket.id,
      count: vcCount()
    });

    io.emit('vc_count', vcCount());
  });

  // ── WebRTC signaling relay ─────────────────
  // The server never inspects these — just routes them to the right peer

  socket.on('vc_offer', (d) => {
    socket.to(d.target).emit('vc_offer', {
      ...d,
      from:     socket.id,
      fromName: vcRooms[socket.id]?.name || 'Guest'
    });
  });

  socket.on('vc_answer', (d) => {
    socket.to(d.target).emit('vc_answer', {
      ...d,
      from: socket.id
    });
  });

  socket.on('vc_ice', (d) => {
    socket.to(d.target).emit('vc_ice', {
      ...d,
      from: socket.id
    });
  });

  // ── Disconnect ─────────────────────────────
  socket.on('disconnect', () => {
    // If they were in a video call, notify others and clean up
    if (vcRooms[socket.id]) {
      delete vcRooms[socket.id];
      socket.broadcast.emit('vc_leave', {
        socketId: socket.id,
        count: vcCount()
      });
      io.emit('vc_count', vcCount());
    }

    // Update online count for chat
    io.emit('online_count', io.engine.clientsCount);
  });

});

// ─────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`MangoBlox server running on port ${PORT}`);
});