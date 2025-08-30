// Minimal “bridge” skeleton: health check + Socket.IO echo
require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim());

const app = express();
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'livenix-bridge' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET','POST'] }
});

io.on('connection', socket => {
  console.log('[bridge] socket connected', socket.id);

  socket.emit('bridge:welcome', { msg: 'hello from livenix-bridge 👋' });

  // Example channel join (no-op for now)
  socket.on('join', ({ role }) => {
    console.log(`[bridge] join: role=${role} id=${socket.id}`);
    socket.emit('join:ack', { ok: true, role });
  });

  socket.on('disconnect', () => {
    console.log('[bridge] socket disconnected', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`livenix-bridge listening on http://0.0.0.0:${PORT}`);
});
