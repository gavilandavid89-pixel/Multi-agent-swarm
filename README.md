# Multi-agent Swarm

**Version:** 1.2.1  
**Idioma de la interfaz:** español  
**Arquitectura:** interfaz web + puente HTTP + worker de IA separado.

## Componentes

- `apps/web/public`: interfaz adaptable, historial bajo demanda y panel de actividad.
- `apps/bridge`: API pública protegida por `APP_ACCESS_KEY`; reenvía las tareas al worker usando `WORKER_SHARED_SECRET`.
- `apps/worker`: cola de tareas, agentes de arquitectura, auditoría escéptica, arbitraje, coordinación de coherencia entre archivos, desarrollo y validación.
- `apps/worker/services/store.js`: historial comprimido y cifrado con AES-256-GCM en PostgreSQL; las escrituras de consumo de tokens se serializan y deduplican transaccionalmente.
- `render.yaml`: definición inicial de los servicios separados en Render.

## Desarrollo local

Requiere Node.js 20 o posterior.

1. Copiá `apps/bridge/.env.example` a `apps/bridge/.env` y `apps/worker/.env.example` a `apps/worker/.env`.
2. Generá secretos únicos. Para el cifrado: `openssl rand -hex 32`. `HISTORY_ENCRYPTION_KEY` debe ser exactamente 64 caracteres hexadecimales.
3. Configurá el mismo `WORKER_SHARED_SECRET` en ambos servicios. Configurá una clave distinta para `APP_ACCESS_KEY`.
4. En el worker, configurá `GROQ_API_KEY` y, opcionalmente, `GEMINI_API_KEY`. Si Gemini responde con un 429 de espera excesiva y Groq está configurado, el motor intenta cambiar de proveedor.
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
- `DATABASE_URL`: URL de PostgreSQL persistente.
- `DATABASE_PATH`: ruta SQLite heredada, solo para importar historial local si existe.
- `WORKER_CONCURRENCY`: tareas simultáneas (por defecto, 2).
- `MAX_TASK_TOKENS`: presupuesto acumulado por tarea (por defecto, 50.000; ajustable entre 4.000 y 100.000).
- `MAX_OUTPUT_TOKENS_PER_CALL`: máximo de salida permitido por llamada al modelo (por defecto, 6.000; cada agente puede imponer un límite inferior).

**Importante:** si se pierde `HISTORY_ENCRYPTION_KEY`, el historial cifrado no podrá recuperarse. Guardá la clave de forma segura. El historial activo se almacena en PostgreSQL; el código conserva una importación de SQLite heredada si encuentra un archivo anterior.

## Alcance de validación

El Coordinador de coherencia construye un mapa compartido de módulos, interfaces, dependencias y reglas antes de programar; luego audita el conjunto de archivos contra ese mapa y sus hallazgos bloquean la aprobación hasta corregirse. El panel muestra el presupuesto de tokens, el consumo de entrada/salida y el saldo estimado en directo usando el uso reportado por el proveedor.

La validación automática usa un segundo agente y revisa entregas largas por lotes delimitados por archivo. El chequeo determinista comprueba la sintaxis JavaScript como módulo ES sin ejecutar el código, valida JSON cuando detecta `package.json`, revisa referencias locales de scripts/estilos en HTML y busca señales básicas de truncamiento CSS. No equivale a una prueba de integración ni garantiza que la solución sea correcta. Si una entrega no está estructurada por archivos y no puede revisarse completa, no se aprueba automáticamente.

En el detalle de cada tarea existe un chat directo con Arquitecto, Escéptico, Árbitro, Desarrollador y Validador. Sus mensajes se guardan en la misma conversación y no crean una tarea nueva. Las correcciones automáticas seleccionan los archivos mencionados por los hallazgos, integran los cambios con la entrega previa y permiten hasta dos ciclos correctivos adicionales.


## Contabilidad y eficiencia de tokens

Cada tarea se protege con un bloqueo asesor de PostgreSQL entre procesos: si un despliegue solapado u otra instancia intenta ejecutar la misma tarea, espera en lugar de duplicar llamadas. El bloqueo se libera cuando termina el trabajo o se cierra la conexión.

El worker registra el uso reportado por el proveedor con identificador único por llamada. La escritura ocurre dentro de una transacción PostgreSQL para que el chat directo y la tarea automática no se pisen entre sí. El historial incluye totales por modelo, agente, etapa e interacción; el chat directo se separa del trabajo automático. Una respuesta automática registrada después de que la tarea ya figure como completada se marca como consumo tardío/desperdiciado, sin ocultarlo dentro del total. Las respuestas con usage ausente se cuentan como llamadas, pero no se inventan tokens. El presupuesto se basa en tokens reportados por el proveedor, no en estimaciones de caracteres.

Cuando una tarea queda pausada por alcanzar su presupuesto, el panel permite abrir una nueva tanda independiente de 100.000 tokens. La nueva tarea conserva el objetivo, la propuesta, la auditoría, la estrategia, el mapa de coherencia, los checkpoints, los archivos y la entrega parcial/completa; retoma desde la etapa pendiente en lugar de repetir las fases ya guardadas. Cada tanda reinicia su contador y conserva el consumo de las anteriores para mostrar el total acumulado. La creación es idempotente: varios clics sobre la misma tarea devuelven la misma continuación, no crean tareas duplicadas.

Antes de cada llamada se estima de forma conservadora el tamaño de entrada y se reserva ese margen dentro del presupuesto disponible para limitar la salida solicitada. Los tokens reales reportados por el proveedor siguen siendo la fuente de verdad; la estimación solo sirve como guardia previa. Las revisiones siguen procesando archivos en lotes delimitados y las correcciones seleccionan los archivos citados por los hallazgos.

Los agentes cumplen roles distintos: Arquitecto propone; Escéptico intenta refutar; Árbitro decide; Coordinador define y audita contratos entre archivos; Desarrollador entrega y corrige solo lo necesario; Validador revisa de forma independiente. Los checkpoints evitan repetir las etapas que ya quedaron guardadas cuando una tarea se reanuda. Las pruebas unitarias verifican deduplicación de eventos, separación del chat y detección de respuestas tardías.
