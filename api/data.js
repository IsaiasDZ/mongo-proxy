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
    const db = client.db(); 

    const nombreColeccion = req.query.coleccion || 'pendientes_actuales';
    const collection = db.collection(nombreColeccion);

    // 1. READ (GET): Leer documentos
    if (req.method === 'GET') {
      const documents = await collection.find({}).limit(50).toArray();
      return res.status(200).json({ 
        success: true, 
        conectadoA_BaseDeDatos: db.databaseName, 
        coleccionConsultada: nombreColeccion, 
        totalDocumentos: documents.length,
        data: documents 
      });
    }

    // 2. CREATE (POST): Insertar un nuevo documento
    if (req.method === 'POST') {
      const nuevoDocumento = req.body;
      const resultado = await collection.insertOne(nuevoDocumento);
      return res.status(201).json({ 
        success: true, 
        mensaje: "Documento creado exitosamente",
        insertedId: resultado.insertedId 
      });
    }

    // 3. UPDATE (PUT): Actualizar un documento (ej: buscando por su _id o ticket)
    if (req.method === 'PUT') {
      const { filtro, actualizacion } = req.body; // Envías { filtro: {ticket: "..."}, actualizacion: { $set: { ... } } }
      const resultado = await collection.updateOne(filtro, actualizacion);
      return res.status(200).json({ 
        success: true, 
        mensaje: "Documento actualizado",
        modificados: resultado.modifiedCount 
      });
    }

    // 4. DELETE (DELETE): Borrar un documento
    if (req.method === 'DELETE') {
      const filtro = req.body; // Envías el criterio de búsqueda para borrar, ej: { ticket: "..." }
      const resultado = await collection.deleteOne(filtro);
      return res.status(200).json({ 
        success: true, 
        mensaje: "Documento eliminado",
        eliminados: resultado.deletedCount 
      });
    }

    return res.status(405).json({ success: false, error: 'Método no permitido' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};
