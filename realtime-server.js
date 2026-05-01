const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('pg');

// Configuración
const DB_CONFIG = {
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'jullAn_2026*',
  host: process.env.DB_HOST || 'n8n_postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'chatsapp',
};

const WS_PORT = process.env.WS_PORT || 8080;

// Crear servidor HTTP
const server = createServer();

// Crear WebSocket server
const wss = new WebSocketServer({ server });

// Conexión a Postgres para escuchar notificaciones
const pgClient = new Client(DB_CONFIG);

// Conectar a Postgres
pgClient.connect().then(() => {
  console.log('✅ Conectado a PostgreSQL');
  
  // Escuchar el canal 'realtime'
  pgClient.query('LISTEN realtime', (err) => {
    if (err) {
      console.error('❌ Error al hacer LISTEN:', err);
      process.exit(1);
    }
    console.log('👂 Escuchando canal "realtime"');
  });
}).catch(err => {
  console.error('❌ Error conectando a PostgreSQL:', err);
  process.exit(1);
});

// Cuando llega una notificación de Postgres
pgClient.on('notification', (msg) => {
  console.log(`📨 Notificación recibida:`, msg.payload);
  
  // Enviar a todos los clientes WebSocket conectados
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      client.send(msg.payload);
    }
  });
});

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
});

// Manejo de cierre graceful
process.on('SIGTERM', () => {
  console.log('⏹️  Cerrando servidor...');
  pgClient.end();
  server.close(() => {
    console.log('✔️  Servidor cerrado');
    process.exit(0);
  });
});
