/**
 * MangoBlox Video Server  v2.0.0
 * Signaling + chat relay for MangoBlox WebRTC
 */
'use strict';

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const crypto     = require('crypto');

const PORT            = parseInt(process.env.PORT)         || 3000;
const API_KEY_SECRET  = process.env.API_KEY_SECRET         || 'mangokey_change_me';
const TURN_ENABLED    = process.env.TURN_ENABLED === 'true';
const TURN_URLS       = process.env.TURN_URLS              || 'turn:openrelay.metered.ca:80';
const TURN_USERNAME   = process.env.TURN_USERNAME          || 'openrelayproject';
const TURN_PASSWORD   = process.env.TURN_PASSWORD          || 'openrelayproject';
const WEBHOOK_ENABLED = process.env.WEBHOOK_ENABLED === 'true';
const WEBHOOK_URL     = process.env.WEBHOOK_URL            || '';
const MAX_PER_ROOM    = parseInt(process.env.MAX_PER_ROOM) || 50;
const MAX_MSG_LEN     = 4096;
const MAX_CHAT_HIST   = 200;
const MAX_FILE_B64    = 20 * 1024 * 1024;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors:              { origin: '*', methods: ['GET', 'POST'] },
    pingInterval:      25000,
    pingTimeout:       15000,
    maxHttpBufferSize: MAX_FILE_B64 + 131072,
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname)));

const rooms      = new Map();
const socketMeta = new Map();

function makeRoom(id, name, password) {
    return { id, name: name || ('Room ' + id), hostId: null, locked: false, password: password || null,
             peers: new Map(), chatHistory: [], whiteboardHistory: [], videoShare: null, duration: null, createdAt: Date.now() };
}
function makePeer(socketId, peerId, name, avatar, isHost) {
    return { socketId, peerId, name: (name || 'Guest').slice(0,60), avatar: avatar || null,
             hasVideo: false, hasAudio: false, isSharing: false, isHidden: false,
             handRaised: false, isHost, isRecording: false, joinedAt: Date.now() };
}
function peerPublic(p) {
    return { socketId: p.socketId, peerId: p.peerId, name: p.name, avatar: p.avatar,
             hasVideo: p.hasVideo, hasAudio: p.hasAudio, isSharing: p.isSharing,
             isHidden: p.isHidden, handRaised: p.handRaised, isHost: p.isHost,
             isRecording: p.isRecording, joinedAt: p.joinedAt };
}
function roomPublic(room) {
    return { id: room.id, name: room.name, hostId: room.hostId, locked: room.locked,
             hasPassword: !!room.password, peerCount: room.peers.size,
             peers: Array.from(room.peers.values()).map(peerPublic),
             chatHistory: room.chatHistory, videoShare: room.videoShare,
             duration: room.duration, createdAt: room.createdAt };
}
function getRoom(id)               { return rooms.get(id); }
function getPeer(roomId, socketId) { const r = getRoom(roomId); return r ? r.peers.get(socketId) : null; }
function broadcast(roomId, ev, data, excludeId) {
    const room = getRoom(roomId); if (!room) return;
    room.peers.forEach(function(p) { if (p.socketId !== excludeId) io.to(p.socketId).emit(ev, data); });
}
function broadcastAll(roomId, ev, data) { io.to(roomId).emit(ev, data); }
function reassignHost(room) {
    if (room.peers.size === 0) return;
    let earliest = Infinity, newId = null;
    room.peers.forEach(function(p) { if (p.joinedAt < earliest) { earliest = p.joinedAt; newId = p.socketId; } });
    if (!newId) return;
    room.hostId = newId;
    room.peers.forEach(function(p) { p.isHost = (p.socketId === newId); });
    const np = room.peers.get(newId);
    broadcastAll(room.id, 'host-changed', { newHostId: newId, peerId: np ? np.peerId : null });
    io.to(newId).emit('you-are-host', {});
}
function cleanRoom(roomId) {
    const room = getRoom(roomId);
    if (room && room.peers.size === 0) { rooms.delete(roomId); console.log(`[room] ${roomId} removed`); }
}
function handleLeave(socketId) {
    const meta = socketMeta.get(socketId); if (!meta) return;
    const { roomId } = meta;
    const room = getRoom(roomId);
    socketMeta.delete(socketId);
    if (!room) return;
    const peer = room.peers.get(socketId);
    room.peers.delete(socketId);
    const sock = io.sockets.sockets.get(socketId);
    if (sock) sock.leave(roomId);
    if (peer) {
        console.log(`[leave] "${peer.name}" left ${roomId} (${room.peers.size} remain)`);
        broadcast(roomId, 'peer-left', { socketId, peerId: peer.peerId, name: peer.name });
        fireWebhook('leave', { roomId, roomName: room.name, peer: peerPublic(peer) });
    }
    if (room.hostId === socketId && room.peers.size > 0) reassignHost(room);
    cleanRoom(roomId);
}
async function fireWebhook(event, payload) {
    if (!WEBHOOK_ENABLED || !WEBHOOK_URL) return;
    try {
        const fetch = (await import('node-fetch')).default;
        fetch(WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event, ts: Date.now(), ...payload }) })
            .catch(function(e) { console.error('[webhook]', e.message); });
    } catch(e) {}
}
function apiAuth(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.apiKey;
    if (!key || key !== API_KEY_SECRET) return res.status(401).json({ error: 'Invalid API key' });
    next();
}

