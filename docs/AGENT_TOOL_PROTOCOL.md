# Contrato de herramientas para agentes y runner

Este documento describe la integración de herramientas de agentes sin darles acceso directo al host, al daemon Docker ni al secreto de la Runner API. La ejecución pasa por la API autenticada y el cliente privado del Worker. **El dispatcher de herramientas ya está conectado al ciclo de tool-calling de los proveedores compatibles**, con permisos por rol; no es un shell libre.

El catálogo de capacidades instalado está versionado en `apps/runner/capabilities.json` y se puede consultar en `GET /v1/capabilities` usando la autenticación privada Worker→Runner. Enumera toolchains, perfiles, límites, políticas de red y capacidades que aún no existen. No es una concesión de permisos: el servidor sigue validando cada operación.

## Flujo de control

1. El Worker valida que la tarea y el agente tengan permiso para usar herramientas.
2. El dispatcher convierte una llamada tipada del agente en una operación conocida del cliente del runner. El agente nunca recibe AGENT_RUNNER_SHARED_SECRET ni RUNNER_SHARED_SECRET.
3. El Worker asigna un workspaceId aislado. Cada invocación obtiene una clave de idempotencia propia que se reutiliza en los reintentos de transporte; así no colisionan llamadas distintas cuando se reinicia el Worker. El contenido del workspace se persiste en el payload cifrado de la tarea; la persistencia/reattachment de la clave y el checkpoint de un tool-call en vuelo tras reinicios aún debe validarse.
4. La Runner API autentica al Worker, valida límites y archivos, y encola un job. El host de ejecución inicia un contenedor efímero con límites de recursos y filesystem controlado.
5. El Worker consulta el estado del job hasta completar la llamada y devuelve el ID cuando corresponde. La Runner API persiste los jobs y protege las solicitudes idempotentes; la reanudación del tool-call de modelo desde un checkpoint tras reiniciar el Worker sigue siendo un criterio de aceptación pendiente y no debe darse por garantizada.
6. La API devuelve salida acotada y una instantánea de archivos validada. El Worker filtra datos sensibles, persiste los resultados y los entrega al agente que pidió la herramienta.
7. El agente interpreta los resultados y decide si corrige, vuelve a probar o pide revisión a otro rol. Una prueba fallida es evidencia, no se debe etiquetar como éxito ni borrar el error original.

Los IDs de jobs usados para consultar estado, cancelar o leer artefactos deben haber sido devueltos por una herramienta de ejecución de esta misma sesión de dispatcher. Un UUID válido por sí solo no demuestra propiedad y se rechaza si no está registrado como propio.

## Catálogo de herramientas recomendado

El dispatcher expone operaciones pequeñas con JSON Schema estricto y permisos por rol. Estos nombres son herramientas del Worker, no nuevos endpoints HTTP de la Runner API. La API de catálogo solo descubre capacidades; cada llamada de herramienta se valida en el Worker y después pasa por el cliente autenticado del runner.

| Herramienta | Entrada principal | Permiso y efecto |
|---|---|---|
| workspace.list | sin argumentos | Lista rutas y tamaños dentro del workspace; no lee rutas del host |
| workspace.read | path | Lee un archivo de proyecto; límites de tamaño y redacción de secretos |
| workspace.write | path, content | Escribe en el workspace, rechaza rutas absolutas, traversal y archivos de credenciales |
| runner.check | sin argumentos | Ejecuta las comprobaciones de proyecto configuradas por el Worker; permitido a Desarrollador y Validador |
| runner.execute | command (argv), timeoutMs, `stdin` opcional solo para `python3 -m pdb` (máx. 16 KiB) | Solo Desarrollador; binarios allowlisted, sin shell y con red `none` fijada por el Worker; el modelo no puede habilitar egress |
| runner.prepareDependencies | manifest | Solo Desarrollador; manifiestos allowlisted y red restricted mediante proxy con allowlist, sin secretos |
| runner.jobStatus | jobId | Desarrollador y Validador; solo IDs devueltos por una herramienta en esa misma sesión de dispatcher |
| runner.cancel | jobId | Solo Desarrollador; solo IDs devueltos por una herramienta en esa misma sesión |
| runner.artifact.read | jobId, artifactId | Desarrollador y Validador; recupera un artefacto por ID para un job de su sesión |

