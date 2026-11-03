# Guía técnica: web, chat, tareas, servicios y secretos

> Documento operativo para el repositorio `gavilandavid89-pixel/Multi-agent-swarm`. Describe la arquitectura observada en el código y la configuración documentada. No contiene valores secretos reales. Revisar este archivo tras cambios de arquitectura.

## 1. Mapa rápido

- **Web / interfaz:** `apps/web/public/index.html`, `app.js`, `styles.css`. Se sirve como archivos estáticos desde el Bridge.
- **Bridge HTTP:** `apps/bridge/server.js`. Es el punto de entrada del navegador: autentica usuarios, aplica autorización, sirve la web y reenvía operaciones al Worker.
- **Worker de IA:** `apps/worker/server.js` y `services/multiAiEngine.js`. Gestiona cola, estado de tareas, agentes, conversaciones por tarea, proveedores de modelos, artefactos y persistencia.
- **Datos de cuentas:** PostgreSQL indicado por `SWARM_DATABASE_URL`, compartido por Bridge y Worker.
- **Datos de tareas/historial:** PostgreSQL indicado por `DATABASE_URL` en Worker. El historial/payloads se cifran con `HISTORY_ENCRYPTION_KEY`.
- **Claves de proveedores por usuario:** se guardan cifradas usando `SWARM_API_ENCRYPTION_KEY`, la misma en Bridge y Worker.
- **Runner aislado opcional:** `apps/runner-api`. No se debe asumir que está conectado en producción: si `AGENT_RUNNER_BASE_URL` está vacío, el Worker omite la ejecución remota y usa sus chequeos deterministas.
- **Desktop viewer:** proyecto separado dentro del mismo repositorio y con servicios Render separados; no es la interfaz web principal.
- **Pril y otras webs:** repositorios/servicios separados. No comparten automáticamente cuentas, sesiones, base de datos ni secretos con Multi-agent Swarm.

## 2. Flujo de una petición

```text
Navegador
  │ HTTPS: HTML/CSS/JS y /api/*
  ▼
swarm-bridge (apps/bridge; URL pública de la web)
  ├─ sirve apps/web/public
  ├─ autentica sesión y valida permisos/propiedad
  ├─ consulta PostgreSQL de cuentas (SWARM_DATABASE_URL)
  └─ HTTP interno firmado con WORKER_SHARED_SECRET
       ▼
swarm-worker (apps/worker)
  ├─ cola y ejecuta la tarea
  ├─ llama a Gemini/Groq/proveedores alternativos
  ├─ opcionalmente llama al Runner aislado
  └─ guarda tarea, checkpoints, historial y artefactos
       ▼
PostgreSQL de tareas (DATABASE_URL) + PostgreSQL de cuentas (SWARM_DATABASE_URL)
```

El navegador **no debería conectarse directamente** a PostgreSQL ni recibir secretos de proveedor. El navegador envía peticiones a rutas relativas como `/api/jobs`; esas rutas las atiende el Bridge en el mismo origen de la web. El Bridge es quien habla con el Worker a través de rutas internas protegidas por el encabezado `x-swarm-bridge-secret`.

## 3. Qué es un chat y qué es una tarea

En el diseño actual, el chat de agentes está **asociado a una tarea**:

- Crear una tarea con `POST /api/jobs` inicia un objetivo de trabajo y crea el registro/estado que administra el Worker.
- La conversación global de esa tarea y las respuestas directas a agentes se guardan dentro del historial asociado a esa tarea.
- `POST /api/jobs/:id/reply` envía un mensaje a un agente (por ejemplo Arquitecto, Escéptico, Árbitro, Desarrollador o Validador) dentro de la tarea existente; no es un chat independiente global.
- `GET /api/jobs/:id/history` recupera la conversación/historial de una tarea.
- `GET /api/jobs` lista tareas del usuario, y `GET /api/history` es un resumen/historial administrativo, no una lista de conversaciones personales independientes estilo ChatGPT.
- Reintentar una tarea usa `POST /api/jobs/:id/retry`; la continuación por presupuesto usa `POST /api/jobs/:id/continue-budget` o el flujo interno automático. Las continuaciones conservan checkpoints y referencias a la tarea anterior.

