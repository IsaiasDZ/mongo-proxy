// Proxy HTTPS (puerto 443) entre PendientesCROD y MongoDB Atlas.
// La app de escritorio no puede usar el puerto 27017 en la red de la empresa,
// así que todas las operaciones pasan por esta función de Vercel.
//
// Variables de entorno en Vercel:
//   MONGODB_URI    URI de Atlas con la base al final (…mongodb.net/taskdb?…)
//   PROXY_API_KEY  clave secreta (mínimo 16 caracteres) que envía la app en x-api-key
//
// Peticiones: POST con JSON {"action": "...", ...}. Los documentos viajan en
// Extended JSON (EJSON) para conservar tipos como ObjectId o fechas.
const crypto = require('crypto');
const { MongoClient, BSON } = require('mongodb');

const { EJSON } = BSON;

const ALLOWED_COLLECTIONS = new Set([
  'pendientes_actuales',
  'pendientes_resueltos',
  'energia',
  'borradores_energia',
  'alarmas',
  'usuarios',
  'fallas_energia',
  'notas',
  'credenciales',
  'recordatorios',
  'secuencias_tickets',
]);
const PENDING_COLLECTIONS = ['pendientes_actuales', 'pendientes_resueltos'];
const TICKET_COLLECTION = 'secuencias_tickets';
// Contador de cambios: la app consulta solo este documento para saber si debe
// volver a leer datos, y por colección para traer únicamente lo que cambió.
const META_COLLECTION = 'app_estado';
const META_ID = 'version';
const TICKET_PATTERN = /^Rep(\d{6})-(\d+)$/;
const UNTICKETED = { ticket: { $in: [null, ''] } };
const STORAGE_LIMIT_BYTES = 500 * 1024 * 1024;
const MAX_EXPORT_PAGE = 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let clientPromise = null;

function getClient() {
  if (!clientPromise) {
    if (!process.env.MONGODB_URI) {
      throw new HttpError(500, 'Falta la variable MONGODB_URI en Vercel.');
    }
    clientPromise = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    })
      .connect()
      .catch((error) => {
        clientPromise = null;
        throw error;
      });
  }
  return clientPromise;
}

function authorized(req) {
  const expected = process.env.PROXY_API_KEY || '';
  // Sin clave configurada el proxy no responde datos (falla cerrado).
  if (expected.length < 16) return false;
  const given = String(req.headers['x-api-key'] || '');
  const hash = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(hash(given), hash(expected));
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(EJSON.stringify(body, { relaxed: true }));
}

function collectionName(name) {
  if (typeof name !== 'string' || !ALLOWED_COLLECTIONS.has(name)) {
    throw new HttpError(400, `Colección no permitida: ${name}`);
  }
  return name;
}

function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') body = body ? JSON.parse(body) : {};
  if (Buffer.isBuffer(body)) body = JSON.parse(body.toString('utf8'));
  if (!body || typeof body !== 'object') return {};
  return EJSON.deserialize(body, { relaxed: true });
}

// Compatible con el driver 5 ({value}) y 6+ (documento directo).
const unwrap = (result) => (result && typeof result === 'object' && 'ok' in result && 'value' in result ? result.value : result);

async function readMeta(db, session) {
  const meta = await db.collection(META_COLLECTION).findOne({ _id: META_ID }, { session });
  return { version: meta?.value ?? 0, cols: meta?.cols ?? {} };
}

async function bumpVersion(db, names, session) {
  const increments = { value: 1 };
  for (const name of new Set(names)) increments[`cols.${name}`] = 1;
  await db.collection(META_COLLECTION).updateOne({ _id: META_ID }, { $inc: increments }, { upsert: true, session });
}

