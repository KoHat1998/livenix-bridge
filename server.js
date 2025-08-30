// server.js
require('dotenv').config();

const PUBLIC_IP = process.env.PUBLIC_IP || 'YOUR.EC2.PUBLIC.IP'; // <- set in .env
const PORT      = Number(process.env.PORT || 4000);

const express  = require('express');
const wrtc     = require('wrtc'); // required by mediasoup (and for plain WebRTC bridge)
const http     = require('http');
const cors     = require('cors');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');

const app = express();
app.use(cors());
app.use(express.json()); // <-- so POST JSON bodies are parsed
app.get('/health', (_req, res) => res.json({ ok: true, service: 'livenix-bridge' }));

const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// ======================================================================
// Mediasoup core (kept for the Socket.IO-based SFU flow you’ll build next)
// ======================================================================
let worker;
let router;
let broadcasterId = null; // socket.id of the single broadcaster (simple v1)
const transports = new Map(); // transportId -> { transport, socketId, direction }
const producers  = new Map(); // kind -> producer (audio/video)
const consumers  = new Map(); // consumerId -> consumer

(async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
    logLevel: 'warn',
    logTags: ['info','ice','dtls','rtp','srtp','rtcp']
  });
  worker.on('died', () => {
    console.error('mediasoup worker died, exiting');
    process.exit(1);
  });

  router = await worker.createRouter({
    mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f',
          'level-asymmetry-allowed': 1
        }
      }
    ]
  });

  console.log('[bridge] mediasoup router ready');
})();

async function createWebRtcTransport() {
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: PUBLIC_IP }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 2_000_000
  });
  return transport;
}

async function closePeer(socketId) {
  // Transports
  for (const [id, t] of transports) {
    if (t.socketId === socketId) {
      try { await t.transport.close(); } catch {}
      transports.delete(id);
    }
  }
  // Consumers created by this peer
  for (const [cid, c] of consumers) {
    if (c.appData.socketId === socketId) {
      try { await c.close(); } catch {}
      consumers.delete(cid);
    }
  }
  // If broadcaster left, close producers and notify others
  if (socketId === broadcasterId) {
    for (const [, p] of producers) { try { await p.close(); } catch {} }
    producers.clear();
    broadcasterId = null;
    io.sockets.sockets.forEach(s => s.emit('broadcaster-left'));
  }
}

// ======================================================================
// NEW: Plain WebRTC bridge (Broadcaster) – lets Flutter send a vanilla
// SDP offer and receive an SDP answer, so the server gets the live tracks.
// ======================================================================
let pcBroadcaster = null;
let broadcasterTracks = { audio: null, video: null };

app.post('/webrtc/broadcast', async (req, res) => {
  try {
    const { sdp, type } = req.body || {};
    if (!sdp || type !== 'offer') {
      return res.status(400).json({ error: 'invalid offer' });
    }

    // Close existing broadcaster PC if any
    if (pcBroadcaster) {
      try { pcBroadcaster.close(); } catch {}
      pcBroadcaster = null;
      broadcasterTracks = { audio: null, video: null };
    }

    pcBroadcaster = new wrtc.RTCPeerConnection({
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302'] },
      ],
    });

    pcBroadcaster.oniceconnectionstatechange = () => {
      console.log('[wrtc] broadcaster ICE:', pcBroadcaster.iceConnectionState);
      if (['failed', 'disconnected', 'closed'].includes(pcBroadcaster.iceConnectionState)) {
        try { pcBroadcaster.close(); } catch {}
        pcBroadcaster = null;
        broadcasterTracks = { audio: null, video: null };
        // Inform connected clients that broadcaster is gone (optional)
        io.sockets.sockets.forEach(s => s.emit('broadcaster-left'));
      }
    };

    pcBroadcaster.ontrack = (evt) => {
      const track = evt.track;
      console.log('[wrtc] broadcaster ontrack:', track.kind);
      if (track.kind === 'video') broadcasterTracks.video = track;
      if (track.kind === 'audio') broadcasterTracks.audio = track;
    };

    await pcBroadcaster.setRemoteDescription({ type, sdp });

    // We don’t send any local tracks back to the broadcaster; just answer.
    const answer = await pcBroadcaster.createAnswer();
    await pcBroadcaster.setLocalDescription(answer);

    // Notify viewers that a new broadcast is available
    io.sockets.sockets.forEach(s => s.emit('broadcaster-started'));

    return res.json({ sdp: pcBroadcaster.localDescription.sdp, type: 'answer' });
  } catch (e) {
    console.error('/webrtc/broadcast error', e);
    return res.status(500).json({ error: String(e) });
  }
});

