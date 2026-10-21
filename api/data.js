const { MongoClient } = require('mongodb');

let cachedClient = null;

async function connectToDatabase() {
  if (cachedClient) {
    return cachedClient;
  }
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  cachedClient = client;
  return client;
}

module.exports = async (req, res) => {
  try {
    const client = await connectToDatabase();
    
    // Tu base de datos fija según la imagen
    const db = client.db('taskdb');

    // Obtenemos la colección desde los parámetros de la URL (ej: /api/data?coleccion=usuarios)
    // Si no envían ninguna, por defecto usará 'pendientes_actuales'
    const nombreColeccion = req.query.coleccion || 'pendientes_actuales';
    const collection = db.collection(nombreColeccion);

    if (req.method === 'GET') {
      const documents = await collection.find({}).limit(50).toArray();
      return res.status(200).json({ 
        success: true, 
        coleccionConsultada: nombreColeccion, 
        data: documents 
      });
    }

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