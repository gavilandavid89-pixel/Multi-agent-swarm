# Multi-agent Swarm

**Version:** 1.2.1  
**Idioma de la interfaz:** español  
**Arquitectura:** interfaz web + puente HTTP + worker de IA separado.

## Componentes

- `apps/web/public`: interfaz adaptable, historial bajo demanda y panel de actividad.
- `apps/bridge`: API pública con sesiones por usuario, registro por invitación y aislamiento de tareas; reenvía las tareas al worker usando `WORKER_SHARED_SECRET`. `APP_ACCESS_KEY` solo crea el primer administrador cuando aún no hay cuentas.
- `apps/worker`: cola de tareas, agentes de arquitectura, auditoría escéptica, arbitraje, coordinación de coherencia entre archivos, desarrollo y validación. La imagen Docker incluye Chromium + Xvfb para comprobaciones de humo de HTML generado.
- `apps/worker/services/store.js`: historial comprimido y cifrado con AES-256-GCM en PostgreSQL; las escrituras de consumo de tokens se serializan y deduplican transaccionalmente.
- `apps/worker/services/codeChecks.js`: comprobaciones deterministas de sintaxis, rutas locales y JSON; en producción, el validador intenta abrir las entregas HTML en Chromium bajo Xvfb, con resolución DNS y proxy HTTP(S) bloqueados y un límite de 15 segundos; si el contenedor no permite ejecutar el sandbox de Chromium, lo informa y mantiene activas las comprobaciones deterministas.
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

Cada tarea tiene un tope de 1.000.000 tokens; el worker no amplía indefinidamente el presupuesto de una misma tarea. Cuando se alcanza el tope, crea automáticamente una nueva tarea de continuación con otro presupuesto de hasta 1.000.000 tokens. La transición es idempotente: una transacción bloquea la tarea origen y persiste el vínculo al hijo, evitando continuaciones duplicadas ante reintentos o reinicios. La continuación conserva el objetivo, la propuesta, la auditoría, la estrategia, el mapa de coherencia, los checkpoints, los archivos y la entrega parcial/completa; retoma desde el estado guardado en lugar de repetir las fases ya completadas. El contador de consumo es por tarea, mientras el ledger completo de tareas anteriores permite mostrar el acumulado de la cadena sin truncarlo después de 50 continuaciones. Al arrancar, el worker recupera pausas presupuestarias que hubieran quedado pendientes justo antes de crear la continuación. La interfaz sigue automáticamente la tarea hija más reciente.

Antes de cada llamada se estima de forma conservadora el tamaño de entrada y se reserva ese margen dentro del presupuesto disponible para limitar la salida solicitada. Los tokens reales reportados por el proveedor siguen siendo la fuente de verdad; la estimación solo sirve como guardia previa. Las revisiones siguen procesando archivos en lotes delimitados y las correcciones seleccionan los archivos citados por los hallazgos.

Los agentes cumplen roles distintos: Arquitecto propone; Escéptico intenta refutar; Árbitro decide; Coordinador define y audita contratos entre archivos; Desarrollador entrega y corrige solo lo necesario; Validador revisa de forma independiente. Los checkpoints evitan repetir las etapas que ya quedaron guardadas cuando una tarea se reanuda. Las pruebas unitarias verifican deduplicación de eventos, separación del chat y detección de respuestas tardías.


### Failover y límites de proveedores

Gemini se prueba primero cuando está configurado; luego se prueban Groq y los proveedores adicionales de `AI_FALLBACK_PROVIDERS` en el orden declarado. Los proveedores alternativos deben implementar la API compatible con OpenAI Chat Completions (`POST /chat/completions`). Para cada uno, configurá la URL base HTTPS, el nombre de la variable de entorno que contiene su clave y un modelo válido para ese proveedor. Se puede definir un modelo único o modelos separados para razonamiento, programación y validación.

Ante HTTP 408, 425, 429, 5xx o errores de red, el motor intenta la siguiente alternativa disponible en lugar de esperar primero todo el cooldown. Si todos fallan, persiste el checkpoint y programa una reanudación con backoff. No se puede cambiar automáticamente a proveedores cuyas credenciales no estén configuradas, ni evitar cuotas o límites del proveedor.


