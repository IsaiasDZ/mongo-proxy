// Servidor HTTP para Railway (u otro host con proceso siempre encendido).
// Reutiliza la misma lógica que la función de Vercel (api/data.js): en Vercel
// se usa api/data.js directamente y este archivo se ignora.
const http = require('http');
const zlib = require('zlib');
const handler = require('./api/data');

const PORT = Number(process.env.PORT) || 3000;
// Railway no limita el tamaño como Vercel (4.5 MB); se fija un tope propio.
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(raw) });
  res.end(raw);
}

// Adapta req/res de Node al formato de Vercel: req.query, req.body ya parseado
// y respuesta comprimida con gzip cuando el cliente lo acepta.
function adapt(req, res, url, raw) {
  req.query = Object.fromEntries(url.searchParams);
  req.body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const end = res.end.bind(res);
    res.end = (body) => {
      const compressed = zlib.gzipSync(Buffer.from(body || ''));
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', compressed.length);
      return end(compressed);
    };
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Chequeo de salud de Railway: no requiere clave ni toca la base.
  if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
  if (url.pathname !== '/api/data' && url.pathname !== '/api/data/') {
    return sendJson(res, 404, { success: false, error: 'Ruta no encontrada.' });
  }

  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      sendJson(res, 413, { success: false, error: 'La petición supera el límite de 10 MB.' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', async () => {
    if (res.writableEnded) return;
    try {
      adapt(req, res, url, Buffer.concat(chunks));
    } catch {
      return sendJson(res, 400, { success: false, error: 'El cuerpo de la petición no es JSON válido.' });
    }
    await handler(req, res);
  });
});

// Mayor que el tiempo de inactividad del balanceador de Railway, para que no
// cierre una conexión keep-alive que la app todavía va a reutilizar (errores 502).
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, '0.0.0.0', () => console.log(`Proxy de datos escuchando en el puerto ${PORT}`));

// Con proceso siempre encendido se detectan en vivo todos los cambios de la base
// (incluidos los hechos fuera de la app). PROXY_LIVE_CHANGES=0 lo desactiva.
if (process.env.PROXY_LIVE_CHANGES !== '0') handler.startChangeTracking();

// Railway envía SIGTERM al redesplegar: termina las peticiones en curso.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
});
