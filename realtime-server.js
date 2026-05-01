const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('pg');

// Configuración
const DB_CONFIG = {
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST || 'n8n_postgres',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'chatsapp',
};

const WS_PORT = Number(process.env.WS_PORT || 8080);
const PG_CHANNEL = process.env.PG_CHANNEL || 'realtime';

let pgClient = null;
let reconnectTimer = null;
let shuttingDown = false;
let pgConnected = false;

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectPostgres().catch((err) => {
      console.error('❌ Reintento de PostgreSQL falló:', err.message);
      scheduleReconnect();
    });
  }, 2000);
}

async function connectPostgres() {
  if (shuttingDown || pgClient) return;

  pgClient = new Client(DB_CONFIG);
  pgClient.on('notification', (msg) => {
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

// Crear servidor HTTP
const server = createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'realtime-ws' }));
    return;
  }
  if (req.url === '/healthz') {
    // Liveness endpoint: no debe tumbar el contenedor por una caída temporal de PG.
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

// Crear WebSocket server
const wss = new WebSocketServer({ server });

// Manejar conexiones WebSocket
wss.on('connection', (ws) => {
  console.log('🔗 Cliente WebSocket conectado. Clientes activos:', wss.clients.size);
  
  ws.on('close', () => {
    console.log('🔌 Cliente WebSocket desconectado. Clientes activos:', wss.clients.size);
  });
  
  ws.on('error', (err) => {
    console.error('❌ Error WebSocket:', err);
  });
});

// Iniciar servidor
server.listen(WS_PORT, () => {
  console.log(`🚀 Servidor WebSocket escuchando en ws://0.0.0.0:${WS_PORT}`);
  connectPostgres().catch((err) => {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
    scheduleReconnect();
  });
});

// Manejo de cierre graceful
process.on('SIGTERM', () => {
  console.log('⏹️  Cerrando servidor...');
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const closeWs = new Promise((resolve) => server.close(resolve));
  const closePg = pgClient ? pgClient.end().catch(() => undefined) : Promise.resolve();
  Promise.all([closeWs, closePg]).finally(() => {
    console.log('✔️  Servidor cerrado');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const closeWs = new Promise((resolve) => server.close(resolve));
  const closePg = pgClient ? pgClient.end().catch(() => undefined) : Promise.resolve();
  Promise.all([closeWs, closePg]).finally(() => {
    console.log('✔️  Servidor cerrado');
    process.exit(0);
  });
});
