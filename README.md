# Multi-agent Swarm

**Version:** 1.2.1  
**Idioma de la interfaz:** español  
**Arquitectura:** interfaz web + puente HTTP + worker de IA separado.

## Componentes

- `apps/web/public`: interfaz adaptable, historial bajo demanda y panel de actividad.
- `apps/bridge`: API pública con sesiones por usuario, registro por invitación y aislamiento de tareas; reenvía las tareas al worker usando `WORKER_SHARED_SECRET`. `APP_ACCESS_KEY` solo crea el primer administrador cuando aún no hay cuentas.
- `apps/worker`: cola de tareas, agentes de arquitectura, auditoría escéptica, arbitraje, coordinación de coherencia entre archivos, desarrollo y validación.
- `apps/worker/services/store.js`: historial comprimido y cifrado con AES-256-GCM en PostgreSQL; las escrituras de consumo de tokens se serializan y deduplican transaccionalmente.
- `render.yaml`: definición inicial de los servicios separados en Render.

## Desarrollo local

Requiere Node.js 22.x (coincide con el runtime de Render y CI).

1. Copiá `apps/bridge/.env.example` a `apps/bridge/.env` y `apps/worker/.env.example` a `apps/worker/.env`.
2. Creá las bases PostgreSQL locales `swarm_accounts` y `swarm_history` (o ajustá las URLs de los ejemplos a las bases que uses).
3. Generá claves independientes con `openssl rand -hex 32`: una para `HISTORY_ENCRYPTION_KEY` y otra para `SWARM_API_ENCRYPTION_KEY`. Cada una debe tener 64 caracteres hexadecimales; copiá el mismo valor de `SWARM_API_ENCRYPTION_KEY` a bridge y worker, sin reutilizar la clave del historial.
4. Configurá el mismo `SWARM_DATABASE_URL` y `SWARM_API_ENCRYPTION_KEY` en ambos servicios, además del mismo `WORKER_SHARED_SECRET`; generá una clave distinta para `APP_ACCESS_KEY`. En el worker, configurá uno o más proveedores: `GEMINI_API_KEY`, `GROQ_API_KEY` y, opcionalmente, proveedores adicionales compatibles con OpenAI Chat Completions mediante `AI_FALLBACK_PROVIDERS`. Si un proveedor devuelve 429, un error de red o un 5xx y hay una alternativa configurada, el motor cambia a ella antes de esperar el cooldown.
5. Instalá las dependencias bloqueadas desde la raíz con `npm --prefix apps/bridge ci` y `npm --prefix apps/worker ci`.
6. Iniciá el worker y el puente en terminales separadas con `npm --prefix apps/worker start` y `npm --prefix apps/bridge start`.

Para comprobar sintaxis y ejecutar pruebas unitarias: `npm run check`.

## Salud y configuración de proveedores

- `GET /healthz` es una comprobación de vida del proceso; no confirma que PostgreSQL esté disponible.
- `GET /readyz` comprueba la conexión a PostgreSQL y, en el puente, que el worker esté configurado. Devuelve HTTP `503` si no está listo.
- En el panel de APIs, guardá primero una clave y luego usá **Probar conexión**. La verificación consulta metadatos del proveedor sin crear tareas ni generar tokens de modelo; cuando el proveedor publica un catálogo, también indica si reconoce el modelo de desarrollo configurado.
- También podés elegir **Otra API compatible con OpenAI** e indicar la URL base HTTPS pública, tu clave y el ID del modelo. El endpoint debe implementar `GET /models` para la prueba de conexión y `POST /chat/completions` para generar respuestas. El worker verifica las IP de destino en cada conexión, bloquea direcciones privadas/locales y no sigue redirecciones; no se admiten protocolos arbitrarios ni APIs que no sean compatibles con OpenAI Chat Completions.

## Variables esenciales

### Puente
- `WORKER_BASE_URL`: URL del worker.
- `WORKER_SHARED_SECRET`: secreto compartido con el worker.
- `APP_ACCESS_KEY`: clave de bootstrap para crear la cuenta `admin` solo cuando la base no tiene usuarios; luego se entra con usuario y contraseña.
- `SWARM_DATABASE_URL`: PostgreSQL para usuarios, sesiones, invitaciones, claves cifradas y propiedad de tareas.
- `SWARM_API_ENCRYPTION_KEY`: clave hexadecimal de 32 bytes para cifrar las APIs; debe ser idéntica en bridge y worker.

### Worker
- `WORKER_SHARED_SECRET`: debe coincidir con el puente.
- `GROQ_API_KEY`: clave del proveedor Groq (opcional si hay otro proveedor configurado).
- `GEMINI_API_KEY`: clave de Gemini; si está configurada, se prueba primero.
- `AI_FALLBACK_PROVIDERS`: array JSON de proveedores adicionales compatibles con OpenAI Chat Completions. Cada elemento admite `name`, `baseUrl`, `apiKeyEnv` y `model` o `models` con `reasoning`, `coding` y `validation`. Las credenciales van en variables de entorno separadas; nunca dentro del JSON. Se permiten URLs HTTPS y localhost HTTP para desarrollo. Se prueban en orden tras Gemini/Groq.
- `HISTORY_ENCRYPTION_KEY`: clave hexadecimal de 32 bytes para cifrar el historial.
- `DATABASE_URL`: URL de PostgreSQL persistente para tareas e historial del worker.
- `SWARM_DATABASE_URL`: la misma base de cuentas que usa el bridge.
- `SWARM_API_ENCRYPTION_KEY`: la misma clave de cifrado de APIs que usa el bridge.
- `DATABASE_PATH`: ruta SQLite heredada, solo para importar historial local si existe.
- `WORKER_CONCURRENCY`: tareas simultáneas (por defecto, 2).
- `MAX_TASK_TOKENS`: presupuesto acumulado por tarea (por defecto, 1.000.000; ajustable entre 4.000 y 1.000.000).
- `MAX_OUTPUT_TOKENS_PER_CALL`: máximo de salida permitido por llamada al modelo (por defecto, 6.000; cada agente puede imponer un límite inferior).

