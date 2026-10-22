# Proxy de datos (Railway o Vercel)

La red de la empresa bloquea el puerto 27017 de MongoDB, así que PendientesCROD
no se conecta directo a Atlas: todas las operaciones pasan por este proxy por
HTTPS (puerto 443). El mismo repositorio sirve para los dos servicios:

- **Railway** (recomendado): ejecuta `npm start` → `server.js`, un servidor
  siempre encendido. Cobra por recursos, no por petición, así que la app puede
  consultar cambios cada 2 s.
- **Vercel**: usa `api/data.js` como función. Cada consulta es una invocación
  (Hobby: 1 millón al mes), por eso no alcanza para 6 equipos consultando seguido.

Toda la lógica está en `api/data.js`; `server.js` solo la expone como servidor
HTTP normal (agrega `/health`, gzip, límite de 10 MB y keep-alive de 65 s).

## Desplegar en Railway

1. Sube `api/data.js`, `server.js` y `package.json` al repositorio del proxy
   (el mismo que usa Vercel).
2. En Railway: **New Project → Deploy from GitHub repo** y elige ese repositorio.
   Si el proxy está en una subcarpeta, indícala en **Settings → Root Directory**.
3. En **Variables** define:
   - `MONGODB_URI`: la URI de Atlas con la base al final, por ejemplo
     `mongodb+srv://usuario:contraseña@cluster0.xxxx.mongodb.net/taskdb?retryWrites=true&w=majority`.
   - `PROXY_API_KEY`: una clave larga y aleatoria (mínimo 16 caracteres). Para
     generarla: `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
   `PORT` lo asigna Railway; no hace falta definirlo.
4. Opcional: en **Settings → Deploy → Healthcheck Path** pon `/health`.
5. En **Settings → Networking → Generate Domain** obtén la URL pública
   (`https://...up.railway.app`).
6. En **Settings → Region** elige la región más cercana al clúster de Atlas.
7. En cada equipo, abre PendientesCROD → **Base de datos**, pega la URL de
   Railway e ingresa la clave. Se guarda cifrada con la protección de Windows.

Sin `PROXY_API_KEY` el proxy rechaza todas las peticiones (`401`).

## Pasar de Vercel a Railway sin cortes

Deja Vercel funcionando mientras cambias la URL equipo por equipo. Cuando todos
usen Railway, elimina las variables `MONGODB_URI` y `PROXY_API_KEY` del proyecto
de Vercel (o el proyecto completo): mientras existan, la misma clave abre los dos
servicios.

## Costo estimado en Railway Hobby

Para 6 equipos abiertos las 24 horas consultando cada 2 s: ~0.1 GB de memoria
(~1 USD), CPU casi inactiva (~0.2–0.6 USD) y algunos GB de tráfico de salida
(~0.5–1 USD). Queda dentro de los 5 USD de consumo incluidos en el plan. El
tráfico crece si alguna colección (por ejemplo el historial) se vuelve muy
grande, porque se descarga completa cada vez que cambia.

En Atlas → **Network Access** hay que permitir `0.0.0.0/0`: ni Railway Hobby ni
Vercel Hobby tienen IP fijas.

## Acciones

Todas por `POST /api/data` con el encabezado `x-api-key` y un JSON
`{"action": ...}`. Los documentos viajan en Extended JSON (EJSON).

| Acción | Uso |
| --- | --- |
| `ping` | Prueba de conexión. |
| `state` | Lee las colecciones. Con `known` (versión por colección) solo devuelve las que cambiaron. |
| `apply` | Guarda cambios (`upsert` con `$set` por campo y `__unset`, `delete`) en una transacción. |
| `ticket` | Asigna el siguiente ticket `RepDDMMYY-NN` de forma atómica. |
| `stats` | Conteo de documentos y almacenamiento (`dbStats`). |
| `export` | Página de una colección para el backup (`skip`, `limit` hasta 1000). |
| `merge` | Combina documentos de un backup; las secuencias de tickets nunca retroceden. |

`GET /api/data?coleccion=nombre` (con la clave) sigue disponible para revisar
hasta 50 documentos de una colección permitida. `GET /health` (solo en
`server.js`) responde sin clave y sin tocar la base.

Cada escritura incrementa el contador de `app_estado` (global y por colección).
Los cambios hechos directamente en Atlas (Compass, consola web) no lo
incrementan: la app los verá al reiniciarse o con la siguiente escritura en esa
colección.