// ======================================================================
// Socket.IO – existing SFU signaling endpoints (kept as-is)
// ======================================================================
io.on('connection', (socket) => {
  console.log('[io] connected', socket.id);

  socket.on('disconnect', () => {
    console.log('[io] disconnected', socket.id);
    closePeer(socket.id);
  });

  socket.on('join', ({ role }, cb = () => {}) => {
    if (role === 'broadcaster') {
      if (broadcasterId && broadcasterId !== socket.id) {
        return cb({ error: 'Another broadcaster is already live.' });
      }
      broadcasterId = socket.id;
      cb({ ok: true });
      socket.broadcast.emit('broadcaster-started');
    } else {
      cb({ ok: true });
      if (broadcasterId) socket.emit('broadcaster-started');
    }
  });

  socket.on('getRouterRtpCapabilities', (cb = () => {}) => {
    cb(router?.rtpCapabilities || null);
  });

  socket.on('createTransport', async ({ direction }, cb = () => {}) => {
    try {
      const transport = await createWebRtcTransport();
      transports.set(transport.id, { transport, socketId: socket.id, direction });
      transport.on('dtlsstatechange', (s) => s === 'closed' && transport.close());
      cb({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (e) {
      console.error('[createTransport] error', e);
      cb({ error: e.message });
    }
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, cb = () => {}) => {
    const entry = transports.get(transportId);
    if (!entry) return cb({ error: 'No such transport' });
    await entry.transport.connect({ dtlsParameters });
    cb({ ok: true });
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, cb = () => {}) => {
    if (socket.id !== broadcasterId) return cb({ error: 'Only broadcaster can produce' });
    const entry = transports.get(transportId);
    if (!entry) return cb({ error: 'No transport' });
    try {
      const producer = await entry.transport.produce({ kind, rtpParameters, appData: { socketId: socket.id } });
      producers.set(kind, producer);
      producer.on('transportclose', () => producer.close());
      cb({ id: producer.id });
      socket.broadcast.emit('new-producer', { kind });
    } catch (e) {
      console.error('[produce] error', e);
      cb({ error: e.message });
    }
  });

  socket.on('consume', async ({ transportId, kind, rtpCapabilities }, cb = () => {}) => {
    try {
      const producer = producers.get(kind);
      if (!producer) return cb({ error: 'No producer yet' });
      if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
        return cb({ error: 'Incompatible rtpCapabilities' });
      }
      const entry = transports.get(transportId);
      if (!entry) return cb({ error: 'No transport' });

      const consumer = await entry.transport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: true,
        appData: { socketId: socket.id }
      });
      consumers.set(consumer.id, consumer);
      consumer.on('transportclose', () => consumer.close());
      consumer.on('producerclose', () => {
        try { consumer.close(); } catch {}
        consumers.delete(consumer.id);
        socket.emit('producer-closed', { kind });
      });

      cb({
        id: consumer.id,
        producerId: producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      });
    } catch (e) {
      console.error('[consume] error', e);
      cb({ error: e.message });
    }
  });

  socket.on('resume', async ({ consumerId }, cb = () => {}) => {
    const consumer = consumers.get(consumerId);
    if (!consumer) return cb({ error: 'No consumer' });
    await consumer.resume();
    cb({ ok: true });
  });
});

httpServer.listen(PORT, () => {
  console.log(`livenix-bridge (SFU) on http://0.0.0.0:${PORT}`);
  console.log(`Announced IP: ${PUBLIC_IP}`);
});
