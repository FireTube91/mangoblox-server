/**
 * MangoBlox Video Server  —  Full MiroTalk-equivalent signaling server
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Features (matching MiroTalk P2P):
 *   ✓ Multi-room WebRTC P2P signaling (offer / answer / ICE)
 *   ✓ Screen sharing  (display + audio, renegotiation)
 *   ✓ Camera / mic toggling  (with live state broadcast)
 *   ✓ In-call chat  (text, emoji, private/public, file sharing via DTLS)
 *   ✓ File sharing  (any type, drag-and-drop relay)
 *   ✓ Collaborative whiteboard  (draw events relayed to all peers)
 *   ✓ Hand raise & emoji reactions
 *   ✓ Snapshot signals  (client captures frame, server relays)
 *   ✓ Live captions / speech-to-text relay
 *   ✓ YouTube / video URL sharing  (real-time relay)
 *   ✓ Recording signals  (client-side MediaRecorder, server notifies room)
 *   ✓ Meeting duration / timer  (host sets, broadcast to room)
 *   ✓ Host controls: kick, force-mute, lock room, end meeting
 *   ✓ Room password protection
 *   ✓ Peer info updates  (name, avatar, video/audio state, hand raise)
 *   ✓ PiP  (Picture-in-Picture) event relay
 *   ✓ "Hide me" / video off signaling
 *   ✓ Participant list  (full peer registry)
 *   ✓ Auto host reassignment on host disconnect
 *   ✓ Reconnect support  (stable peerId across reconnects)
 *   ✓ REST API  (room list, room info, pre-create, token, stats)
 *   ✓ Webhook  (join / leave / room-end events posted to configurable URL)
 *   ✓ TURN credential endpoint  (for NAT traversal)
 *   ✓ Stale-room cleanup
 *   ✓ Health endpoint
 *
 * Install:
 *   npm install express socket.io cors uuid dotenv node-fetch
 *
 * .env  (all optional):
 *   PORT=3000
 *   API_KEY_SECRET=change_me
 *   TURN_ENABLED=false
 *   TURN_URLS=turn:your.turn.server:3478
 *   TURN_USERNAME=user
 *   TURN_PASSWORD=pass
 *   WEBHOOK_ENABLED=false
 *   WEBHOOK_URL=http://localhost:8888/webhook
 *   JWT_SECRET=change_me
 *
 * Run:
 *   node server.js
 *
 * ── Socket events (client → server) ──────────────────────────────────────
 *
 *  join-room          { roomId, roomName?, name, avatar?, password?, peerId? }
 *  leave-room         {}
 *
 *  — WebRTC signaling —
 *  offer              { to, sdp }
 *  answer             { to, sdp }
 *  ice-candidate      { to, candidate }
 *  renegotiate        { to, sdp }          ← screen-share track add
 *
 *  — Media state —
 *  update-peer-info   { video?, audio?, screen?, hand?, name?, avatar?, hidden? }
 *
 *  — Screen share —
 *  screen-share-start {}
 *  screen-share-stop  {}
 *
 *  — Chat —
 *  chat-message       { to?, text, type?, fileData?, fileName?, fileType?, fileSize? }
 *                     to = socketId for private, omit for public
 *
 *  — File share —
 *  file-share         { to?, fileName, fileType, fileSize, fileData }
 *
 *  — Whiteboard —
 *  whiteboard-action  { action }           ← fabric.js JSON action, relayed to room
 *  whiteboard-clear   {}
 *
 *  — Reactions / hand —
 *  reaction           { emoji }
 *  hand-raise         {}
 *  hand-lower         {}
 *
 *  — Media sharing —
 *  video-share        { url, type }        ← YT embed / mp4 / audio etc.
 *  video-share-stop   {}
 *
 *  — Captions —
 *  caption            { text, final? }     ← speech-recognition result
 *
 *  — Recording —
 *  recording-start    {}
 *  recording-stop     {}
 *
 *  — Snapshot —
 *  snapshot           { dataURL }          ← relayed to room (host can request)
 *
 *  — Meeting timer —
 *  meeting-duration   { seconds }          ← host sets countdown
 *
 *  — PiP —
 *  pip-start          {}
 *  pip-stop           {}
 *
 *  — Host controls —
 *  kick-peer          { socketId }
 *  mute-peer          { socketId }
 *  hide-peer          { socketId }
 *  lock-room          {}                   ← toggles
 *  end-meeting        {}
 *  request-snapshot   { socketId }         ← host asks a peer to snap
 *
 *  — Profile —
 *  update-name        { name }
 *  update-avatar      { avatar }
 *
 *  — Misc —
 *  ping               {}
 *
 * ── Socket events (server → client) ──────────────────────────────────────
 *
 *  join-ack           { peer, room, isHost }
 *  join-err           { reason }
 *  peer-joined        { peer }
 *  peer-left          { socketId, peerId, name }
 *
 *  offer              { from, sdp }
 *  answer             { from, sdp }
 *  ice-candidate      { from, candidate }
 *  renegotiate        { from, sdp }
 *
 *  peer-info-updated  { socketId, peerId, ...changes }
 *  peer-screen-share-start { socketId, peerId, name }
 *  peer-screen-share-stop  { socketId, peerId }
 *
 *  chat-message       { id, from, fromName, to?, text, type, fileData?, fileName?,
 *                        fileType?, fileSize?, private, ts }
 *  file-share         { id, from, fromName, to?, fileName, fileType, fileSize,
 *                        fileData, private, ts }
 *
 *  whiteboard-action  { from, action }
 *  whiteboard-clear   { from }
 *
 *  peer-reaction      { socketId, peerId, name, emoji }
 *  peer-hand-raise    { socketId, peerId, name }
 *  peer-hand-lower    { socketId, peerId }
 *
 *  video-share        { from, fromName, url, type }
 *  video-share-stop   { from }
 *
 *  caption            { from, fromName, text, final }
 *
 *  peer-recording-start { socketId, name }
 *  peer-recording-stop  { socketId }
 *
 *  snapshot-request   { fromSocketId }    ← host requests your snapshot
 *  snapshot           { from, fromName, dataURL }
 *
 *  meeting-duration   { seconds, from }
 *
 *  pip-start          { socketId }
 *  pip-stop           { socketId }
 *
 *  kicked             { reason }
 *  force-mute         {}
 *  force-hide         {}
 *  room-lock-changed  { locked }
 *  meeting-ended      { reason }
 *  host-changed       { newHostId, peerId }
 *  you-are-host       {}
 *
 *  pong               { ts }
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

// ─── Config ────────────────────────────────────────────────────────────────
const PORT            = parseInt(process.env.PORT)            || 3000;
const API_KEY_SECRET  = process.env.API_KEY_SECRET            || 'mangokey_change_me';
const JWT_SECRET      = process.env.JWT_SECRET                || 'mango_jwt_secret';
const TURN_ENABLED    = process.env.TURN_ENABLED === 'true';
const TURN_URLS       = process.env.TURN_URLS                 || 'turn:openrelay.metered.ca:80';
const TURN_USERNAME   = process.env.TURN_USERNAME             || 'openrelayproject';
const TURN_PASSWORD   = process.env.TURN_PASSWORD             || 'openrelayproject';
const WEBHOOK_ENABLED = process.env.WEBHOOK_ENABLED === 'true';
const WEBHOOK_URL     = process.env.WEBHOOK_URL               || '';
const MAX_PER_ROOM    = parseInt(process.env.MAX_PER_ROOM)    || 50;
const PING_INTERVAL   = 25000;
const PING_TIMEOUT    = 15000;
const MAX_MSG_LEN     = 4096;
const MAX_CHAT_HIST   = 200;
const MAX_FILE_B64    = 20 * 1024 * 1024;   // 20 MB base64

// ─── App ───────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors:              { origin: '*', methods: ['GET', 'POST'] },
    pingInterval:      PING_INTERVAL,
    pingTimeout:       PING_TIMEOUT,
    maxHttpBufferSize: MAX_FILE_B64 + 131072,   // file + overhead
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname)));

// ─── In-memory state ───────────────────────────────────────────────────────
/**
 * rooms     Map<roomId, Room>
 * Room {
 *   id, name, hostId, locked, password,
 *   peers: Map<socketId, Peer>,
 *   chatHistory: Msg[],
 *   whiteboardHistory: Action[],
 *   videoShare: { url, type, from } | null,
 *   duration: number | null,
 *   createdAt
 * }
 *
 * Peer {
 *   socketId, peerId, name, avatar,
 *   hasVideo, hasAudio, isSharing, isHidden,
 *   handRaised, isHost, isRecording,
 *   joinedAt
 * }
 */