## Mapa de variables de producción (Render)

Este mapa documenta el destino lógico y el valor esperado de cada variable. **No se guardan contraseñas, tokens, URLs PostgreSQL con credenciales ni claves criptográficas reales en GitHub/README**: esos valores deben permanecer en Render Environment Groups/Environment. La guía describe los valores de configuración sin filtrar secretos.

### Bridge — servicio `swarm-bridge`

| Variable | Valor/destino esperado | Compartida con | Uso |
|---|---|---|---|
| `NODE_ENV` | `production` | — | Activa validaciones de producción |
| `WORKER_BASE_URL` | `https://swarm-worker-fgnz.onrender.com` (sin barra final) | — | URL pública del Worker |
| `WORKER_SHARED_SECRET` | Secreto aleatorio de al menos 32 caracteres; mismo valor que en Worker | Worker | Autenticación Bridge → Worker. No publicar el valor literal |
| `APP_ACCESS_KEY` | Secreto aleatorio distinto, mínimo 32 caracteres | — | Bootstrap del primer administrador cuando no hay cuentas; no es la contraseña normal una vez creada la cuenta |
| `SWARM_DATABASE_URL` | URL PostgreSQL de Neon, proyecto `billowing-scene-25888064`, rama de producción `br-holy-feather-b5q9c9yd`, base `swarm` | Worker | Cuentas, sesiones, invitaciones, claves API cifradas y propiedad de tareas. Mantener la URL completa privada |
| `SWARM_API_ENCRYPTION_KEY` | 64 caracteres hexadecimales (32 bytes); mismo valor exacto en Bridge y Worker | Worker | Cifrado de claves API guardadas. No reutilizar `HISTORY_ENCRYPTION_KEY` |

### Worker — servicio `swarm-worker-fgnz`

| Variable | Valor/destino esperado | Compartida con | Uso |
|---|---|---|---|
| `NODE_ENV` | `production` | — | Modo de producción |
| `PORT` | `3100` (Render puede proporcionar el puerto runtime) | — | Puerto HTTP del contenedor |
| `WORKER_SHARED_SECRET` | Mismo secreto que `swarm-bridge`, mínimo 32 caracteres | Bridge | Autenticación entre servicios |
| `DATABASE_URL` | Render PostgreSQL `comite-database`, base `comite_database` (confirmado desde el Worker; nunca publicar la URL completa) | — | Persistencia PostgreSQL de `jobs`, `job_request_idempotency` e historial cifrado |
| `HISTORY_ENCRYPTION_KEY` | 64 caracteres hexadecimales (32 bytes), clave propia | — | Cifra/descifra los payloads de tareas e historial. Perderla impide recuperar los datos cifrados |
| `SWARM_DATABASE_URL` | La misma URL Neon que Bridge: proyecto `billowing-scene-25888064`, rama `br-holy-feather-b5q9c9yd`, base `swarm` | Bridge | Acceso a cuentas y claves API administradas |
| `SWARM_API_ENCRYPTION_KEY` | Mismo valor de 64 caracteres hexadecimales que Bridge | Bridge | Descifrado de claves API almacenadas |
| `DATABASE_PATH` | `./data/swarm.sqlite` | — | Fuente SQLite heredada solo para importar datos locales si existe; no es el almacenamiento principal de producción |
| `GEMINI_API_KEY` | Clave privada de Gemini en el Worker | — | Proveedor de IA principal cuando está configurado |
| `GROQ_API_KEY` | Clave privada de Groq en el Worker | — | Proveedor alternativo |
| `AI_FALLBACK_PROVIDERS` | JSON de proveedores adicionales; credenciales en variables aparte | — | Fallback de proveedores compatibles con OpenAI Chat Completions |
| `WORKER_CONCURRENCY` | Entero entre 1 y 8; el código actual usa 1 por defecto | — | Máximo de tareas concurrentes |
| `MAX_TASK_TOKENS` | Entero entre 4.000 y 1.000.000; por defecto 1.000.000 | — | Presupuesto acumulado por tarea |
| `MAX_OUTPUT_TOKENS_PER_CALL` | Entero; el README del proyecto documenta 6.000 por defecto | — | Límite de salida por llamada |

