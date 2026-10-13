# Multi-agent Swarm

**Version:** 1.2.1  
**Idioma de la interfaz:** español  
**Arquitectura:** interfaz web + puente HTTP + worker de IA separado.

## Componentes

- `apps/web/public`: interfaz adaptable, historial bajo demanda y panel de actividad.
- `apps/bridge`: API pública protegida por `APP_ACCESS_KEY`; reenvía las tareas al worker usando `WORKER_SHARED_SECRET`.
- `apps/worker`: cola de tareas, agentes de arquitectura, auditoría escéptica, arbitraje, coordinación de coherencia entre archivos, desarrollo y validación.
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
- `MAX_TASK_TOKENS`: presupuesto acumulado por tarea (por defecto, 50.000; ajustable entre 4.000 y 100.000).
- `MAX_OUTPUT_TOKENS_PER_CALL`: máximo de salida permitido por llamada al modelo (por defecto, 6.000; cada agente puede imponer un límite inferior).

**Importante:** si se pierde `HISTORY_ENCRYPTION_KEY`, el historial cifrado no podrá recuperarse. Guardá la clave de forma segura. SQLite está pensado para una sola instancia de worker; para persistencia real en Render se necesita un disco persistente o adaptar el almacenamiento a una base de datos externa. El sistema de archivos de un servicio gratuito puede ser efímero.

## Alcance de validación

El Coordinador de coherencia construye un mapa compartido de módulos, interfaces, dependencias y reglas antes de programar; luego audita el conjunto de archivos contra ese mapa y sus hallazgos bloquean la aprobación hasta corregirse. El panel muestra el presupuesto de tokens, el consumo de entrada/salida y el saldo estimado en directo usando el uso reportado por el proveedor.

La validación automática usa un segundo agente y revisa entregas largas por lotes delimitados por archivo. El chequeo determinista comprueba la sintaxis JavaScript como módulo ES sin ejecutar el código, valida JSON cuando detecta `package.json`, revisa referencias locales de scripts/estilos en HTML y busca señales básicas de truncamiento CSS. No equivale a una prueba de integración ni garantiza que la solución sea correcta. Si una entrega no está estructurada por archivos y no puede revisarse completa, no se aprueba automáticamente.

En el detalle de cada tarea existe un chat directo con Arquitecto, Escéptico, Árbitro, Desarrollador y Validador. Sus mensajes se guardan en la misma conversación y no crean una tarea nueva. Las correcciones automáticas seleccionan los archivos mencionados por los hallazgos, integran los cambios con la entrega previa y permiten hasta dos ciclos correctivos adicionales.