**No exponer** herramientas como docker.run, host.exec, network.open, read.hostFile, setEnvironment o editAllowlist. No permitir que el modelo elija una URL de proxy, nombre de red Docker, imagen arbitraria, mount, UID, variables de entorno del host o parámetros de privilegio.

## Output y debugging

La Runner API captura `stdout` y `stderr` mientras el proceso está activo, retiene como máximo los últimos 64 KiB por stream y devuelve el código de salida, estado, timeout/cancelación, duración y error de infraestructura. El cliente Worker limita cada stream que entrega al siguiente paso del agente a 12 KiB para no saturar el contexto. El endpoint de estado permite consultar la salida parcial durante la ejecución; la ausencia temporal de output no equivale a éxito.

El dispatcher bloquea la lectura de archivos de más de 256 KiB y rechaza lecturas que coincidan con patrones conocidos de credenciales. Antes de devolver resultados de herramientas, redacta patrones conocidos de claves/tokens y campos con nombres sensibles (por ejemplo, `apiKey`, `access_token`, `password` o `client_secret`), y luego aplica el límite de salida. Esta defensa es por patrones y nombres de campos: no es un detector universal de secretos. No se deben incluir credenciales reales en los workspaces ni en sus logs.

El modo de depuración verificado es Python PDB: `python3 -m pdb <script.py>`, con comandos enviados por `stdin` limitado a 16 KiB y solo cuando `network:none`. La herramienta `runner_execute`, el cliente del Worker y el propio Runner API aplican la misma restricción: el argv debe comenzar exactamente con `python3 -m pdb`; otros comandos no pueden recibir entrada arbitraria. No abre puertos de depuración ni da acceso al host. La entrada no se persiste; si el runner reinicia antes de ejecutar un trabajo encolado que la requiere, el trabajo falla con un motivo explícito y debe reenviarse. El smoke test de CI verifica PDB, stdout, stderr y código de salida.

**Límites actuales:** el depurador interactivo persistente y los adaptadores de sesión para Node Inspector/Java JDB aún no están implementados. El tool-calling sí está conectado para los proveedores compatibles; las herramientas disponibles dependen del rol y el dispatcher aplica una lista permitida, valida argumentos y limita las llamadas. No existe una herramienta `runner.debug` ni control persistente de depuradores.

## Políticas por fase y rol

- **Arquitecto / Coordinador:** solo puede inspeccionar el workspace; no tiene herramientas de ejecución o comprobación ni puede cambiar configuración del host.
- **Desarrollador:** puede editar archivos del workspace y solicitar ejecuciones; no puede leer secretos del servicio ni editar la allowlist.
- **Validador:** recibe el snapshot de revisión y puede lanzar comprobaciones independientes; su dispatcher solo puede consultar trabajos/artefactos cuyos IDs devuelve esa misma sesión. **Escéptico y Auditor** tienen lectura del workspace, sin ejecución ni comprobaciones directas.
- **Árbitro:** no recibe actualmente un dispatcher de herramientas en el ciclo de tool-calling; consume resultados a través de la orquestación del consejo y no puede convertir una prueba no ejecutada en aprobada.
- **Operador administrador:** cualquier cambio de allowlist, imagen, límites de seguridad o host de ejecución queda fuera del control de los agentes y requiere revisión explícita del operador.

La identidad de rol no es un límite de seguridad suficiente por sí sola: el Worker valida las herramientas permitidas y el dispatcher limita las operaciones por rol. Los workspaces aislados y el merge sin conflictos están implementados. La API remota sigue siendo optativa y no debe habilitarse en producción hasta validar un host privado dedicado, firewall, autenticación y pruebas completas.

## Protocolo de trabajo

