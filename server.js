/**
 * MangoBlox Server v3.0.0
 * WebRTC signaling + chat relay + web proxy backend
 *
 * Proxy stack:
 *   - Scramjet service-worker rewriter        → /scram/
 *   - BareMux transport layer                  → /baremux/
 *   - Epoxy (WebSocket transport via Wisp)     → /epoxy/
 *   - LibCurl (native-fetch transport via Wisp)→ /libcurl/
 *   - Bare Module v3                           → /baremod/
 *   - Bare Server Node (HTTP proxy)            → /bare/
 *   - Wisp WebSocket proxy                     → /wisp/
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

// ─── Proxy imports (optional — graceful degradation if not installed) ───────
let bare         = null;
let wispServer   = null;
let scramjetPath = null;
let baremuxPath  = null;
let epoxyPath    = null;
let libcurlPath  = null;
let bareModPath  = null;

try { const { createBareServer } = require('@nebula-services/bare-server-node');
      bare = createBareServer('/bare/', { logErrors: false, blockLocal: false });
      console.log('[proxy] bare-server-node loaded ✓'); } catch(e) { console.warn('[proxy] bare-server-node not found — HTTP proxy disabled'); }

try { const w = require('@mercuryworkshop/wisp-js/server');
      wispServer = w.server || w;
      if (wispServer && wispServer.options) {
          wispServer.options.allow_loopback_ips = true;
          wispServer.options.allow_private_ips  = true;
      }
      console.log('[proxy] wisp-js loaded ✓'); } catch(e) { console.warn('[proxy] wisp-js not found — WebSocket proxy disabled'); }

try { scramjetPath = require('@mercuryworkshop/scramjet/path').scramjetPath;
      console.log('[proxy] scramjet loaded from', scramjetPath); } catch(e) { console.warn('[proxy] scramjet not found'); }

try { baremuxPath  = require('@mercuryworkshop/bare-mux/node').baremuxPath;
      console.log('[proxy] bare-mux loaded ✓'); } catch(e) { console.warn('[proxy] bare-mux not found'); }

try { epoxyPath    = require('@mercuryworkshop/epoxy-transport').epoxyPath;
      console.log('[proxy] epoxy-transport loaded ✓'); } catch(e) { console.warn('[proxy] epoxy-transport not found'); }

try { libcurlPath  = require('@mercuryworkshop/libcurl-transport').libcurlPath;
      console.log('[proxy] libcurl-transport loaded ✓'); } catch(e) { console.warn('[proxy] libcurl-transport not found'); }

try { bareModPath  = require('@mercuryworkshop/bare-as-module3').bareModulePath;
      console.log('[proxy] bare-as-module3 loaded ✓'); } catch(e) { console.warn('[proxy] bare-as-module3 not found'); }

// ─── Config ────────────────────────────────────────────────────────────────
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

// ─── App ───────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ─── Handle WebSocket upgrades BEFORE Socket.IO attaches ──────────────────
server.on('upgrade', function(req, socket, head) {
    const url = req.url || '';
    if (bare && bare.shouldRoute(req)) {
        bare.routeUpgrade(req, socket, head);
    } else if (wispServer && url.startsWith('/wisp/')) {
        wispServer.routeRequest(req, socket, head);
    }
    // Socket.IO handles /socket.io/ upgrades through its own internal engine
});

const io = new Server(server, {
    cors:              { origin: '*', methods: ['GET', 'POST'] },
    pingInterval:      25000,
    pingTimeout:       15000,
    maxHttpBufferSize: MAX_FILE_B64 + 131072,
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ─── Bare HTTP proxy middleware ─────────────────────────────────────────────
if (bare) {
    app.use(function(req, res, next) {
        if (bare.shouldRoute(req)) bare.routeRequest(req, res);
        else next();
    });
}

// ─── COEP / COOP headers for proxy routes ──────────────────────────────────
// Required by SharedArrayBuffer (libcurl/epoxy transports)
const proxyPaths = ['/proxy', '/sw.js', '/config.js', '/scram', '/baremux', '/epoxy', '/libcurl', '/baremod', '/bare'];
app.use(proxyPaths, function(req, res, next) {
    res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
});

// ─── Static proxy asset routes ─────────────────────────────────────────────
if (scramjetPath) app.use('/scram',    express.static(scramjetPath));
if (baremuxPath)  app.use('/baremux',  express.static(baremuxPath));
if (epoxyPath)    app.use('/epoxy',    express.static(epoxyPath));
if (libcurlPath)  app.use('/libcurl',  express.static(libcurlPath));
if (bareModPath)  app.use('/baremod',  express.static(bareModPath));

// Serve proxy page + service worker from current directory
app.use(express.static(path.join(__dirname)));

// ─── In-memory state ───────────────────────────────────────────────────────
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

// ─── REST API ──────────────────────────────────────────────────────────────
app.get('/health', function(_, res) {
    res.json({ ok: true, rooms: rooms.size,
        peers: Array.from(rooms.values()).reduce(function(n,r) { return n + r.peers.size; }, 0),
        uptime: Math.round(process.uptime()), version: '3.0.0',
        proxy: { bare: !!bare, wisp: !!wispServer, scramjet: !!scramjetPath } });
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
/* /px — MangoBlox full URL-rewriting proxy */

