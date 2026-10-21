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
    
    const db = client.db('taskdb');
    const nombreColeccion = req.query.coleccion || 'pendientes_actuales';
    const collection = db.collection(nombreColeccion);

    if (req.method === 'GET') {
      const documents = await collection.find({}).limit(50).toArray();
      
      // Devolvemos información de diagnóstico
      return res.status(200).json({ 
        success: true, 
        conectadoA_BaseDeDatos: db.databaseName, // <-- Te dirá a qué BD entró realmente
        coleccionConsultada: nombreColeccion, 
        totalDocumentos: documents.length,
        data: documents 
      });
    }

    return res.status(405).json({ success: false, error: 'Método no permitido' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};