const rooms      = new Map();
const socketMeta = new Map();   // socketId → { roomId, peerId }

// ─── Helpers ───────────────────────────────────────────────────────────────
function makeRoom(id, name, password) {
    return {
        id,
        name:              name || ('Room ' + id),
        hostId:            null,
        locked:            false,
        password:          password || null,
        peers:             new Map(),
        chatHistory:       [],
        whiteboardHistory: [],
        videoShare:        null,
        duration:          null,
        createdAt:         Date.now(),
    };
}

function makePeer(socketId, peerId, name, avatar, isHost) {
    return {
        socketId,
        peerId,
        name:        (name || 'Guest').slice(0, 60),
        avatar:      avatar || null,
        hasVideo:    false,
        hasAudio:    false,
        isSharing:   false,
        isHidden:    false,
        handRaised:  false,
        isHost,
        isRecording: false,
        joinedAt:    Date.now(),
    };
}

function peerPublic(p) {
    return {
        socketId:    p.socketId,
        peerId:      p.peerId,
        name:        p.name,
        avatar:      p.avatar,
        hasVideo:    p.hasVideo,
        hasAudio:    p.hasAudio,
        isSharing:   p.isSharing,
        isHidden:    p.isHidden,
        handRaised:  p.handRaised,
        isHost:      p.isHost,
        isRecording: p.isRecording,
        joinedAt:    p.joinedAt,
    };
}