### Estado verificado y puntos pendientes

- Render identifica el Bridge como `https://swarm-bridge.onrender.com` y el Worker como `https://swarm-worker-fgnz.onrender.com`; ambos tienen health check `/readyz`.
- Los logs del Worker registraron `[worker][storage_ready] PostgreSQL conectado; historial cifrado habilitado.` el 16 y 17 de octubre de 2026. El diagnóstico de solo lectura del 17-10-2026 confirmó que la base activa es `comite_database`, con usuario `comite_database_user`.
- La base Neon `swarm` de la rama indicada contiene tablas de cuentas. La base Neon `swarm_history` consultada no tenía tablas de usuario al momento de la revisión.
- En Render existe una instancia PostgreSQL llamada `comite-database`, base `comite_database`, usuario `comite_database_user`, estado disponible, plan Free, región Ohio y allowlist de IP vacía. El conector no pudo inspeccionar sus tablas porque Render bloquea conexiones externas con esa allowlist. El nombre por sí solo **no demuestra que sea ajena al Swarm**: el propietario indicó que “Comité” era el nombre que había elegido para la estructura/consejo de agentes. Debe evaluarse por su contenido y referencias de configuración, no por el nombre.
- La conexión efectiva de `DATABASE_URL` del Worker a `comite-database` quedó confirmada por la consulta de identidad ejecutada desde el propio Worker.
- El código del Worker crea las tablas `jobs` y `job_request_idempotency` al iniciar en la base indicada por `DATABASE_URL`. Antes de cambiarla, verificar si `comite_database` contiene datos de tareas, checkpoints o tablas del sistema de agentes y hacer una copia de seguridad si corresponde.
- **No cambiar ni borrar `comite-database` solo por el nombre.** Si resulta ser la base prevista para el Swarm, documentarla como tal y corregir este mapa. Si contiene datos compartidos o de otro sistema, no reutilizarla para el Worker sin migración planificada.
- Los valores reales de secretos y URLs con credenciales no se imprimen en este README ni se versionan. La identidad de la base se confirmó sin registrar la URL ni la contraseña.


## Hallazgos verificados de `comite-database` (17-10-2026)

- **Identidad confirmada desde el Worker:** `current_database() = comite_database`, `current_user = comite_database_user`. `DATABASE_URL` apunta a la instancia Render `comite-database`.
- **Conteos observados en la inspección:** `jobs` tenía 6 filas y `job_request_idempotency` tenía 1. Los conteos cambian con el uso normal.
- `jobs` contiene `id`, `status`, `stage`, `progress`, `attempt`, `created_at`, `updated_at`, `error` y `encrypted_payload` (`bytea` cifrado por la aplicación).
- `job_request_idempotency` contiene `idempotency_key`, `request_hash`, `job_id` y `created_at`.
- Integridad observada: claves primarias en `jobs.id` y `job_request_idempotency.idempotency_key`, unicidad en `job_request_idempotency.job_id`, e índices por creación/actualización de tareas. No se detectaron claves foráneas, vistas, secuencias ni otras tablas de usuario.
- El esquema coincide con el almacén de tareas/checkpoints del Worker. No hay tablas explícitas de integrantes, deliberaciones o votos; eso no prueba que no haya datos relacionados con el consejo dentro de payloads cifrados. No se leyeron ni descifraron filas de negocio.
- La inspección temporal fue retirada del código tras recoger los metadatos; no cambió datos ni esquema. No renombrar, vaciar, migrar ni cambiar la URL de esta base sin definir la arquitectura y verificar una copia de seguridad.

## Votación del comité sin interrumpir tareas

El botón **Iniciar votación** registra la propuesta y devuelve el control a la interfaz sin esperar los seis modelos. Los argumentos se guardan de forma incremental. Si la tarea está activa, el motor espera en el siguiente checkpoint seguro hasta que cierre la deliberación, y después continúa desde ese punto.