### Si queremos chats independientes tipo ChatGPT

No basta con cambiar la interfaz. Conviene añadir un recurso de dominio propio, por ejemplo `conversations`:

1. Tabla `conversations`: id, owner_user_id, title, created_at, updated_at, archived_at.
2. Tabla `conversation_messages`: id, conversation_id, role/agent, content, metadata, created_at; límites de tamaño y política de retención.
3. Añadir endpoints autenticados: `GET/POST /api/chats`, `GET /api/chats/:id`, `POST /api/chats/:id/messages`, `PATCH /api/chats/:id` (renombrar/archivar) y `DELETE` si se decide permitirlo.
4. Todas las consultas deben verificar que `owner_user_id` coincide con el usuario autenticado; no confiar en un id enviado por el navegador.
5. Mantener separado el chat normal de la ejecución de tareas. Un botón “Comenzar tarea” puede crear una tarea desde un chat, copiando explícitamente objetivo/contexto necesario, pero sin convertir cada mensaje normal en una tarea de agentes.
6. Definir si los chats normales pueden invocar agentes y proveedores de IA, cómo se asignan los tokens, límites de uso, borrado y retención.
7. Migrar sin romper el historial de tareas existente. El historial de tareas debe seguir siendo una vista diferente.

**Importante:** esta tabla describe una mejora propuesta, no una función que ya esté implementada.

## 4. Rutas HTTP principales

Las rutas exactas deben verificarse en `apps/bridge/server.js` y `apps/worker/server.js` al hacer cambios.

### Acceso y cuenta (Bridge)

- `GET /api/auth/bootstrap-status`: informa si el bootstrap inicial sigue disponible.
- `POST /api/auth/validate-invite`, `POST /api/auth/register`: invitación y registro.
- `POST /api/auth/login`, `POST /api/auth/key-login`, `POST /api/auth/logout`: sesión.
- `GET /api/account`, `GET /api/account/key`, `PATCH /api/account/password`: cuenta y credenciales de acceso.
- `GET/PUT/DELETE /api/account/apis` y `POST /api/account/apis/:slot/test`: administrar y probar claves API por usuario.
- `POST /api/admin/invites`, `GET /api/admin/users`, `PATCH /api/admin/users/:userId/status`: operaciones administrativas.
- `GET /api/access-check`: comprobar la sesión.

### Tareas, chat de tarea y archivos (Bridge → Worker)

- `GET /api/jobs`, `POST /api/jobs`, `GET /api/jobs/:id`: listar, crear y consultar tareas.
- `GET /api/events`: stream de eventos de tarea (fetch/SSE compatible con autenticación).
- `POST /api/jobs/:id/reply`: mensaje dirigido a un agente en la tarea.
- `GET /api/jobs/:id/history`: historial/conversación de la tarea.
- `POST /api/jobs/:id/retry`: reintentar.
- `POST /api/jobs/:id/budget`, `POST /api/jobs/:id/continue-budget`: presupuesto y continuación.
- `POST /api/jobs/:id/vote-improvement`: votación de mejora.
- `GET /api/jobs/:id/files`, `GET /api/jobs/:id/files/:index`, `GET /api/jobs/:id/bundle`: artefactos y paquete.
- `POST /api/jobs/:id/preview-session`, `GET /preview/:token/:index`: vista previa aislada de archivos HTML.
- `POST /api/preview-zip`: sesión de vista previa para un ZIP subido.
- `GET /api/history`: resumen de historial (el Bridge limita esta ruta según el rol).

### Salud

- `GET /healthz`: el proceso responde; **no** demuestra por sí solo que todas las dependencias estén listas.
- `GET /readyz`: readiness; Bridge revisa PostgreSQL y configuración del Worker; Worker revisa su almacenamiento.
- Las rutas `/internal/*` del Worker no son API pública para el navegador. Requieren el secreto compartido entre Bridge y Worker.

## 5. Variables y secretos

Configurar los valores reales en **Render → Environment** (o en un gestor de secretos), no en el código ni en este documento. Los ejemplos `.env.example` solo llevan marcadores de posición. No pegues valores reales en chats, tickets, commits o capturas.