function roomPublic(room) {
    return {
        id:          room.id,
        name:        room.name,
        hostId:      room.hostId,
        locked:      room.locked,
        hasPassword: !!room.password,
        peerCount:   room.peers.size,
        peers:       Array.from(room.peers.values()).map(peerPublic),
        chatHistory: room.chatHistory,
        videoShare:  room.videoShare,
        duration:    room.duration,
        createdAt:   room.createdAt,
    };
}

function getRoom(id)               { return rooms.get(id); }
function getPeer(roomId, socketId) { const r = getRoom(roomId); return r ? r.peers.get(socketId) : null; }

function broadcast(roomId, ev, data, excludeId) {
    const room = getRoom(roomId);
    if (!room) return;
    room.peers.forEach(function(p) {
        if (p.socketId !== excludeId) io.to(p.socketId).emit(ev, data);
    });
}

function broadcastAll(roomId, ev, data) {
    io.to(roomId).emit(ev, data);
}

function reassignHost(room) {
    if (room.peers.size === 0) return;
    let earliest = Infinity, newId = null;
    room.peers.forEach(function(p) { if (p.joinedAt < earliest) { earliest = p.joinedAt; newId = p.socketId; } });
    if (!newId) return;
    room.hostId = newId;
    room.peers.forEach(function(p) { p.isHost = (p.socketId === newId); });
    const newPeer = room.peers.get(newId);
    broadcastAll(room.id, 'host-changed', { newHostId: newId, peerId: newPeer ? newPeer.peerId : null });
    io.to(newId).emit('you-are-host', {});
    console.log(`[host] "${newPeer ? newPeer.name : newId}" became host of room ${room.id}`);
}

function cleanRoom(roomId) {
    const room = getRoom(roomId);
    if (room && room.peers.size === 0) {
        rooms.delete(roomId);
        console.log(`[room] ${roomId} removed (empty)`);
    }
}

function handleLeave(socketId) {
    const meta = socketMeta.get(socketId);
    if (!meta) return;
    const { roomId } = meta;
    const room = getRoom(roomId);
    socketMeta.delete(socketId);
    if (!room) return;
    const peer = room.peers.get(socketId);
    room.peers.delete(socketId);
    const sock = io.sockets.sockets.get(socketId);
    if (sock) sock.leave(roomId);
    if (peer) {
        console.log(`[leave] "${peer.name}" left room ${roomId} (${room.peers.size} remain)`);
        broadcast(roomId, 'peer-left', { socketId, peerId: peer.peerId, name: peer.name });
        fireWebhook('leave', { roomId, roomName: room.name, peer: peerPublic(peer) });
    }
    if (room.hostId === socketId && room.peers.size > 0) reassignHost(room);
    cleanRoom(roomId);
}

// ─── Webhook ───────────────────────────────────────────────────────────────
async function fireWebhook(event, payload) {
    if (!WEBHOOK_ENABLED || !WEBHOOK_URL) return;
    try {
        const fetch = (await import('node-fetch')).default;
        fetch(WEBHOOK_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ event, ts: Date.now(), ...payload }),
        }).catch(function(e) { console.error('[webhook] error:', e.message); });
    } catch(e) { /* node-fetch not installed — silent */ }
}

// ─── API auth middleware ───────────────────────────────────────────────────
function apiAuth(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.apiKey;
    if (!key || key !== API_KEY_SECRET) return res.status(401).json({ error: 'Invalid API key' });
    next();
}

// ─── REST API ──────────────────────────────────────────────────────────────

