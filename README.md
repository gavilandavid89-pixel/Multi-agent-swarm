# Multi-agent Swarm

**Version:** 1.2.1  
**Idioma de la interfaz:** español  
**Arquitectura:** interfaz web + puente HTTP + worker de IA separado.

## Componentes

- `apps/web/public`: interfaz adaptable, historial bajo demanda y panel de actividad.
- `apps/bridge`: inicio de sesión por usuario, alta mediante invitación de un solo uso, sesiones revocables y autorización por dueño de tarea. `APP_ACCESS_KEY` solo habilita el primer inicio de sesión del administrador cuando todavía no hay usuarios; no es un token para las solicitudes normales.
- `apps/worker`: cola de tareas, agentes de arquitectura, auditoría escéptica, arbitraje, coordinación de coherencia entre archivos, desarrollo y validación.
- `apps/worker/services/store.js`: tareas, checkpoints, historial y artefactos cifrados con AES-256-GCM en PostgreSQL; las escrituras de consumo de tokens se serializan y deduplican transaccionalmente.
- `apps/bridge/services/accountStore.js` y `apps/worker/services/userProviders.js`: cuentas aisladas, credenciales de proveedor cifradas y ejecución con las APIs de la cuenta propietaria.
- `render.yaml`: definición inicial de los servicios separados en Render.

## Desarrollo local

Requiere Node.js 20 o posterior.

1. Copiá `apps/bridge/.env.example` a `apps/bridge/.env` y `apps/worker/.env.example` a `apps/worker/.env`.
2. Generá secretos únicos: `openssl rand -hex 32`. `HISTORY_ENCRYPTION_KEY` y `SWARM_API_ENCRYPTION_KEY` deben ser valores hexadecimales distintos de 64 caracteres. Usá la misma `SWARM_API_ENCRYPTION_KEY` en puente y worker, porque ambos cifran/descifran las claves privadas de usuario.
3. Configurá el mismo `WORKER_SHARED_SECRET` en ambos servicios. Usá una clave diferente para `APP_ACCESS_KEY`, `HISTORY_ENCRYPTION_KEY` y `SWARM_API_ENCRYPTION_KEY`.
4. Para el uso normal, iniciá sesión como `admin` y agregá en `API 🔐` las claves propias de la cuenta. Elegí proveedor y modelos de razonamiento, desarrollo y validación; las claves se cifran y no vuelven a mostrarse. Las variables antiguas `GEMINI_API_KEY`, `GROQ_API_KEY` y `AI_FALLBACK_PROVIDERS` se conservan para importar proveedores heredados al administrador durante su primer inicio de sesión con el nuevo sistema.
5. Instalá dependencias desde la raíz con `npm --prefix apps/bridge install` y `npm --prefix apps/worker install`.
6. Iniciá el worker y el puente en terminales separadas con `npm --prefix apps/worker start` y `npm --prefix apps/bridge start`.

Para comprobar sintaxis y ejecutar las pruebas unitarias: `npm run check`. La prueba en vivo de punta a punta es independiente y se activa manualmente desde GitHub Actions; necesita el secreto `SWARM_APP_ACCESS_KEY`, la URL de la web activa y disponibilidad de un proveedor para generar una tarea real.

## Variables esenciales

### Puente
- `WORKER_BASE_URL`: URL del worker.
- `WORKER_SHARED_SECRET`: secreto compartido con el worker.
- `APP_ACCESS_KEY`: contraseña inicial del administrador, solo cuando `SWARM_DATABASE_URL` todavía no contiene ninguna cuenta. Tras el bootstrap, las rutas privadas requieren una sesión Bearer; la clave compartida no sustituye esa sesión.
- `SWARM_DATABASE_URL`: PostgreSQL independiente para usuarios, sesiones, invitaciones, APIs cifradas y propiedad de tareas.
- `SWARM_API_ENCRYPTION_KEY`: clave AES-256 de 32 bytes en hex; debe coincidir entre puente y worker.