// Resolve a URL relative to a base, return absolute
function pxAbsolute(url, base) {
    if (!url) return url;
    const u = url.trim();
    if (u.startsWith('data:') || u.startsWith('javascript:') ||
        u.startsWith('blob:') || u.startsWith('#') ||
        u.startsWith('mailto:') || u.startsWith('tel:') ||
        u.startsWith('//') && false) return u;
    // protocol-relative
    if (u.startsWith('//')) {
        try { return new URL('https:' + u).href; } catch(e) { return u; }
    }
    try { return new URL(u, base).href; }
    catch(e) { return u; }
}

// Rewrite a URL to go through the proxy
function pxWrap(url, base, origin) {
    const abs = pxAbsolute(url, base);
    if (!abs) return url;
    const a = abs.trim();
    if (a.startsWith('data:') || a.startsWith('javascript:') ||
        a.startsWith('blob:') || a.startsWith('#') ||
        a.startsWith('mailto:') || a.startsWith('tel:')) return a;
    try {
        new URL(a); // validate
        return origin + '/px?url=' + encodeURIComponent(a);
    } catch(e) { return url; }
}

// Rewrite all HTML attributes and inject intercept script
function pxRewriteHtml(html, pageUrl, origin) {
    const base = pageUrl;

    // Remove security headers embedded as meta tags
    html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?(?:x-frame-options|content-security-policy|x-content-type-options)[^>]*>/gi, '');

    // Rewrite src, href, action, poster, data, srcset in tags
    html = html.replace(/(<[a-z][a-z0-9]*\b[^>]*?\s)(src|href|action|poster|data|formaction)\s*=\s*(['"])(.*?)\3/gi, function(m, pre, attr, q, val) {
        // Skip inline JS and anchors
        if (val.startsWith('javascript:') || val.startsWith('#') || val.startsWith('data:')) return m;
        return pre + attr + '=' + q + pxWrap(val, base, origin) + q;
    });

    // Rewrite srcset
    html = html.replace(/\ssrcset\s*=\s*(['"])(.*?)\1/gi, function(m, q, val) {
        const rw = val.split(',').map(function(part) {
            const t = part.trim();
            const si = t.search(/\s/);
            if (si === -1) return pxWrap(t, base, origin);
            return pxWrap(t.slice(0, si), base, origin) + t.slice(si);
        }).join(', ');
        return ' srcset=' + q + rw + q;
    });

    // Rewrite CSS url() in style attributes and <style> tags
    html = html.replace(/url\(\s*(['"]?)((?:(?!\1\)).)*?)\1\s*\)/gi, function(m, q, val) {
        if (val.startsWith('data:') || val.startsWith('#')) return m;
        return 'url(' + q + pxWrap(val, base, origin) + q + ')';
    });

    // Inject intercept script + base tag before </head>
    const intercept = buildInterceptScript(base, origin);
    if (html.includes('</head>')) {
        html = html.replace('</head>', intercept + '</head>');
    } else {
        html = intercept + html;
    }

    return html;
}

function pxRewriteCss(css, pageUrl, origin) {
    css = css.replace(/url\(\s*(['"]?)((?:(?!\1\)).)*?)\1\s*\)/gi, function(m, q, val) {
        if (val.startsWith('data:') || val.startsWith('#')) return m;
        return 'url(' + q + pxWrap(val, pageUrl, origin) + q + ')';
    });
    css = css.replace(/@import\s+(['"])(.*?)\1/gi, function(m, q, val) {
        return '@import ' + q + pxWrap(val, pageUrl, origin) + q;
    });
    return css;
}

function buildInterceptScript(base, origin) {
    // This script runs inside every proxied page and:
    // 1. Intercepts link clicks and form submits → sends to proxy
    // 2. Overrides fetch/XHR to go through proxy
    // 3. Overrides location.href/assign/replace
    // 4. Reports navigation back to the popup host
    return '<script>(function(){'
        + 'var _B=' + JSON.stringify(base) + ';'
        + 'var _O=' + JSON.stringify(origin) + ';'
        + 'function _px(u){'
        +   'if(!u)return u;'
        +   'var s=u.trim();'
        +   'if(s.startsWith("data:")||s.startsWith("javascript:")||s.startsWith("blob:")||s.startsWith("#")||s.startsWith("mailto:"))return s;'
        +   'try{var abs=new URL(s,_B).href;return _O+"/px?url="+encodeURIComponent(abs);}catch(e){return u;}'
        + '}'
        + 'function _nav(url){'
        +   'try{var abs=new URL(url,_B).href;window.parent.postMessage({type:"px-navigate",url:abs},"*");window.top.postMessage({type:"px-navigate",url:abs},"*");}catch(e){}'
        + '}'
        // Intercept clicks
        + 'document.addEventListener("click",function(e){'
        +   'var a=e.target.closest("a");'
        +   'if(!a)return;'
        +   'var h=a.getAttribute("href");'
        +   'if(!h||h.startsWith("#")||h.startsWith("javascript:"))return;'
        +   'var t=a.getAttribute("target");'
        +   'if(t==="_blank"||t==="blank"){e.preventDefault();_nav(h);return;}'
        +   'e.preventDefault();_nav(h);'
        + '},true);'
        // Intercept forms
        + 'document.addEventListener("submit",function(e){'
        +   'var f=e.target;if(!f||!f.action)return;'
        +   'e.preventDefault();'
        +   'if(f.method&&f.method.toLowerCase()==="get"){'
        +     'var data=new URLSearchParams(new FormData(f));'
        +     'var u=new URL(f.action,_B);'
        +     'data.forEach(function(v,k){u.searchParams.set(k,v);});'
        +     '_nav(u.href);'
        +   '}else{'
        +     '_nav(f.action);'
        +   '}'
        + '},true);'
        // Override fetch
        + 'var _of=window.fetch;'
        + 'window.fetch=function(input,init){'
        +   'if(typeof input==="string"&&!input.startsWith(_O))input=_px(input);'
        +   'else if(input instanceof Request&&!input.url.startsWith(_O)){input=new Request(_px(input.url),input);}'
        +   'return _of.call(window,input,init);'
        + '};'
        // Override XHR
        + 'var _xo=XMLHttpRequest.prototype.open;'
        + 'XMLHttpRequest.prototype.open=function(m,u){if(typeof u==="string"&&!u.startsWith(_O))u=_px(u);return _xo.apply(this,arguments);};'
        // Override location navigation
        + 'var _la=location.assign.bind(location),_lr=location.replace.bind(location);'
        + 'try{'
        +   'Object.defineProperty(location,"assign",{value:function(u){_nav(u);}});'
        +   'Object.defineProperty(location,"replace",{value:function(u){_nav(u);}});'
        + '}catch(e){}'
        // Override window.open
        + 'var _wo=window.open;'
        + 'window.open=function(url,t,f){'
        +   'if(url&&!url.startsWith("about:")&&!url.startsWith("blob:")){'
        +     '_nav(url);return null;'
        +   '}'
        +   'return _wo.call(window,url,t,f);'
        + '};'
        // Send title updates
        + 'function _sendTitle(){try{window.top.postMessage({type:"px-title",title:document.title},"*");}catch(e){}}'
        + 'document.addEventListener("DOMContentLoaded",_sendTitle);'
        + 'setTimeout(_sendTitle,500);'
        // Watch for meta refresh
        + 'setTimeout(function(){'
        +   'var metas=document.querySelectorAll("meta[http-equiv=refresh]");'
        +   'metas.forEach(function(m){'
        +     'var c=m.getAttribute("content")||"";'
        +     'var match=c.match(/url=(.+)/i);'
        +     'if(match)_nav(match[1]);'
        +   '});'
        + '},300);'
        + '})()\x3c/script>';
}

app.get('/px', async function(req, res) {
    const target = req.query.url;
    if (!target) return res.status(400).send('<h3>Missing ?url= parameter</h3>');

    let parsed;
    try { parsed = new URL(target); }
    catch(e) { return res.status(400).send('<h3>Invalid URL</h3>'); }
    if (!['http:', 'https:'].includes(parsed.protocol))
        return res.status(400).send('<h3>Only http/https allowed</h3>');

    // Determine origin (self) for building rewritten URLs
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host  = req.headers['x-forwarded-host'] || req.headers['host'] || '';
    const selfOrigin = proto + '://' + host;

    try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);

        const upResp = await fetch(target, {
            signal: ctrl.signal,
            redirect: 'follow',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'identity',
                'Referer': parsed.origin + '/',
                'Origin': parsed.origin,
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Dest': 'document',
                'Cache-Control': 'no-cache',
            },
        });
        clearTimeout(timer);

        // Strip/override security headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('X-Frame-Options', 'ALLOWALL');
        res.setHeader('Cache-Control', 'no-store');
        res.removeHeader('Content-Security-Policy');
        res.removeHeader('X-Content-Security-Policy');
        res.removeHeader('Permissions-Policy');

        const ct = upResp.headers.get('content-type') || 'application/octet-stream';
        res.setHeader('Content-Type', ct);

        // Use the final URL after any redirects as the base
        const finalUrl = upResp.url || target;

        if (ct.includes('text/html')) {
            let html = await upResp.text();
            html = pxRewriteHtml(html, finalUrl, selfOrigin);
            return res.send(html);
        } else if (ct.includes('text/css')) {
            let css = await upResp.text();
            css = pxRewriteCss(css, finalUrl, selfOrigin);
            return res.send(css);
        } else if (ct.includes('javascript') || ct.includes('ecmascript') || ct.includes('text/plain')) {
            return res.send(await upResp.text());
        } else {
            // Binary — stream directly
            const buf = await upResp.arrayBuffer();
            return res.send(Buffer.from(buf));
        }
    } catch(e) {
        const code = e.name === 'AbortError' ? 504 : 502;
        res.status(code).send(`<!DOCTYPE html><html><body style="background:#0a0a12;color:#e63946;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;">
            <div style="font-size:2.5rem">&#9888;</div>
            <h2 style="margin:0">Could not load page</h2>
            <p style="color:#888;font-size:.9rem">${e.message}</p>
            <p style="color:#555;font-size:.75rem">${target}</p>
        <\/body><\/html>`);
    }
});

// Handle POST proxying (form submits)
app.post('/px', async function(req, res) {
    req.method = 'POST';
    // redirect to GET for simplicity — most form navigations work as GET
    const target = req.query.url;
    if (!target) return res.status(400).send('Missing url');
    res.redirect(303, '/px?url=' + encodeURIComponent(target));
});


// ─── Socket.IO ─────────────────────────────────────────────────────────────
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
    socket.on('kick-peer',        function(d) { withHost(function(room, roomId) { const t = d&&d.socketId; if (!t||t===socket.id||!room.peers.has(t)) return; io.to(t).emit('kicked', { reason: 'Removed by host' }); handleLeave(t); }); });
    socket.on('mute-peer',        function(d) { withHost(function(room) { const t = d&&d.socketId; if (t&&room.peers.has(t)) io.to(t).emit('force-mute', {}); }); });
    socket.on('hide-peer',        function(d) { withHost(function(room) { const t = d&&d.socketId; if (t&&room.peers.has(t)) io.to(t).emit('force-hide', {}); }); });
    socket.on('request-snapshot', function(d) { withHost(function(room) { const t = d&&d.socketId; if (t&&room.peers.has(t)) io.to(t).emit('snapshot-request', { fromSocketId: socket.id }); }); });
    socket.on('lock-room',        function()  { withHost(function(room, roomId) { room.locked = !room.locked; broadcastAll(roomId, 'room-lock-changed', { locked: room.locked }); }); });
    socket.on('end-meeting',      function()  { withHost(function(room, roomId) {
        broadcastAll(roomId, 'meeting-ended', { reason: 'Host ended the meeting' });
        fireWebhook('room-end', { roomId, roomName: room.name });
        room.peers.forEach(function(p) { socketMeta.delete(p.socketId); const s = io.sockets.sockets.get(p.socketId); if (s) s.leave(roomId); });
        rooms.delete(roomId);
    }); });

    socket.on('update-name', function(d) {
        const meta = socketMeta.get(socket.id); if (!meta || !d) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        const name = (d.name || '').trim().slice(0,60); if (!name) return;
        peer.name = name; broadcastAll(meta.roomId, 'peer-info-updated', { socketId: socket.id, peerId: peer.peerId, name });
    });
    socket.on('update-avatar', function(d) {
        const meta = socketMeta.get(socket.id); if (!meta || !d) return;
        const peer = getPeer(meta.roomId, socket.id); if (!peer) return;
        peer.avatar = d.avatar || null; broadcastAll(meta.roomId, 'peer-info-updated', { socketId: socket.id, peerId: peer.peerId, avatar: peer.avatar });
    });

    socket.on('ping',       function()    { socket.emit('pong', { ts: Date.now() }); });
    socket.on('disconnect', function(r)   { console.log(`[disconnect] ${socket.id} — ${r}`); handleLeave(socket.id); });
    socket.on('error',      function(err) { console.error(`[socket-err] ${socket.id}:`, err.message); });
});

// ─── Stale-room cleanup ────────────────────────────────────────────────────
setInterval(function() {
    const cutoff = Date.now() - 3600000;
    rooms.forEach(function(room, id) { if (room.peers.size === 0 && room.createdAt < cutoff) { rooms.delete(id); console.log(`[cleanup] ${id} removed`); } });
}, 300000);

// ─── Start ─────────────────────────────────────────────────────────────────
server.listen(PORT, function() {
    console.log(`\n  MangoBlox Server v3.0.0  →  http://localhost:${PORT}`);
    console.log(`  Proxy page            →  http://localhost:${PORT}/proxy`);
    console.log(`  Bare HTTP proxy       →  ${bare ? 'http://localhost:' + PORT + '/bare/' : 'disabled'}`);
    console.log(`  Wisp WebSocket proxy  →  ${wispServer ? 'ws://localhost:' + PORT + '/wisp/' : 'disabled'}`);
    console.log(`  Scramjet assets       →  ${scramjetPath || 'not installed'}`);
    console.log('');
    if (WEBHOOK_ENABLED) console.log('  Webhook → ' + WEBHOOK_URL);
    if (TURN_ENABLED)    console.log('  TURN    → ' + TURN_URLS);
});

module.exports = { app, server, io };
