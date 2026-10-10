# Multi-agent Swarm

**Version:** 1.2.1  
**Idioma de la interfaz:** español  
**Arquitectura:** interfaz web + puente HTTP + worker de IA separado.

## Componentes

- `apps/web/public`: interfaz adaptable, historial bajo demanda y panel de actividad.
- `apps/bridge`: API pública protegida por `APP_ACCESS_KEY`; reenvía las tareas al worker usando `WORKER_SHARED_SECRET`.
- `apps/worker`: cola de tareas, agentes de arquitectura, auditoría escéptica, arbitraje, desarrollo y validación.
- `apps/worker/services/store.js`: historial comprimido y cifrado con AES-256-GCM en SQLite.
- `render.yaml`: definición inicial de los servicios separados en Render.

## Desarrollo local

Requiere Node.js 20 o posterior.

1. Copiá `apps/bridge/.env.example` a `apps/bridge/.env` y `apps/worker/.env.example` a `apps/worker/.env`.
2. Generá secretos únicos. Para el cifrado: `openssl rand -hex 32`. `HISTORY_ENCRYPTION_KEY` debe ser exactamente 64 caracteres hexadecimales.
3. Configurá el mismo `WORKER_SHARED_SECRET` en ambos servicios. Configurá una clave distinta para `APP_ACCESS_KEY`.
4. En el worker, agregá `GROQ_API_KEY`. La aplicación usa Groq como proveedor de modelos.
5. Instalá dependencias desde la raíz con `npm --prefix apps/bridge install` y `npm --prefix apps/worker install`.
6. Iniciá el worker y el puente en terminales separadas con `npm --prefix apps/worker start` y `npm --prefix apps/bridge start`.

Para comprobar sintaxis y ejecutar pruebas unitarias: `npm run check`.

## Variables esenciales

### Puente
- `WORKER_BASE_URL`: URL del worker.
- `WORKER_SHARED_SECRET`: secreto compartido con el worker.
- `APP_ACCESS_KEY`: clave de acceso al panel.

### Worker
- `WORKER_SHARED_SECRET`: debe coincidir con el puente.
- `GROQ_API_KEY`: clave del proveedor.
- `HISTORY_ENCRYPTION_KEY`: clave hexadecimal de 32 bytes para cifrar el historial.
- `DATABASE_PATH`: ruta del archivo SQLite.
- `WORKER_CONCURRENCY`: tareas simultáneas (por defecto, 2).

**Importante:** si se pierde `HISTORY_ENCRYPTION_KEY`, el historial cifrado no podrá recuperarse. Guardá la clave de forma segura. SQLite está pensado para una sola instancia de worker; para persistencia real en Render se necesita un disco persistente o adaptar el almacenamiento a una base de datos externa. El sistema de archivos de un servicio gratuito puede ser efímero.

## Alcance de validación

La validación automática usa un segundo agente y, si la entrega contiene bloques JavaScript delimitados, ejecuta `node --check` sin ejecutar ese código. No equivale a una prueba de integración ni garantiza que la solución sea correcta. Los resultados sin bloques JavaScript se identifican como revisión de IA únicamente.