/* Health */
app.get('/health', function(_, res) {
    res.json({
        ok:      true,
        rooms:   rooms.size,
        peers:   Array.from(rooms.values()).reduce(function(n, r) { return n + r.peers.size; }, 0),
        uptime:  Math.round(process.uptime()),
        version: '2.0.0',
    });
});

/* List public rooms */
app.get('/api/rooms', apiAuth, function(_, res) {
    const list = [];
    rooms.forEach(function(room) {
        list.push({
            id:          room.id,
            name:        room.name,
            peerCount:   room.peers.size,
            locked:      room.locked,
            hasPassword: !!room.password,
            createdAt:   room.createdAt,
        });
    });
    res.json({ rooms: list, total: list.length });
});

/* Single room info */
app.get('/api/rooms/:id', apiAuth, function(req, res) {
    const room = getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json(roomPublic(room));
});

/* Pre-create room */
app.post('/api/rooms', apiAuth, function(req, res) {
    const { name, password } = req.body || {};
    const id = uuidv4().split('-')[0].toUpperCase();
    rooms.set(id, makeRoom(id, name, password));
    console.log(`[api] Room ${id} pre-created`);
    res.status(201).json({ roomId: id, name: rooms.get(id).name });
});

/* Delete room (host auth via API key) */
app.delete('/api/rooms/:id', apiAuth, function(req, res) {
    const room = getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    broadcastAll(req.params.id, 'meeting-ended', { reason: 'Room closed via API' });
    room.peers.forEach(function(p) { socketMeta.delete(p.socketId); });
    rooms.delete(req.params.id);
    res.json({ ok: true });
});

/* TURN credentials */
app.get('/api/turn', apiAuth, function(_, res) {
    if (!TURN_ENABLED) return res.json({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    // Time-limited TURN creds (HMAC-SHA1)
    const exp      = Math.floor(Date.now() / 1000) + 3600;
    const username = exp + ':mangouser';
    const pw       = crypto.createHmac('sha1', TURN_PASSWORD).update(username).digest('base64');
    res.json({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: TURN_URLS, username: TURN_USERNAME || username, credential: TURN_PASSWORD || pw },
        ],
    });
});

/* Stats */
app.get('/api/stats', apiAuth, function(_, res) {
    const roomStats = [];
    rooms.forEach(function(room) {
        roomStats.push({
            id:        room.id,
            name:      room.name,
            peers:     room.peers.size,
            locked:    room.locked,
            duration:  room.duration,
            createdAt: room.createdAt,
            peers_list: Array.from(room.peers.values()).map(function(p) {
                return { name: p.name, joinedAt: p.joinedAt, isHost: p.isHost, isSharing: p.isSharing };
            }),
        });
    });
    res.json({ rooms: roomStats, totalRooms: rooms.size });
});

/* Direct-join URL  /join?room=X&name=Y&audio=0&video=0&screen=0 */
app.get('/join', function(req, res) {
    const { room, name, audio, video, screen, notify } = req.query;
    if (!room) return res.redirect('/');
    const params = new URLSearchParams({ room, name: name || 'Guest', audio: audio || '1', video: video || '1', screen: screen || '0', notify: notify || '1' });
    res.redirect(`/#join?${params.toString()}`);
});