### Worker
- `WORKER_SHARED_SECRET`: debe coincidir con el puente.
- `GROQ_API_KEY`: clave del proveedor Groq (opcional si hay otro proveedor configurado).
- `GEMINI_API_KEY`: clave de Gemini; si está configurada, se prueba primero.
- `AI_FALLBACK_PROVIDERS`: array JSON de proveedores adicionales compatibles con OpenAI Chat Completions. Cada elemento admite `name`, `baseUrl`, `apiKeyEnv` y `model` o `models` con `reasoning`, `coding` y `validation`. Las credenciales van en variables de entorno separadas; nunca dentro del JSON. Se permiten URLs HTTPS y localhost HTTP para desarrollo. Se prueban en orden tras Gemini/Groq.
- `HISTORY_ENCRYPTION_KEY`: clave hexadecimal de 32 bytes para cifrar el historial.
- `DATABASE_URL`: URL de PostgreSQL persistente para las tareas, checkpoints, historial y artefactos cifrados.
- `SWARM_DATABASE_URL`: conexión a la base de cuentas separada que también se configura en el puente.
- `SWARM_API_ENCRYPTION_KEY`: misma clave hex de 64 caracteres configurada en el puente; cifra las APIs que pertenecen a cada cuenta.
- `DATABASE_PATH`: ruta SQLite heredada, solo para importar historial local si existe.
- `WORKER_CONCURRENCY`: tareas simultáneas (por defecto, 1; ajustá con cuidado según los límites del plan y los proveedores).
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

El presupuesto de cada tanda escala automáticamente en pasos de 25.000 tokens: 50.000 → 75.000 → 100.000. Si se agota la tanda de 100.000, el worker crea una nueva tanda de forma automática e idempotente. La nueva tarea conserva el objetivo, la propuesta, la auditoría, la estrategia, el mapa de coherencia, los checkpoints, los archivos y la entrega parcial/completa; retoma desde la etapa pendiente en lugar de repetir las fases ya guardadas. Cada tanda reinicia su contador y conserva el consumo de las anteriores para mostrar el total acumulado. Al arrancar, el worker también recupera pausas presupuestarias que hubieran quedado pendientes si el proceso se reinició justo antes de crear la continuación.

Antes de cada llamada se estima de forma conservadora el tamaño de entrada y se reserva ese margen dentro del presupuesto disponible para limitar la salida solicitada. Los tokens reales reportados por el proveedor siguen siendo la fuente de verdad; la estimación solo sirve como guardia previa. Las revisiones siguen procesando archivos en lotes delimitados y las correcciones seleccionan los archivos citados por los hallazgos.

Los agentes cumplen roles distintos: Arquitecto propone; Escéptico intenta refutar; Árbitro decide; Coordinador define y audita contratos entre archivos; Desarrollador entrega y corrige solo lo necesario; Validador revisa de forma independiente. Los checkpoints evitan repetir las etapas que ya quedaron guardadas cuando una tarea se reanuda. Las pruebas unitarias verifican deduplicación de eventos, separación del chat y detección de respuestas tardías.


### Failover y límites de proveedores

Para tareas de usuarios, el orden de failover sigue el orden de sus APIs guardadas en `API 🔐`, incluyendo Gemini y proveedores compatibles con OpenAI Chat Completions. Para la configuración heredada de entorno, Gemini se prueba primero cuando está configurado; luego se prueban Groq y los proveedores adicionales de `AI_FALLBACK_PROVIDERS` en el orden declarado. Los proveedores alternativos deben implementar la API compatible con OpenAI Chat Completions (`POST /chat/completions`). Para cada uno, configurá la URL base HTTPS, el nombre de la variable de entorno que contiene su clave y un modelo válido para ese proveedor. Se puede definir un modelo único o modelos separados para razonamiento, programación y validación.

Ante HTTP 408, 425, 429, 5xx o errores de red, el motor intenta la siguiente alternativa disponible en lugar de esperar primero todo el cooldown. Si todos fallan, persiste el checkpoint y programa una reanudación con backoff. No se puede cambiar automáticamente a proveedores cuyas credenciales no estén configuradas, ni evitar cuotas o límites del proveedor.