1. El Worker crea un workspace efímero con ID determinista para la combinación tarea/agente/propósito. La base del proyecto es de solo lectura lógica para las propuestas; cada agente escribe únicamente en su espacio propio.
2. El agente modifica archivos mediante operaciones de workspace; las rutas se validan en servidor.
3. Para dependencias, el Worker elige un perfil de preparación revisado y ejecuta un job separado con red restricted. No pasa secretos, tokens de repositorios privados ni variables del host.
4. Tras preparar, el Worker ejecuta los tests en un nuevo contenedor con red none.
5. Cada ejecución usa idempotencia, timeout, estado persistido y cancelación. Los reintentos reutilizan la clave solo si el cuerpo de la solicitud no cambia; para contenido diferente se crea otra clave.
6. El Worker recoge los artefactos del snapshot, limita bytes y cantidad de archivos, rechaza symlinks/rutas inseguras y aplica filtros de credenciales antes de que el agente vea el resultado.
7. Los agentes reciben un resultado estructurado: jobId, status, exitCode, timedOut, stdout, stderr, artifacts, durationMs e infraError. Los resultados de infraestructura se distinguen de fallos del código del proyecto.
8. El coordinador integra propuestas con merge de tres vías contra la base inmutable. Si hay conflicto, no pisa archivos ni ejecuta tests sobre una integración ambigua: solicita una resolución y luego vuelve a ejecutar toda la validación sobre el workspace de integración.

## Recuperación, concurrencia y UX

- La API usa polling autenticado; el cold start del host puede tardar, así que readiness y polling tienen ventanas mayores que el primer intento HTTP. La recuperación del vínculo entre un tool-call en vuelo, su jobId y el checkpoint de tarea tras un reinicio del Worker sigue pendiente de una prueba específica.
- **Aislamiento lógico por agente:** `deriveAgentWorkspaceId(taskId, agentId, purpose)` genera un UUID determinista distinto por tarea, agente y propósito. Dos agentes de la misma tarea no deben compartir su workspace de trabajo. Reintentar el mismo propósito conserva su identidad; una nueva ronda o el workspace de integración usa otro propósito.
- **Integración separada:** las propuestas de cada agente se comparan contra una base inmutable. `mergeAgentWorkspaceChanges` combina cambios en rutas diferentes, coalesce ediciones idénticas y rechaza el merge entero si dos agentes cambian el mismo archivo de formas incompatibles. No se devuelve una integración parcial en caso de conflicto; el coordinador debe pedir resolución explícita.
- Un workspace no admite jobs concurrentes. La concurrencia global del host permanece en 1 mientras los trabajos restricted compartan el proxy. Los espacios lógicos ya quedan separados, pero el runner sigue ejecutando un job a la vez; para aumentar paralelismo, cada job necesita su propia red y política de egress aplicada fuera del contenedor, o un host/pool separado.
- La interfaz del agente debe mostrar estados reales: queued, running, succeeded, failed, timed_out, cancelled; no mostrar “probado” hasta que un job termine con código 0.
- La salida se presenta por fragmentos resumidos y artefactos, no volcando logs ilimitados en el prompt. Guardar logs completos acotados y referencias de artefactos en el checkpoint; incluir solo el fragmento relevante en el siguiente turno del modelo.
- El usuario debe poder ver qué perfil se ejecutó, qué archivos se cambiaron y por qué se rechazó una ejecución. No incluir secretos ni variables de entorno en la UI o los logs.

## Pruebas de aceptación antes de habilitar agentes

- La API rechaza peticiones sin secreto, rutas inseguras, payloads demasiado grandes, credenciales detectables y claves de idempotencia reutilizadas con cuerpos distintos.
- El runner puede crear/modificar/borrar archivos y devolver artefactos correctos, además de reutilizar un workspace secuencialmente.
- El contenedor no puede escribir en su raíz ni acceder a la red normal; el modo restricted solo alcanza hosts allowlisted mediante el proxy.
- Timeout y cancelación terminan procesos y no dejan contenedores o procesos secundarios activos.
- Un reinicio del Worker no duplica jobs ni pierde el vínculo entre checkpoint, job y artefactos (prueba de aceptación pendiente para tool-calls directos).
- La ejecución de pruebas corre con red desactivada incluso si la preparación de dependencias usó egress restringido.
- No habilitar la integración de producción hasta que el CI de esta rama pase y un host aislado dedicado supere la prueba completa. El Render Free del Worker no se considera un host Docker disponible.