- La votación es consultiva: no aplica cambios ni sustituye aprobación humana para acciones de impacto.
- La interfaz permite convocarla mientras la tarea está en cola, ejecutándose o ya finalizada; una pausa por agotamiento de presupuesto requiere resolver primero el presupuesto.
- Se permite una votación activa por tarea para evitar concurrencia duplicada. Repetir la misma propuesta activa reutiliza el estado en curso; repetir una propuesta ya completada recupera el resultado guardado sin volver a consumir tokens.
- Los argumentos se guardan de forma incremental en el historial cifrado y aparecen con el sondeo del chat. La deliberación tiene un límite de 60 segundos controlado por el Worker y puede cerrar con resultado parcial si no llegan todas las respuestas. Al arrancar, el Worker cierra como parcial o fallida toda votación que seguía en curso antes del reinicio, usando los argumentos ya guardados, y limpia la marca de pausa. Así no queda una tarea esperando una votación cuyo proceso ya no existe.


## Deliberación visible del comité

La votación consultiva muestra una franja azul marino con contorno amarillo, el tema de la propuesta y un contador de hasta 60 segundos. Mientras está activa, el chat adopta una paleta azul para distinguir los mensajes del debate. El tema vuelve al aspecto normal cuando la votación termina.

- Cada argumento recibido se guarda en el payload cifrado de la tarea y en el transcript, de modo que el chat puede mostrar avances sin esperar a que terminen los seis agentes.
- El límite de tiempo se calcula y valida en el Worker, no depende del reloj del navegador. Al agotarse, el resultado se cierra con las respuestas disponibles y se marca como parcial cuando faltan agentes.
- La votación sigue siendo consultiva y no edita archivos ni aplica decisiones automáticamente. El objetivo original de la tarea continúa teniendo prioridad.
- La pausa ocurre en el siguiente checkpoint del motor, no interrumpe una llamada de IA a mitad de ejecución. La tarea conserva su checkpoint y reanuda cuando la votación termina. Hay un límite operativo de espera para evitar bloqueos indefinidos.
- La fecha límite cierra la deliberación, pero el cliente de proveedor actual no expone cancelación común para todas las APIs. Una solicitud ya enviada puede seguir terminando en el proveedor después del cierre; el sistema no debe prometer que ese cierre cancela el consumo del proveedor.
- Al iniciar el Worker, toda deliberación que seguía en curso se cierra como parcial o fallida, incluso si su plazo todavía no había vencido, porque el proceso que la atendía ya no existe. La coordinación autónoma de nuevas propuestas y la cancelación real de llamadas de proveedor siguen pendientes.

### Flujo objetivo para coordinación autónoma

1. El motor conserva el objetivo original, requisitos no negociables, archivos y último checkpoint.
2. Un agente puede proponer una decisión técnica con impacto, riesgo, coste estimado y criterios verificables.
3. Si la propuesta no bloquea el avance, el trabajo puede continuar mientras el comité delibera. Si existe un conflicto que impide avanzar, la futura integración debe pausar únicamente en un checkpoint seguro.
4. La franja informa el tipo de debate y el tiempo restante. Los argumentos y votos se guardan a medida que llegan.
5. Al cerrar el minuto, el Árbitro resume los argumentos disponibles. El resultado registra votos, fundamento, incertidumbre y pruebas requeridas; no se interpreta la mayoría como garantía de corrección.
6. Las decisiones se adjuntan como contexto estructurado a las siguientes etapas y a las tareas de continuación. El objetivo del usuario nunca se sustituye por una propuesta del comité.
7. Solo cambios de bajo riesgo, reversibles y comprobables podrán optar en el futuro a una autorización automática. Seguridad, secretos, permisos, borrado de datos, gastos, despliegues y requisitos explícitos del usuario necesitan controles reforzados o aprobación humana.

Estados de referencia para la evolución: `proposed`, `reviewing`, `approved`, `rejected`, `needs_human`, `implementing`, `validating`, `applied`, `rolled_back` y `failed`. Deben persistirse junto con el identificador de debate, propuesta, argumentos, decisión, riesgos, pruebas y resultado de validación. Las propuestas repetidas deben deduplicarse y respetar límites de frecuencia y presupuesto.
