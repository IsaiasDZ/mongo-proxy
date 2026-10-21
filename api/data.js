const { MongoClient } = require('mongodb');

// Reutilizamos la conexión para no abrir cientos de conexiones en MongoDB Atlas
let cachedClient = null;

async function connectToDatabase() {
  if (cachedClient) {
    return cachedClient;
  }
  
  // Lee la cadena de conexión desde las variables de entorno de Vercel
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  cachedClient = client;
  return client;
}

module.exports = async (req, res) => {
  try {
    const client = await connectToDatabase();
    
    // Sustituye 'tu-base-de-datos' y 'tu-coleccion' por los nombres reales de tu MongoDB Atlas
    const db = client.db('tu-base-de-datos');
    const collection = db.collection('tu-coleccion');

    // Manejo de lectura (GET)
    if (req.method === 'GET') {
      const documents = await collection.find({}).limit(20).toArray();
      return res.status(200).json({ success: true, data: documents });
    }

    // Manejo de inserción (POST)
    if (req.method === 'POST') {
      const newDocument = req.body;
      const result = await collection.insertOne(newDocument);
      return res.status(201).json({ success: true, insertedId: result.insertedId });
    }

    return res.status(405).json({ success: false, error: 'Método no permitido' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};