app.get('/health', function(_, res) {
    res.json({ ok: true, rooms: rooms.size,
        peers: Array.from(rooms.values()).reduce(function(n,r) { return n + r.peers.size; }, 0),
        uptime: Math.round(process.uptime()), version: '2.0.0' });
});
app.get('/api/rooms', apiAuth, function(_, res) {
    const list = []; rooms.forEach(function(r) { list.push({ id: r.id, name: r.name, peerCount: r.peers.size, locked: r.locked, hasPassword: !!r.password, createdAt: r.createdAt }); });
    res.json({ rooms: list, total: list.length });
});
app.get('/api/rooms/:id', apiAuth, function(req, res) {
    const room = getRoom(req.params.id); if (!room) return res.status(404).json({ error: 'Not found' });
    res.json(roomPublic(room));
});
app.post('/api/rooms', apiAuth, function(req, res) {
    const { name, password } = req.body || {};
    const id = uuidv4().split('-')[0].toUpperCase();
    rooms.set(id, makeRoom(id, name, password));
    res.status(201).json({ roomId: id, name: rooms.get(id).name });
});
app.delete('/api/rooms/:id', apiAuth, function(req, res) {
    const room = getRoom(req.params.id); if (!room) return res.status(404).json({ error: 'Not found' });
    broadcastAll(req.params.id, 'meeting-ended', { reason: 'Room closed via API' });
    room.peers.forEach(function(p) { socketMeta.delete(p.socketId); });
    rooms.delete(req.params.id); res.json({ ok: true });
});
app.get('/api/turn', apiAuth, function(_, res) {
    if (!TURN_ENABLED) return res.json({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const exp = Math.floor(Date.now()/1000) + 3600;
    const username = exp + ':mangouser';
    const pw = crypto.createHmac('sha1', TURN_PASSWORD).update(username).digest('base64');
    res.json({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: TURN_URLS, username: TURN_USERNAME || username, credential: TURN_PASSWORD || pw }] });
});
app.get('/api/stats', apiAuth, function(_, res) {
    const s = []; rooms.forEach(function(r) { s.push({ id: r.id, name: r.name, peers: r.peers.size, locked: r.locked, createdAt: r.createdAt }); });
    res.json({ rooms: s, totalRooms: rooms.size });
});
app.get('/join', function(req, res) {
    const { room, name } = req.query; if (!room) return res.redirect('/');
    const p = new URLSearchParams({ room, name: name || 'Guest' }); res.redirect(`/#join?${p.toString()}`);
});