### Bridge — servicio `swarm-bridge`

| Variable | Qué apunta / para qué sirve | Regla |
|---|---|---|
| `NODE_ENV` | Modo de ejecución; producción usa `production`. | No es un secreto. |
| `PORT` | Puerto HTTP del proceso; normalmente Render lo inyecta. | No es un secreto. |
| `WORKER_BASE_URL` | URL base del Worker, sin barra final. En la configuración conocida: `https://swarm-worker-fgnz.onrender.com`. | Debe apuntar al Worker correcto. |
| `WORKER_SHARED_SECRET` | Autentica Bridge → Worker mediante encabezado interno. | Secreto aleatorio de 32+ caracteres; debe coincidir exactamente en ambos servicios. |
| `APP_ACCESS_KEY` | Clave de bootstrap para crear el primer administrador si aún no hay cuentas. | Distinta de los demás secretos; no es la contraseña de acceso normal después del bootstrap. |
| `SWARM_DATABASE_URL` | PostgreSQL de cuentas, sesiones, invitaciones, claves API cifradas y propiedad de tareas. | URL completa contiene credenciales; privada. |
| `SWARM_API_ENCRYPTION_KEY` | Cifra/descifra las claves API guardadas por usuario. | 64 caracteres hexadecimales (32 bytes), misma clave en Bridge y Worker. No reutilizar la clave del historial. |
| `SHUTDOWN_GRACE_MS` | Tiempo de cierre gradual cuando está configurado. | Opcional; revisar el valor por defecto en código. |

### Worker — servicio `swarm-worker`

| Variable | Qué apunta / para qué sirve | Regla |
|---|---|---|
| `NODE_ENV`, `PORT` | Modo y puerto HTTP del Worker. | No son secretos. |
| `WORKER_SHARED_SECRET` | Verifica peticiones internas procedentes del Bridge. | Igual al Bridge; 32+ caracteres. |
| `DATABASE_URL` | PostgreSQL persistente para jobs, idempotencia, checkpoints e historial/payloads de tareas. La configuración documentada apunta a la base de producción `comite_database`. | URL privada; hacer backup antes de cambiarla. |
| `HISTORY_ENCRYPTION_KEY` | Clave de cifrado de historial y payloads. | 64 caracteres hexadecimales (32 bytes); única y respaldada de forma segura. Perderla puede hacer irrecuperables los datos cifrados. |
| `SWARM_DATABASE_URL` | Misma base de cuentas que usa el Bridge. | Debe coincidir con Bridge. |
| `SWARM_API_ENCRYPTION_KEY` | Descifra las claves API de usuario. | Debe coincidir exactamente con Bridge. |
| `GEMINI_API_KEY` | Credencial privada del proveedor Gemini. | Mantener en Worker, nunca en JS del navegador. |
| `GROQ_API_KEY` | Credencial privada de Groq; proveedor alternativo según configuración. | Mantener en Worker. |
| `AI_FALLBACK_PROVIDERS` | JSON que declara proveedores alternativos compatibles con OpenAI Chat Completions: nombre, base URL, variable que contiene la clave y modelos. | No incluir claves dentro del JSON; usar variables separadas como `ALT_API_KEY`. |
| `WORKER_CONCURRENCY` | Límite de tareas concurrentes; el código actual limita entre 1 y 8. | Cambiar con cautela; más concurrencia puede elevar consumo de RAM y cuotas. |
| `MAX_TASK_TOKENS` | Presupuesto acumulado por tarea (por defecto documentado: 1.000.000). | Ajustar con límites de coste. |
| `MAX_OUTPUT_TOKENS_PER_CALL` | Máximo de salida por llamada (por defecto documentado: 6.000). | Ajustar con límites de coste. |
| `DATABASE_PATH` | Ruta SQLite heredada para importar datos locales si existe. No es el almacenamiento principal documentado en producción. | No confundir con `DATABASE_URL`. |
| `AGENT_RUNNER_BASE_URL` | URL del Runner aislado opcional. Si está vacía, se omite la ejecución remota. | No activarla hasta validar red privada, firewall y host aislado. |
| `AGENT_RUNNER_SHARED_SECRET` | Secreto entre Worker y Runner. | Coincide con `RUNNER_SHARED_SECRET`; distinto de `WORKER_SHARED_SECRET`. |
| `AGENT_RUNNER_REQUIRED` | Si es `true`, el Runner debe estar disponible para aprobar la tarea. | Mantener `false` hasta validar completamente el Runner. |
| `SHUTDOWN_GRACE_MS` | Tiempo de cierre gradual del Worker. | Opcional. |

