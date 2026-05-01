const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('pg');

const DB_CONFIG = {
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST || 'n8n_postgres',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'chatsapp',
};

const WS_PORT = Number(process.env.PORT || process.env.WS_PORT || 8080);
const PG_CHANNEL = process.env.PG_CHANNEL || 'realtime';

let pgClient = null;
let reconnectTimer = null;
let reconnectDelayMs = 1000;
let shuttingDown = false;
let pgConnected = false;

const server = createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'realtime-ws' }));
    return;
  }
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, postgres: pgConnected }));
    return;
  }
  if (req.url === '/readyz') {
    const ready = pgConnected;
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: ready, postgres: pgConnected }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const wss = new WebSocketServer({ server });

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectPostgres().catch((err) => {
      console.error('❌ Reintento de PostgreSQL falló:', err.message);
      scheduleReconnect();
    });
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
}

async function connectPostgres() {
  if (shuttingDown || pgClient) return;

  pgClient = new Client(DB_CONFIG);

  pgClient.on('notification', (msg) => {
    console.log('NOTIFY:', msg.channel, msg.payload);
    const payload = msg.payload || '{}';
    wss.clients.forEach((client) => {
      if (client.readyState === 1) client.send(payload);
    });
  });

  pgClient.on('error', (err) => {
    console.error('❌ Error PostgreSQL:', err.message);
  });

  pgClient.on('end', () => {
    console.error('⚠️ Conexión PostgreSQL cerrada');
    pgConnected = false;
    pgClient = null;
    scheduleReconnect();
  });

  try {
    await pgClient.connect();
    await pgClient.query(`LISTEN ${PG_CHANNEL}`);
    pgConnected = true;
    reconnectDelayMs = 1000;
    console.log(`✅ Conectado a PostgreSQL y escuchando canal "${PG_CHANNEL}"`);
  } catch (err) {
    pgConnected = false;
    if (pgClient) {
      try { await pgClient.end(); } catch {}
    }
    pgClient = null;
    throw err;
  }
}

wss.on('connection', (ws) => {
  console.log('🔗 Cliente WebSocket conectado. Clientes activos:', wss.clients.size);
  ws.on('close', () => {
    console.log('🔌 Cliente WebSocket desconectado. Clientes activos:', wss.clients.size);
  });
  ws.on('error', (err) => {
    console.error('❌ Error WebSocket:', err.message);
  });
});

server.listen(WS_PORT, () => {
  console.log(`🚀 Servidor WebSocket escuchando en ws://0.0.0.0:${WS_PORT}`);
  connectPostgres().catch((err) => {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
    scheduleReconnect();
  });
});

function gracefulShutdown(signal) {
  console.log(`⏹️  Cerrando servidor... (signal=${signal}, pid=${process.pid})`);
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const closeWs = new Promise((resolve) => server.close(resolve));
  const closePg = pgClient ? pgClient.end().catch(() => undefined) : Promise.resolve();
  Promise.all([closeWs, closePg]).finally(() => {
    console.log('✔️  Servidor cerrado');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