io.on('connection', function(socket) {
    console.log(`[connect] ${socket.id}`);

    socket.on('join-room', function(data) {
        if (!data) return socket.emit('join-err', { reason: 'Missing payload' });
        const { roomId, roomName, name, avatar, password, peerId: existingPeerId } = data;
        if (!roomId) return socket.emit('join-err', { reason: 'roomId required' });
        if (!name)   return socket.emit('join-err', { reason: 'name required' });

        if (!rooms.has(roomId)) { rooms.set(roomId, makeRoom(roomId, roomName || null, null)); console.log(`[room] ${roomId} created`); }
        const room = getRoom(roomId);

        if (room.locked && room.hostId !== socket.id) return socket.emit('join-err', { reason: 'Room is locked' });
        if (room.password && room.password !== password) return socket.emit('join-err', { reason: 'Wrong password' });
        if (room.peers.size >= MAX_PER_ROOM) return socket.emit('join-err', { reason: `Room full (max ${MAX_PER_ROOM})` });

        if (socketMeta.has(socket.id)) handleLeave(socket.id);

        const isHost = room.peers.size === 0 || room.hostId === null;
        const peerId = existingPeerId || uuidv4();
        const peer   = makePeer(socket.id, peerId, name, avatar || null, isHost);
        room.peers.set(socket.id, peer);
        if (isHost) room.hostId = socket.id;
        socket.join(roomId);
        socketMeta.set(socket.id, { roomId, peerId });

        console.log(`[join] "${peer.name}" → ${roomId}${isHost?' [HOST]':''} (${room.peers.size} total)`);
        socket.emit('join-ack', { peer: peerPublic(peer), room: roomPublic(room), isHost });
        broadcast(roomId, 'peer-joined', { peer: peerPublic(peer) }, socket.id);
        fireWebhook('join', { roomId, roomName: room.name, peer: peerPublic(peer) });
    });

    socket.on('leave-room',    function()  { handleLeave(socket.id); });
    socket.on('offer',         function(d) { if (d&&d.to) io.to(d.to).emit('offer',         { from: socket.id, sdp: d.sdp }); });
    socket.on('answer',        function(d) { if (d&&d.to) io.to(d.to).emit('answer',        { from: socket.id, sdp: d.sdp }); });
    socket.on('ice-candidate', function(d) { if (d&&d.to) io.to(d.to).emit('ice-candidate', { from: socket.id, candidate: d.candidate }); });
    socket.on('renegotiate',   function(d) { if (d&&d.to) io.to(d.to).emit('renegotiate',   { from: socket.id, sdp: d.sdp }); });

    socket.on('update-peer-info', function(d) {
        const meta = socketMeta.get(socket.id); if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer || !d) return;
        const changes = {};
        if (typeof d.video  ==='boolean') { peer.hasVideo   = d.video;  changes.hasVideo   = d.video;  }
        if (typeof d.audio  ==='boolean') { peer.hasAudio   = d.audio;  changes.hasAudio   = d.audio;  }
        if (typeof d.screen ==='boolean') { peer.isSharing  = d.screen; changes.isSharing  = d.screen; }
        if (typeof d.hidden ==='boolean') { peer.isHidden   = d.hidden; changes.isHidden   = d.hidden; }
        if (typeof d.hand   ==='boolean') { peer.handRaised = d.hand;   changes.handRaised = d.hand;   }
        if (typeof d.name   ==='string')  { peer.name = d.name.slice(0,60); changes.name = peer.name;  }
        if (typeof d.avatar ==='string')  { peer.avatar = d.avatar;    changes.avatar     = d.avatar;  }
        if (Object.keys(changes).length) broadcast(meta.roomId, 'peer-info-updated', { socketId: socket.id, peerId: peer.peerId, ...changes }, socket.id);
    });

    socket.on('screen-share-start', function() {
        const meta = socketMeta.get(socket.id); if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        peer.isSharing = true;
        broadcast(meta.roomId, 'peer-screen-share-start', { socketId: socket.id, peerId: peer.peerId, name: peer.name }, socket.id);
    });
    socket.on('screen-share-stop', function() {
        const meta = socketMeta.get(socket.id); if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        peer.isSharing = false;
        broadcast(meta.roomId, 'peer-screen-share-stop', { socketId: socket.id, peerId: peer.peerId }, socket.id);
    });

    socket.on('chat-message', function(d) {
        if (!d) return;
        const meta = socketMeta.get(socket.id); if (!meta) return;
        const room = getRoom(meta.roomId); if (!room) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        if (d.fileData && d.fileData.length > MAX_FILE_B64 * 1.37) return socket.emit('error', { reason: 'File too large' });
        const isPrivate = !!(d.to);
        const msg = { id: uuidv4(), from: socket.id, fromName: peer.name, to: d.to || null,
                      text: (d.text || '').slice(0, MAX_MSG_LEN), type: d.type || 'text',
                      fileData: d.fileData || null, fileName: d.fileName || null,
                      fileType: d.fileType || null, fileSize: d.fileSize || null,
                      replyTo: d.replyTo || null, replyToName: d.replyToName || null,
                      replyToText: d.replyToText || null, private: isPrivate, ts: Date.now() };
        if (isPrivate) {
            if (!room.peers.has(d.to)) return socket.emit('error', { reason: 'Recipient not found' });
            io.to(d.to).emit('chat-message', msg); socket.emit('chat-message', msg);
        } else {
            room.chatHistory.push(msg);
            if (room.chatHistory.length > MAX_CHAT_HIST) room.chatHistory.shift();
            broadcastAll(meta.roomId, 'chat-message', msg);
        }
    });

    socket.on('file-share', function(d) {
        if (!d) return;
        const meta = socketMeta.get(socket.id); if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        if (d.fileData && d.fileData.length > MAX_FILE_B64 * 1.37) return socket.emit('error', { reason: 'File too large' });
        const pkg = { id: uuidv4(), from: socket.id, fromName: peer.name, to: d.to || null,
                      fileName: d.fileName || 'file', fileType: d.fileType || 'application/octet-stream',
                      fileSize: d.fileSize || 0, fileData: d.fileData || null, private: !!(d.to), ts: Date.now() };
        if (d.to) { io.to(d.to).emit('file-share', pkg); socket.emit('file-share', pkg); }
        else broadcastAll(meta.roomId, 'file-share', pkg);
    });

    socket.on('whiteboard-action', function(d) {
        const meta = socketMeta.get(socket.id); if (!meta || !d) return;
        const room = getRoom(meta.roomId); if (!room) return;
        room.whiteboardHistory.push({ from: socket.id, action: d.action, ts: Date.now() });
        if (room.whiteboardHistory.length > 500) room.whiteboardHistory.shift();
        broadcast(meta.roomId, 'whiteboard-action', { from: socket.id, action: d.action }, socket.id);
    });
    socket.on('whiteboard-clear', function() {
        const meta = socketMeta.get(socket.id); if (!meta) return;
        const room = getRoom(meta.roomId); if (!room) return;
        room.whiteboardHistory = [];
        broadcast(meta.roomId, 'whiteboard-clear', { from: socket.id }, socket.id);
    });

    socket.on('reaction', function(d) {
        const meta = socketMeta.get(socket.id); if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        const emoji = (d && d.emoji) ? String(d.emoji).slice(0,8) : '👋';
        broadcastAll(meta.roomId, 'peer-reaction', { socketId: socket.id, peerId: peer.peerId, name: peer.name, emoji });
    });
    socket.on('hand-raise', function() {
        const meta = socketMeta.get(socket.id); if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        peer.handRaised = true;
        broadcastAll(meta.roomId, 'peer-hand-raise', { socketId: socket.id, peerId: peer.peerId, name: peer.name });
    });
    socket.on('hand-lower', function() {
        const meta = socketMeta.get(socket.id); if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        peer.handRaised = false;
        broadcastAll(meta.roomId, 'peer-hand-lower', { socketId: socket.id, peerId: peer.peerId });
    });

    socket.on('video-share', function(d) {
        const meta = socketMeta.get(socket.id); if (!meta || !d || !d.url) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        const room = getRoom(meta.roomId); if (!room) return;
        room.videoShare = { url: d.url, type: d.type || 'youtube', from: socket.id };
        broadcast(meta.roomId, 'video-share', { from: socket.id, fromName: peer.name, url: d.url, type: d.type || 'youtube' }, socket.id);
    });
    socket.on('video-share-stop', function() {
        const meta = socketMeta.get(socket.id); if (!meta) return;
        const room = getRoom(meta.roomId); if (!room) return;
        room.videoShare = null;
        broadcast(meta.roomId, 'video-share-stop', { from: socket.id }, socket.id);
    });

    socket.on('caption', function(d) {
        const meta = socketMeta.get(socket.id); if (!meta || !d) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        broadcast(meta.roomId, 'caption', { from: socket.id, fromName: peer.name, text: (d.text||'').slice(0,500), final: !!d.final }, socket.id);
    });

    socket.on('recording-start', function() {
        const meta = socketMeta.get(socket.id); if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        peer.isRecording = true;
        broadcast(meta.roomId, 'peer-recording-start', { socketId: socket.id, name: peer.name }, socket.id);
    });
    socket.on('recording-stop', function() {
        const meta = socketMeta.get(socket.id); if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        peer.isRecording = false;
        broadcast(meta.roomId, 'peer-recording-stop', { socketId: socket.id }, socket.id);
    });

    socket.on('snapshot', function(d) {
        const meta = socketMeta.get(socket.id); if (!meta || !d) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        broadcast(meta.roomId, 'snapshot', { from: socket.id, fromName: peer.name, dataURL: d.dataURL || null }, socket.id);
    });
    socket.on('meeting-duration', function(d) {
        const meta = socketMeta.get(socket.id); if (!meta) return;
        const room = getRoom(meta.roomId); if (!room || room.hostId !== socket.id) return;
        room.duration = (d && d.seconds) || null;
        broadcast(meta.roomId, 'meeting-duration', { seconds: room.duration, from: socket.id }, socket.id);
    });
    socket.on('pip-start', function() { const meta = socketMeta.get(socket.id); if (meta) broadcast(meta.roomId, 'pip-start', { socketId: socket.id }, socket.id); });
    socket.on('pip-stop',  function() { const meta = socketMeta.get(socket.id); if (meta) broadcast(meta.roomId, 'pip-stop',  { socketId: socket.id }, socket.id); });

    function withHost(fn) {
        const meta = socketMeta.get(socket.id); if (!meta) return;
        const room = getRoom(meta.roomId); if (!room || room.hostId !== socket.id) return;
        fn(room, meta.roomId);
    }
    socket.on('kick-peer', function(d) { withHost(function(room, roomId) {
        const t = d && d.socketId; if (!t || t === socket.id || !room.peers.has(t)) return;
        io.to(t).emit('kicked', { reason: 'Removed by host' }); handleLeave(t);
    }); });
    socket.on('mute-peer',   function(d) { withHost(function(room) { const t = d&&d.socketId; if (t && room.peers.has(t)) io.to(t).emit('force-mute', {}); }); });
    socket.on('hide-peer',   function(d) { withHost(function(room) { const t = d&&d.socketId; if (t && room.peers.has(t)) io.to(t).emit('force-hide', {}); }); });
    socket.on('request-snapshot', function(d) { withHost(function(room) { const t = d&&d.socketId; if (t && room.peers.has(t)) io.to(t).emit('snapshot-request', { fromSocketId: socket.id }); }); });
    socket.on('lock-room', function() { withHost(function(room, roomId) { room.locked = !room.locked; broadcastAll(roomId, 'room-lock-changed', { locked: room.locked }); }); });
    socket.on('end-meeting', function() { withHost(function(room, roomId) {
        broadcastAll(roomId, 'meeting-ended', { reason: 'Host ended the meeting' });
        fireWebhook('room-end', { roomId, roomName: room.name });
        room.peers.forEach(function(p) { socketMeta.delete(p.socketId); const s = io.sockets.sockets.get(p.socketId); if (s) s.leave(roomId); });
        rooms.delete(roomId);
    }); });

    socket.on('update-name', function(d) {
        const meta = socketMeta.get(socket.id); if (!meta || !d) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        const name = (d.name || '').trim().slice(0,60); if (!name) return;
        peer.name = name;
        broadcastAll(meta.roomId, 'peer-info-updated', { socketId: socket.id, peerId: peer.peerId, name });
    });
    socket.on('update-avatar', function(d) {
        const meta = socketMeta.get(socket.id); if (!meta || !d) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        peer.avatar = d.avatar || null;
        broadcastAll(meta.roomId, 'peer-info-updated', { socketId: socket.id, peerId: peer.peerId, avatar: peer.avatar });
    });

    socket.on('ping', function() { socket.emit('pong', { ts: Date.now() }); });
    socket.on('disconnect', function(reason) { console.log(`[disconnect] ${socket.id} — ${reason}`); handleLeave(socket.id); });
    socket.on('error', function(err) { console.error(`[socket-err] ${socket.id}:`, err.message); });
});

setInterval(function() {
    const cutoff = Date.now() - 3600000;
    rooms.forEach(function(room, id) { if (room.peers.size === 0 && room.createdAt < cutoff) { rooms.delete(id); console.log(`[cleanup] ${id} removed`); } });
}, 300000);

server.listen(PORT, function() {
    console.log(`\n  MangoBlox Server v2.0.0  →  http://localhost:${PORT}\n`);
    if (WEBHOOK_ENABLED) console.log('  Webhook → ' + WEBHOOK_URL);
    if (TURN_ENABLED)    console.log('  TURN    → ' + TURN_URLS);
});

module.exports = { app, server, io };