### Runner aislado (host separado, no asumir que está desplegado)

- `RUNNER_SHARED_SECRET`: autentica al Worker; debe coincidir con `AGENT_RUNNER_SHARED_SECRET`.
- `RUNNER_BIND_HOST`: por defecto `127.0.0.1`; no exponer en Internet. Usar interfaz privada solo con firewall.
- `PORT`: puerto de API, documentado por defecto como `3200`.
- `RUNNER_STATE_DIR`: estado persistente, por defecto `/var/lib/swarm-runner`.
- `RUNNER_CONCURRENCY`: mantener en `1` según la guía actual hasta que cada job tenga aislamiento de red propio.
- `RUNNER_DOCKER_BIN`: ruta al cliente Docker si no está en PATH.
- `SWARM_RUNNER_IMAGE`: imagen preconstruida permitida; el agente no debe poder elegir imágenes arbitrarias.

### Proveedores alternativos

Cada proveedor alternativo puede declarar `name`, `baseUrl`, `apiKeyEnv` y `model` o `models` (`reasoning`, `coding`, `validation`). El nombre de `apiKeyEnv` se refiere a una variable de entorno aparte. El endpoint debe ser compatible con `GET /models` y `POST /chat/completions`. El Worker valida destinos y bloquea direcciones privadas/locales para evitar que una URL de proveedor se convierta en un vector SSRF.

## 6. Cómo se conectan las otras webs

Servicios observados en Render:

| Servicio | Repositorio / rama conocida | Papel y relación |
|---|---|---|
| `swarm-bridge` | `Multi-agent-swarm`, `main` | Web principal + API pública. |
| `swarm-worker` | `Multi-agent-swarm`, `main` | Worker que recibe peticiones internas del Bridge. |
| `swarm-desktop-viewer` y `swarm-desktop-viewer-live` | `Multi-agent-swarm`, rama `feature/live-agent-desktop-viewer` | Servicios de visor de escritorio separados. La existencia de los servicios no prueba que la web principal los consuma; confirmar sus endpoints y autenticación antes de enlazarlos. |
| `Pril-tu-web-de-videos` | Repositorio `Pril-tu-web-de-videos`, `main` | Sitio estático separado. |
| `pril-backend-api` | Repositorio `Pril-tu-web-de-videos`, `main` | Backend separado de Pril. |
| Otros servicios | Repositorios independientes | No asumir conexión a Swarm sin una URL/configuración y autenticación explícitas. |

La web principal y el Worker están conectados por `WORKER_BASE_URL` + `WORKER_SHARED_SECRET`. La base de cuentas es compartida de forma intencional por `SWARM_DATABASE_URL`; la base de tareas se configura por separado en `DATABASE_URL`. La conexión de un servicio a otro debe tener un contrato explícito (URL, auth, timeout, formato de datos y manejo de errores). Que dos aplicaciones estén en la misma cuenta Render o repositorio no las conecta por sí solo.

## 7. Rendimiento y fluidez del chat

El código de la web usa una actualización frecuente de la tarea seleccionada y una actualización periódica de listas/resúmenes. Antes de aumentar la frecuencia, medir el coste de renderizado y la latencia real.