**Importante:** si se pierde `HISTORY_ENCRYPTION_KEY`, el historial cifrado no podrá recuperarse. Guardá la clave de forma segura. El historial activo se almacena en PostgreSQL; el código conserva una importación de SQLite heredada si encuentra un archivo anterior.

## Prueba E2E en producción

El flujo manual de GitHub Actions crea una tarea real y puede consumir tokens del proveedor configurado; no es una comprobación gratuita. Configurá `SWARM_ADMIN_PASSWORD` con la contraseña actual del administrador. `SWARM_APP_ACCESS_KEY` queda como alternativa solo si sigue siendo la contraseña del administrador inicial. El test inicia sesión y usa el token de sesión, no la contraseña como bearer token.

## Alcance de validación

El Coordinador de coherencia construye un mapa compartido de módulos, interfaces, dependencias y reglas antes de programar; luego audita el conjunto de archivos contra ese mapa y sus hallazgos bloquean la aprobación hasta corregirse. El panel muestra el presupuesto de tokens, el consumo de entrada/salida y el saldo estimado en directo usando el uso reportado por el proveedor.

La validación automática usa un segundo agente y revisa entregas largas por lotes delimitados por archivo. El chequeo determinista comprueba la sintaxis JavaScript como módulo ES sin ejecutar el código, valida JSON cuando detecta `package.json`, revisa referencias locales de scripts/estilos en HTML y busca señales básicas de truncamiento CSS. No equivale a una prueba de integración ni garantiza que la solución sea correcta. Si una entrega no está estructurada por archivos y no puede revisarse completa, no se aprueba automáticamente.

En el detalle de cada tarea existe un chat directo con Arquitecto, Escéptico, Árbitro, Desarrollador y Validador. Sus mensajes se guardan en la misma conversación y no crean una tarea nueva. Las correcciones automáticas seleccionan los archivos mencionados por los hallazgos, integran los cambios con la entrega previa y permiten hasta dos ciclos correctivos adicionales.


## Contabilidad y eficiencia de tokens

Cada tarea se protege con un bloqueo asesor de PostgreSQL entre procesos: si un despliegue solapado u otra instancia intenta ejecutar la misma tarea, espera en lugar de duplicar llamadas. El bloqueo se libera cuando termina el trabajo o se cierra la conexión.

El worker registra el uso reportado por el proveedor con identificador único por llamada. La escritura ocurre dentro de una transacción PostgreSQL para que el chat directo y la tarea automática no se pisen entre sí. El historial incluye totales por modelo, agente, etapa e interacción; el chat directo se separa del trabajo automático. Una respuesta automática registrada después de que la tarea ya figure como completada se marca como consumo tardío/desperdiciado, sin ocultarlo dentro del total. Las respuestas con usage ausente se cuentan como llamadas, pero no se inventan tokens. El presupuesto se basa en tokens reportados por el proveedor, no en estimaciones de caracteres.

El presupuesto de cada tanda escala automáticamente en pasos de 25.000 tokens: 25.000 por paso hasta 1.000.000. Si se agota la tanda de 1.000.000, el worker crea una nueva tanda de forma automática e idempotente, con un presupuesto nuevo de 1.000.000 tokens. La nueva tarea conserva el objetivo, la propuesta, la auditoría, la estrategia, el mapa de coherencia, los checkpoints, los archivos y la entrega parcial/completa; retoma desde la etapa pendiente en lugar de repetir las fases ya guardadas. Cada tanda reinicia su contador y conserva el consumo de las anteriores para mostrar el total acumulado. Al arrancar, el worker también recupera pausas presupuestarias que hubieran quedado pendientes si el proceso se reinició justo antes de crear la continuación.

Antes de cada llamada se estima de forma conservadora el tamaño de entrada y se reserva ese margen dentro del presupuesto disponible para limitar la salida solicitada. Los tokens reales reportados por el proveedor siguen siendo la fuente de verdad; la estimación solo sirve como guardia previa. Las revisiones siguen procesando archivos en lotes delimitados y las correcciones seleccionan los archivos citados por los hallazgos.

Los agentes cumplen roles distintos: Arquitecto propone; Escéptico intenta refutar; Árbitro decide; Coordinador define y audita contratos entre archivos; Desarrollador entrega y corrige solo lo necesario; Validador revisa de forma independiente. Los checkpoints evitan repetir las etapas que ya quedaron guardadas cuando una tarea se reanuda. Las pruebas unitarias verifican deduplicación de eventos, separación del chat y detección de respuestas tardías.


### Failover y límites de proveedores

Gemini se prueba primero cuando está configurado; luego se prueban Groq y los proveedores adicionales de `AI_FALLBACK_PROVIDERS` en el orden declarado. Los proveedores alternativos deben implementar la API compatible con OpenAI Chat Completions (`POST /chat/completions`). Para cada uno, configurá la URL base HTTPS, el nombre de la variable de entorno que contiene su clave y un modelo válido para ese proveedor. Se puede definir un modelo único o modelos separados para razonamiento, programación y validación.

Ante HTTP 408, 425, 429, 5xx o errores de red, el motor intenta la siguiente alternativa disponible en lugar de esperar primero todo el cooldown. Si todos fallan, persiste el checkpoint y programa una reanudación con backoff. No se puede cambiar automáticamente a proveedores cuyas credenciales no estén configuradas, ni evitar cuotas o límites del proveedor.