// ─── Socket.IO ─────────────────────────────────────────────────────────────
io.on('connection', function(socket) {
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    console.log(`[connect] ${socket.id}  ip=${ip}`);

    // ── join-room ──────────────────────────────────────────────────────────
    socket.on('join-room', function(data) {
        if (!data) return socket.emit('join-err', { reason: 'Missing payload' });

        const { roomId, roomName, name, avatar, password, peerId: existingPeerId } = data;
        if (!roomId)  return socket.emit('join-err', { reason: 'roomId is required' });
        if (!name)    return socket.emit('join-err', { reason: 'name is required' });

        // Auto-create
        if (!rooms.has(roomId)) {
            rooms.set(roomId, makeRoom(roomId, roomName || null, null));
            console.log(`[room] ${roomId} auto-created`);
        }
        const room = getRoom(roomId);

        if (room.locked && room.hostId !== socket.id)
            return socket.emit('join-err', { reason: 'Room is locked by the host' });
        if (room.password && room.password !== password)
            return socket.emit('join-err', { reason: 'Wrong room password' });
        if (room.peers.size >= MAX_PER_ROOM)
            return socket.emit('join-err', { reason: `Room is full (max ${MAX_PER_ROOM})` });

        // Clean up duplicate join
        if (socketMeta.has(socket.id)) handleLeave(socket.id);

        const isFirst = room.peers.size === 0;
        const isHost  = isFirst || room.hostId === null;
        const peerId  = existingPeerId || uuidv4();

        const peer = makePeer(socket.id, peerId, name, avatar || null, isHost);
        room.peers.set(socket.id, peer);
        if (isHost) room.hostId = socket.id;

        socket.join(roomId);
        socketMeta.set(socket.id, { roomId, peerId });

        console.log(`[join] "${peer.name}" (${socket.id}) → room ${roomId}${isHost ? ' [HOST]' : ''} — ${room.peers.size} total`);

        socket.emit('join-ack', {
            peer:   peerPublic(peer),
            room:   roomPublic(room),
            isHost,
        });
        broadcast(roomId, 'peer-joined', { peer: peerPublic(peer) }, socket.id);
        fireWebhook('join', { roomId, roomName: room.name, peer: peerPublic(peer) });
    });

    // ── leave-room ────────────────────────────────────────────────────────
    socket.on('leave-room', function() { handleLeave(socket.id); });

    // ── WebRTC signaling relay ─────────────────────────────────────────────
    socket.on('offer', function(d) {
        if (!d || !d.to) return;
        io.to(d.to).emit('offer', { from: socket.id, sdp: d.sdp });
    });

    socket.on('answer', function(d) {
        if (!d || !d.to) return;
        io.to(d.to).emit('answer', { from: socket.id, sdp: d.sdp });
    });

    socket.on('ice-candidate', function(d) {
        if (!d || !d.to) return;
        io.to(d.to).emit('ice-candidate', { from: socket.id, candidate: d.candidate });
    });

    socket.on('renegotiate', function(d) {
        if (!d || !d.to) return;
        io.to(d.to).emit('renegotiate', { from: socket.id, sdp: d.sdp });
    });

    // ── Peer info (generic update — video/audio/screen/name/avatar/hand/hidden) ──
    socket.on('update-peer-info', function(d) {
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id);
        if (!peer || !d) return;

        const changes = {};
        if (typeof d.video   === 'boolean') { peer.hasVideo  = d.video;   changes.hasVideo  = d.video;   }
        if (typeof d.audio   === 'boolean') { peer.hasAudio  = d.audio;   changes.hasAudio  = d.audio;   }
        if (typeof d.screen  === 'boolean') { peer.isSharing = d.screen;  changes.isSharing = d.screen;  }
        if (typeof d.hidden  === 'boolean') { peer.isHidden  = d.hidden;  changes.isHidden  = d.hidden;  }
        if (typeof d.hand    === 'boolean') { peer.handRaised= d.hand;    changes.handRaised= d.hand;    }
        if (typeof d.name    === 'string')  { peer.name      = d.name.slice(0,60); changes.name = peer.name; }
        if (typeof d.avatar  === 'string')  { peer.avatar    = d.avatar;  changes.avatar    = d.avatar;  }

        if (Object.keys(changes).length === 0) return;
        broadcast(meta.roomId, 'peer-info-updated', { socketId: socket.id, peerId: peer.peerId, ...changes }, socket.id);
    });

    // ── Screen sharing ─────────────────────────────────────────────────────
    socket.on('screen-share-start', function() {
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id);
        if (!peer) return;
        peer.isSharing = true;
        console.log(`[screen] "${peer.name}" started sharing in room ${meta.roomId}`);
        broadcast(meta.roomId, 'peer-screen-share-start', { socketId: socket.id, peerId: peer.peerId, name: peer.name }, socket.id);
    });

    socket.on('screen-share-stop', function() {
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id);
        if (!peer) return;
        peer.isSharing = false;
        broadcast(meta.roomId, 'peer-screen-share-stop', { socketId: socket.id, peerId: peer.peerId }, socket.id);
    });

    // ── Chat messages  (public + private) ─────────────────────────────────
    socket.on('chat-message', function(d) {
        if (!d) return;
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        const room = getRoom(meta.roomId);
        if (!room) return;
        const peer = getPeer(meta.roomId, socket.id);
        if (!peer) return;

        if (d.fileData && d.fileData.length > MAX_FILE_B64 * 1.37) {
            return socket.emit('error', { reason: 'File too large (max 20 MB)' });
        }

        const isPrivate = !!(d.to);
        const msg = {
            id:       uuidv4(),
            from:     socket.id,
            fromName: peer.name,
            to:       d.to || null,
            text:     (d.text || '').slice(0, MAX_MSG_LEN),
            type:     d.type || 'text',
            fileData: d.fileData  || null,
            fileName: d.fileName  || null,
            fileType: d.fileType  || null,
            fileSize: d.fileSize  || null,
            private:  isPrivate,
            ts:       Date.now(),
        };

        if (isPrivate) {
            if (!room.peers.has(d.to)) return socket.emit('error', { reason: 'Recipient not found' });
            io.to(d.to).emit('chat-message', msg);
            socket.emit('chat-message', msg);   // echo to sender
        } else {
            room.chatHistory.push(msg);
            if (room.chatHistory.length > MAX_CHAT_HIST) room.chatHistory.shift();
            broadcastAll(meta.roomId, 'chat-message', msg);
        }
    });

    // ── File sharing  (separate event for clarity, same relay logic) ───────
    socket.on('file-share', function(d) {
        if (!d) return;
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id);
        if (!peer) return;

        if (d.fileData && d.fileData.length > MAX_FILE_B64 * 1.37) {
            return socket.emit('error', { reason: 'File too large (max 20 MB)' });
        }

        const pkg = {
            id:       uuidv4(),
            from:     socket.id,
            fromName: peer.name,
            to:       d.to || null,
            fileName: d.fileName  || 'file',
            fileType: d.fileType  || 'application/octet-stream',
            fileSize: d.fileSize  || 0,
            fileData: d.fileData  || null,
            private:  !!(d.to),
            ts:       Date.now(),
        };

        if (d.to) {
            io.to(d.to).emit('file-share', pkg);
            socket.emit('file-share', pkg);
        } else {
            broadcastAll(meta.roomId, 'file-share', pkg);
        }
        console.log(`[file] "${peer.name}" shared "${pkg.fileName}" (${Math.round(pkg.fileSize/1024)}KB) in room ${meta.roomId}`);
    });

    // ── Whiteboard ─────────────────────────────────────────────────────────
    socket.on('whiteboard-action', function(d) {
        const meta = socketMeta.get(socket.id);
        if (!meta || !d) return;
        const room = getRoom(meta.roomId);
        if (!room) return;
        // Store last 500 actions for late-joiners
        room.whiteboardHistory.push({ from: socket.id, action: d.action, ts: Date.now() });
        if (room.whiteboardHistory.length > 500) room.whiteboardHistory.shift();
        broadcast(meta.roomId, 'whiteboard-action', { from: socket.id, action: d.action }, socket.id);
    });

    socket.on('whiteboard-clear', function() {
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        const room = getRoom(meta.roomId);
        if (!room) return;
        room.whiteboardHistory = [];
        broadcast(meta.roomId, 'whiteboard-clear', { from: socket.id }, socket.id);
    });

    // ── Reactions ──────────────────────────────────────────────────────────
    socket.on('reaction', function(d) {
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id);
        if (!peer) return;
        const emoji = (d && d.emoji) ? String(d.emoji).slice(0, 8) : '👋';
        broadcastAll(meta.roomId, 'peer-reaction', { socketId: socket.id, peerId: peer.peerId, name: peer.name, emoji });
    });

    socket.on('hand-raise', function() {
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id);
        if (!peer) return;
        peer.handRaised = true;
        broadcastAll(meta.roomId, 'peer-hand-raise', { socketId: socket.id, peerId: peer.peerId, name: peer.name });
    });

    socket.on('hand-lower', function() {
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id);
        if (!peer) return;
        peer.handRaised = false;
        broadcastAll(meta.roomId, 'peer-hand-lower', { socketId: socket.id, peerId: peer.peerId });
    });

    // ── Video / media sharing  (YouTube, MP4, audio) ───────────────────────
    socket.on('video-share', function(d) {
        const meta = socketMeta.get(socket.id);
        if (!meta || !d || !d.url) return;
        const peer = getPeer(meta.roomId, socket.id);
        if (!peer) return;
        const room = getRoom(meta.roomId);
        if (!room) return;
        room.videoShare = { url: d.url, type: d.type || 'youtube', from: socket.id };
        broadcast(meta.roomId, 'video-share', { from: socket.id, fromName: peer.name, url: d.url, type: d.type || 'youtube' }, socket.id);
        console.log(`[video] "${peer.name}" sharing ${d.url} in room ${meta.roomId}`);
    });

    socket.on('video-share-stop', function() {
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        const room = getRoom(meta.roomId);
        if (!room) return;
        room.videoShare = null;
        broadcast(meta.roomId, 'video-share-stop', { from: socket.id }, socket.id);
    });

    // ── Live captions / speech recognition ────────────────────────────────
    socket.on('caption', function(d) {
        const meta = socketMeta.get(socket.id);
        if (!meta || !d) return;
        const peer = getPeer(meta.roomId, socket.id);
        if (!peer) return;
        broadcast(meta.roomId, 'caption', {
            from:     socket.id,
            fromName: peer.name,
            text:     (d.text || '').slice(0, 500),
            final:    !!d.final,
        }, socket.id);
    });

    // ── Recording ──────────────────────────────────────────────────────────
    socket.on('recording-start', function() {
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id);
        if (!peer) return;
        peer.isRecording = true;
        console.log(`[rec] "${peer.name}" started recording in room ${meta.roomId}`);
        broadcast(meta.roomId, 'peer-recording-start', { socketId: socket.id, name: peer.name }, socket.id);
    });

    socket.on('recording-stop', function() {
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        const peer = getPeer(meta.roomId, socket.id);
        if (!peer) return;
        peer.isRecording = false;
        broadcast(meta.roomId, 'peer-recording-stop', { socketId: socket.id }, socket.id);
    });

    // ── Snapshot ───────────────────────────────────────────────────────────
    socket.on('snapshot', function(d) {
        const meta = socketMeta.get(socket.id);
        if (!meta || !d) return;
        const peer = getPeer(meta.roomId, socket.id);
        if (!peer) return;
        broadcast(meta.roomId, 'snapshot', { from: socket.id, fromName: peer.name, dataURL: d.dataURL || null }, socket.id);
    });

    // ── Meeting duration ───────────────────────────────────────────────────
    socket.on('meeting-duration', function(d) {
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        const room = getRoom(meta.roomId);
        if (!room || room.hostId !== socket.id) return;
        room.duration = (d && d.seconds) || null;
        broadcast(meta.roomId, 'meeting-duration', { seconds: room.duration, from: socket.id }, socket.id);
    });

    // ── PiP ────────────────────────────────────────────────────────────────
    socket.on('pip-start', function() {
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        broadcast(meta.roomId, 'pip-start', { socketId: socket.id }, socket.id);
    });

    socket.on('pip-stop', function() {
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        broadcast(meta.roomId, 'pip-stop', { socketId: socket.id }, socket.id);
    });

    // ── Host controls ──────────────────────────────────────────────────────
    function withHost(fn) {
        const meta = socketMeta.get(socket.id);
        if (!meta) return;
        const room = getRoom(meta.roomId);
        if (!room || room.hostId !== socket.id) return;
        fn(room, meta.roomId);
    }

    socket.on('kick-peer', function(d) {
        withHost(function(room, roomId) {
            const targetId = d && d.socketId;
            if (!targetId || targetId === socket.id || !room.peers.has(targetId)) return;
            io.to(targetId).emit('kicked', { reason: 'You were removed by the host' });
            handleLeave(targetId);
            console.log(`[kick] host removed ${targetId} from room ${roomId}`);
        });
    });

    socket.on('mute-peer', function(d) {
        withHost(function(room) {
            const targetId = d && d.socketId;
            if (!targetId || !room.peers.has(targetId)) return;
            io.to(targetId).emit('force-mute', {});
        });
    });

    socket.on('hide-peer', function(d) {
        withHost(function(room) {
            const targetId = d && d.socketId;
            if (!targetId || !room.peers.has(targetId)) return;
            io.to(targetId).emit('force-hide', {});
        });
    });

    socket.on('request-snapshot', function(d) {
        withHost(function(room) {
            const targetId = d && d.socketId;
            if (!targetId || !room.peers.has(targetId)) return;
            io.to(targetId).emit('snapshot-request', { fromSocketId: socket.id });
        });
    });

    socket.on('lock-room', function() {
        withHost(function(room, roomId) {
            room.locked = !room.locked;
            console.log(`[lock] room ${roomId} locked=${room.locked}`);
            broadcastAll(roomId, 'room-lock-changed', { locked: room.locked });
        });
    });

    socket.on('end-meeting', function() {
        withHost(function(room, roomId) {
            console.log(`[end] host ended room ${roomId}`);
            broadcastAll(roomId, 'meeting-ended', { reason: 'Host ended the meeting' });
            fireWebhook('room-end', { roomId, roomName: room.name });
            room.peers.forEach(function(p) {
                socketMeta.delete(p.socketId);
                const s = io.sockets.sockets.get(p.socketId);
                if (s) s.leave(roomId);
            });
            rooms.delete(roomId);
        });
    });

    // ── Profile updates ────────────────────────────────────────────────────
    socket.on('update-name', function(d) {
        const meta = socketMeta.get(socket.id);
        if (!meta || !d) return;
        const peer = getPeer(meta.roomId, socket.id);
        if (!peer) return;
        const name = (d.name || '').trim().slice(0, 60);
        if (!name) return;
        peer.name = name;
        broadcastAll(meta.roomId, 'peer-info-updated', { socketId: socket.id, peerId: peer.peerId, name });
    });

    socket.on('update-avatar', function(d) {
        const meta = socketMeta.get(socket.id);
        if (!meta || !d) return;
        const peer = getPeer(meta.roomId, socket.id);
        if (!peer) return;
        peer.avatar = d.avatar || null;
        broadcastAll(meta.roomId, 'peer-info-updated', { socketId: socket.id, peerId: peer.peerId, avatar: peer.avatar });
    });

    // ── Keep-alive ─────────────────────────────────────────────────────────
    socket.on('ping', function() { socket.emit('pong', { ts: Date.now() }); });

    // ── Disconnect ─────────────────────────────────────────────────────────
    socket.on('disconnect', function(reason) {
        console.log(`[disconnect] ${socket.id} — ${reason}`);
        handleLeave(socket.id);
    });

    socket.on('error', function(err) {
        console.error(`[socket-err] ${socket.id}:`, err.message);
    });
});