// Día del ticket (DDMMYY) en la zona horaria del equipo que hace la petición.
function ticketDay(timestamp, tzOffsetMinutes) {
  const base = typeof timestamp === 'number' ? timestamp : Date.now();
  const local = new Date(base + (Number(tzOffsetMinutes) || 0) * 60000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(local.getUTCDate())}${pad(local.getUTCMonth() + 1)}${String(local.getUTCFullYear()).slice(-2)}`;
}

// Asigna ticket a pendientes que no lo tengan, sin repetir números del día.
async function backfillTickets(db, session, tzOffsetMinutes) {
  const missing = [];
  for (const name of PENDING_COLLECTIONS) {
    const documents = await db.collection(name).find(UNTICKETED, { session }).toArray();
    for (const document of documents) missing.push({ name, document });
  }
  if (!missing.length) return false;

  const maximumByDay = new Map();
  for (const name of PENDING_COLLECTIONS) {
    const documents = await db
      .collection(name)
      .find({ ticket: { $regex: TICKET_PATTERN.source } }, { projection: { ticket: 1 }, session })
      .toArray();
    for (const { ticket } of documents) {
      const match = TICKET_PATTERN.exec(ticket || '');
      if (match) maximumByDay.set(match[1], Math.max(maximumByDay.get(match[1]) || 0, Number(match[2])));
    }
  }
  const sequences = db.collection(TICKET_COLLECTION);
  for (const [day, maximum] of maximumByDay) {
    await sequences.updateOne({ _id: day }, { $max: { sequence: maximum } }, { upsert: true, session });
  }
  for (const { name, document } of missing) {
    const day = ticketDay(document.ts, tzOffsetMinutes);
    const sequence = unwrap(
      await sequences.findOneAndUpdate({ _id: day }, { $inc: { sequence: 1 } }, { upsert: true, returnDocument: 'after', session }),
    );
    await db
      .collection(name)
      .updateOne({ _id: document._id }, { $set: { ticket: `Rep${day}-${String(sequence.sequence).padStart(2, '0')}` } }, { session });
  }
  await bumpVersion(db, PENDING_COLLECTIONS, session);
  return true;
}

async function withTransaction(client, work) {
  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

const actions = {
  async ping({ db }) {
    await db.command({ ping: 1 });
    return { ok: true, database: db.databaseName };
  },

  // Sin "known" devuelve todo; con "known" ({colección: versión}) solo lo que cambió.
  async state({ client, db, body }) {
    const names = (body.collections || []).map(collectionName);
    const known = body.known && typeof body.known === 'object' ? body.known : null;
    if (!known) {
      const unticketed = await Promise.all(PENDING_COLLECTIONS.map((name) => db.collection(name).findOne(UNTICKETED, { projection: { _id: 1 } })));
      if (unticketed.some(Boolean)) await withTransaction(client, (session) => backfillTickets(db, session, body.tzOffset));
    }
    const meta = await readMeta(db);
    const cols = Object.fromEntries(names.map((name) => [name, meta.cols[name] ?? 0]));
    const changed = known ? names.filter((name) => known[name] !== cols[name]) : names;
    const data = {};
    await Promise.all(
      changed.map(async (name) => {
        data[name] = await db.collection(name).find({}).sort({ position: 1 }).toArray();
      }),
    );
    return { version: meta.version, cols, data };
  },

  async apply({ client, db, body }) {
    const upsert = body.upsert || {};
    const remove = body.delete || {};
    const names = [...new Set([...Object.keys(upsert), ...Object.keys(remove)])].map(collectionName);
    if (!names.length) return { ok: true };
    await withTransaction(client, async (session) => {
      for (const name of names) {
        const operations = [];
        for (const record of upsert[name] || []) {
          const document = { ...record };
          const id = String(document.id || crypto.randomUUID());
          delete document.id;
          delete document._id;
          const unset = Array.isArray(document.__unset) ? document.__unset : [];
          delete document.__unset;
          const update = {};
          if (Object.keys(document).length) update.$set = document;
          if (unset.length) update.$unset = Object.fromEntries(unset.map((field) => [field, '']));
          if (Object.keys(update).length) operations.push({ updateOne: { filter: { _id: id }, update, upsert: true } });
        }
        if (operations.length) await db.collection(name).bulkWrite(operations, { ordered: true, session });
        const ids = (remove[name] || []).map(String);
        if (ids.length) await db.collection(name).deleteMany({ _id: { $in: ids } }, { session });
      }
      await bumpVersion(db, names, session);
    });
    return { ok: true };
  },

  async ticket({ client, db, body }) {
    const day = String(body.day || '');
    if (!/^\d{6}$/.test(day)) throw new HttpError(400, 'El día del ticket debe tener formato DDMMYY.');
    const ticket = await withTransaction(client, async (session) => {
      await backfillTickets(db, session, body.tzOffset);
      const pattern = new RegExp(`^Rep${day}-(\\d+)$`);
      let maximum = 0;
      for (const name of PENDING_COLLECTIONS) {
        const documents = await db.collection(name).find({ ticket: { $regex: pattern.source } }, { projection: { ticket: 1 }, session }).toArray();
        for (const { ticket: value } of documents) {
          const match = pattern.exec(value || '');
          if (match) maximum = Math.max(maximum, Number(match[1]));
        }
      }
      const sequences = db.collection(TICKET_COLLECTION);
      await sequences.updateOne({ _id: day }, { $max: { sequence: maximum } }, { upsert: true, session });
      const sequence = unwrap(
        await sequences.findOneAndUpdate({ _id: day }, { $inc: { sequence: 1 } }, { upsert: true, returnDocument: 'after', session }),
      );
      return `Rep${day}-${String(sequence.sequence).padStart(2, '0')}`;
    });
    return { ticket };
  },

  async stats({ db, body }) {
    const names = (body.collections || []).map(collectionName);
    const [counts, stats] = await Promise.all([
      Promise.all(names.map(async (name) => ({ name, documents: await db.collection(name).countDocuments({}) }))),
      db.command({ dbStats: 1, scale: 1 }),
    ]);
    const storageBytes = Number(stats.storageSize) || 0;
    const indexBytes = Number(stats.indexSize) || 0;
    return {
      database: db.databaseName,
      collections: counts,
      storage: {
        used_bytes: storageBytes + indexBytes,
        data_bytes: Number(stats.dataSize) || 0,
        storage_bytes: storageBytes,
        index_bytes: indexBytes,
        limit_bytes: STORAGE_LIMIT_BYTES,
      },
    };
  },

  // Página de una colección para el backup (las respuestas de Vercel tienen tope de tamaño).
  async export({ db, body }) {
    const name = collectionName(body.collection);
    const limit = Math.min(Math.max(Number(body.limit) || 500, 1), MAX_EXPORT_PAGE);
    const skip = Math.max(Number(body.skip) || 0, 0);
    const documents = await db.collection(name).find({}).sort({ _id: 1 }).skip(skip).limit(limit).toArray();
    return { documents };
  },

  // Combina documentos de un backup: mismo _id se reemplaza; las secuencias de tickets nunca retroceden.
  async merge({ db, body }) {
    const name = collectionName(body.collection);
    const documents = Array.isArray(body.documents) ? body.documents : [];
    if (!documents.every((document) => document && typeof document === 'object' && '_id' in document)) {
      throw new HttpError(400, 'Todos los documentos deben tener _id.');
    }
    if (documents.length) {
      const operations =
        name === TICKET_COLLECTION
          ? documents.map((document) => ({ updateOne: { filter: { _id: document._id }, update: { $max: { sequence: document.sequence } }, upsert: true } }))
          : documents.map((document) => ({ replaceOne: { filter: { _id: document._id }, replacement: document, upsert: true } }));
      await db.collection(name).bulkWrite(operations, { ordered: true });
      await bumpVersion(db, [name]);
    }
    return { documents: documents.length };
  },
};

module.exports = async (req, res) => {
  try {
    if (!authorized(req)) return send(res, 401, { success: false, error: 'No autorizado.' });
    const client = await getClient();
    const db = client.db();

    // Consulta rápida de prueba desde el navegador o curl (requiere la clave).
    if (req.method === 'GET') {
      const name = collectionName(req.query?.coleccion || 'pendientes_actuales');
      const documents = await db.collection(name).find({}).limit(50).toArray();
      return send(res, 200, { success: true, conectadoA_BaseDeDatos: db.databaseName, coleccionConsultada: name, totalDocumentos: documents.length, data: documents });
    }
    if (req.method !== 'POST') return send(res, 405, { success: false, error: 'Método no permitido' });

    const body = readBody(req);
    const action = actions[body.action];
    if (!action) throw new HttpError(400, `Acción desconocida: ${body.action}`);
    return send(res, 200, { success: true, ...(await action({ client, db, body })) });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(error);
    return send(res, status, { success: false, error: status >= 500 && !(error instanceof HttpError) ? 'Error interno del servicio de datos.' : error.message });
  }
};