Recomendaciones para mantener fluidez, especialmente en móviles:
1. Mantener una sola vista principal visible a la vez: inicio/chat/tarea; no superponer varios paneles grandes.
2. No volver a reconstruir todo el DOM en cada tick. Actualizar solo campos cuyo contenido cambió; preservar nodos y la posición del scroll.
3. Pausar polling y animaciones cuando la pestaña no está visible; evitar solapar solicitudes y cancelar peticiones antiguas al cambiar de tarea.
4. Usar el stream de eventos para el detalle activo y polling de respaldo menos frecuente para el listado.
5. Virtualizar listas largas de tareas/mensajes/artefactos o paginarlas.
6. Restringir efectos de blur/sombras grandes y animaciones permanentes en teléfonos modestos.
7. No cargar contenido de historial completo hasta abrirlo; usar resúmenes en el inicio.
8. Medir con Performance/Network del navegador y logs del Worker antes de atribuir tirones al servidor. Un CPU bajo en Render no descarta coste de DOM, red o dispositivo.

Estas son recomendaciones de implementación; no significan que todas estén ya aplicadas.

## 8. Seguridad: reglas que no hay que romper

- No guardar claves reales en Git, README, frontend, logs, respuestas de API ni screenshots.
- No exponer `WORKER_SHARED_SECRET`, `APP_ACCESS_KEY`, `HISTORY_ENCRYPTION_KEY`, `SWARM_API_ENCRYPTION_KEY`, URLs de base de datos con usuario/contraseña ni claves de proveedor.
- No reutilizar una sola clave para cifrado de API, cifrado de historial y autenticación interna.
- El navegador debe autenticarse por sesión; no usar una contraseña como token Bearer.
- El Bridge debe comprobar la sesión y la propiedad de la tarea en todas las rutas; el Worker debe rechazar peticiones internas sin secreto.
- No exponer las rutas `/internal/*` como API pública sin autenticación.
- Si una clave real se filtró, rotarla en el proveedor/Render y actualizar coordinadamente ambos servicios cuando corresponda.
- Antes de cambiar URLs de base de datos o claves de cifrado, hacer backup y plan de migración; perder la clave de cifrado puede inutilizar datos históricos.

## 9. Despliegue y diagnóstico

1. Revisar CI del commit/PR; CI verde no es prueba completa de comportamiento en producción.
2. Verificar despliegue de `swarm-bridge` y `swarm-worker` por separado; ambos deben ejecutar el commit esperado.
3. Consultar `/healthz` para vida del proceso y `/readyz` para readiness.
4. Revisar logs de Bridge y Worker sin copiar secretos.
5. Probar inicio de sesión, creación de tarea, respuesta de agente, reanudación, carga de archivos, vista previa y persistencia tras reinicio.
6. Si Gemini devuelve error de herramienta, revisar la conservación de `thought_signature` en el ciclo de llamada y respuesta, sin registrar el valor sensible.
7. Probar scroll y controles en móvil, y confirmar que la vista previa flotante no queda dentro de un panel con overflow.
8. No desplegar Runner remoto como parte de una corrección de UI salvo que se haya aprobado y validado de forma independiente.

## 10. Fuentes internas que deben revisarse

- `README.md`: descripción funcional, variables y notas operativas.
- `render.yaml`: variables declaradas para los servicios gestionados por Blueprint.
- `apps/bridge/.env.example`, `apps/worker/.env.example`: plantillas locales.
- `apps/web/public/index.html`, `app.js`, `styles.css`: interfaz y llamadas del navegador.
- `apps/bridge/server.js`: rutas públicas, auth, permisos y proxy al Worker.
- `apps/bridge/services/accountStore.js`: usuarios, sesiones, invitaciones y claves por usuario.
- `apps/worker/server.js`: rutas internas y cola.
- `apps/worker/services/store.js`: persistencia y recuperación.
- `apps/worker/services/multiAiEngine.js`, `agentChat.js`, `providerResponse.js`, `geminiProvider.js`: orquestación, chat de agentes y proveedores.
- `apps/runner-api`: contrato del Runner opcional y controles del host aislado.

## 11. Límites de esta guía

Los nombres de variables y el flujo se han cotejado con README, ejemplos de entorno y código del repositorio. Los valores secretos reales no se muestran. La configuración efectiva de Render puede cambiar sin un commit; antes de rotar secretos o mover bases, comparar este mapa con Environment de cada servicio. No se debe interpretar la existencia de una variable en esta guía como prueba de que está configurada en producción.