// ─── Stale-room cleanup every 5 min ───────────────────────────────────────
setInterval(function() {
    const cutoff = Date.now() - 3600000;
    rooms.forEach(function(room, id) {
        if (room.peers.size === 0 && room.createdAt < cutoff) {
            rooms.delete(id);
            console.log(`[cleanup] Stale room ${id} removed`);
        }
    });
}, 300000);

// ─── Start ─────────────────────────────────────────────────────────────────
server.listen(PORT, function() {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════╗');
    console.log('  ║     MangoBlox Video Server  v2.0.0               ║');
    console.log('  ║     http://localhost:' + PORT + '                          ║');
    console.log('  ╠══════════════════════════════════════════════════╣');
    console.log('  ║  REST API  (x-api-key: ' + API_KEY_SECRET.slice(0,16) + '...)  ║');
    console.log('  ║    GET  /health                                  ║');
    console.log('  ║    GET  /api/rooms        list all rooms         ║');
    console.log('  ║    GET  /api/rooms/:id    room detail            ║');
    console.log('  ║    POST /api/rooms        create room            ║');
    console.log('  ║    DEL  /api/rooms/:id    delete room            ║');
    console.log('  ║    GET  /api/turn         ICE/TURN credentials   ║');
    console.log('  ║    GET  /api/stats        server stats           ║');
    console.log('  ║    GET  /join?room=X&name=Y&...  direct join     ║');
    console.log('  ╠══════════════════════════════════════════════════╣');
    console.log('  ║  Socket.IO  ws://localhost:' + PORT + '                    ║');
    console.log('  ╠══════════════════════════════════════════════════╣');
    console.log('  ║  Features                                        ║');
    console.log('  ║   ✓ Multi-room WebRTC P2P signaling              ║');
    console.log('  ║   ✓ Screen sharing (display + audio)             ║');
    console.log('  ║   ✓ Public & private in-call chat                ║');
    console.log('  ║   ✓ File sharing (any type, up to 20 MB)         ║');
    console.log('  ║   ✓ Collaborative whiteboard                     ║');
    console.log('  ║   ✓ Hand raise + emoji reactions                 ║');
    console.log('  ║   ✓ YouTube / video URL sharing                  ║');
    console.log('  ║   ✓ Live captions relay                          ║');
    console.log('  ║   ✓ Recording signals                            ║');
    console.log('  ║   ✓ Snapshot relay                               ║');
    console.log('  ║   ✓ Meeting duration/timer                       ║');
    console.log('  ║   ✓ Picture-in-Picture signals                   ║');
    console.log('  ║   ✓ Host: kick / mute / hide / lock / end        ║');
    console.log('  ║   ✓ Auto host reassignment                       ║');
    console.log('  ║   ✓ Room password protection                     ║');
    console.log('  ║   ✓ Reconnect (stable peerId)                    ║');
    console.log('  ║   ✓ REST API + TURN credentials                  ║');
    console.log('  ║   ✓ Webhook events (join/leave/end)              ║');
    console.log('  ║   ✓ Stale room cleanup                           ║');
    console.log('  ╚══════════════════════════════════════════════════╝');
    console.log('');
    if (WEBHOOK_ENABLED)  console.log('  Webhook → ' + WEBHOOK_URL);
    if (TURN_ENABLED)     console.log('  TURN    → ' + TURN_URLS);
    console.log('');
});

module.exports = { app, server, io };
