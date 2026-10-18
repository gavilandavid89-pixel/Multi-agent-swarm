# Contrato de herramientas para agentes y runner

Este documento define cómo conectar agentes al entorno sin darles acceso directo al host, al daemon Docker ni al secreto de la Runner API. La ejecución está disponible a través de la API autenticada y del cliente privado del Worker; **el dispatcher de herramientas para los agentes sigue siendo una capa explícita de integración**, no se debe presentar al modelo como un shell libre.\n\nEl catálogo de capacidades instalado está versionado en `apps/runner/capabilities.json` y se puede consultar en `GET /v1/capabilities` usando la autenticación privada Worker→Runner. Enumera toolchains, perfiles, límites, políticas de red y capacidades que aún no existen. No es una concesión de permisos: el servidor sigue validando cada operación.

## Flujo de control

1. El Worker valida que la tarea y el agente tengan permiso para usar herramientas.
2. El dispatcher convierte una llamada tipada del agente en una operación conocida del cliente del runner. El agente nunca recibe AGENT_RUNNER_SHARED_SECRET ni RUNNER_SHARED_SECRET.
3. El Worker asigna el workspaceId a la tarea actual, crea una clave de idempotencia estable y persiste un checkpoint antes de operaciones largas.
4. La Runner API autentica al Worker, valida límites y archivos, y encola un job. El host de ejecución inicia un contenedor efímero con límites de recursos y filesystem controlado.
5. El Worker consulta el estado del job. Ante reinicios, reanuda el polling con el ID guardado en el checkpoint en lugar de duplicar la ejecución.
6. La API devuelve salida acotada y una instantánea de archivos validada. El Worker filtra datos sensibles, persiste los resultados y los entrega al agente que pidió la herramienta.
7. El agente interpreta los resultados y decide si corrige, vuelve a probar o pide revisión a otro rol. Una prueba fallida es evidencia, no se debe etiquetar como éxito ni borrar el error original.

## Catálogo de herramientas recomendado

El dispatcher debe exponer operaciones pequeñas, con JSON Schema estricto y permisos por rol. Estos nombres son el contrato propuesto para la capa de agentes; no son nuevos endpoints HTTP de la Runner API. La API de catálogo no implementa estas herramientas y no debe anunciarse a los modelos como tool-calling activo hasta que exista el dispatcher y pase pruebas de autorización por tarea/rol.

| Herramienta | Entrada principal | Permiso y efecto |
|---|---|---|
| workspace.list | path opcional | Lista archivos solo dentro del workspace de la tarea; no lee rutas del host |
| workspace.read | path | Lee un archivo de proyecto; límites de tamaño y redacción de secretos |
| workspace.write | path, content | Escribe en el workspace, rechaza rutas absolutas, traversal y archivos de credenciales |
| runner.check | profile | Ejecuta perfiles conocidos de sintaxis/tests/browser/Godot; preferido para validación repetible |
| runner.execute | argv, timeoutMs | Capacidad avanzada; argumentos validados, cwd fijo, sin shell del host, red none por defecto |
| runner.prepareDependencies | profile | Operación privilegiada solo para preparar dependencias bloqueadas; red restricted, allowlist aprobada y sin secretos |
| runner.jobStatus | jobId | Consulta estado y salida acotada de un job creado por esa tarea |
| runner.cancel | jobId | Cancela solo trabajos propiedad de esa tarea |
| runner.artifacts.list | jobId | Lista los artefactos del snapshot de un trabajo propio |
| runner.artifacts.read | jobId, path | Recupera un artefacto con límites y filtro de datos sensibles |

**No exponer** herramientas como docker.run, host.exec, network.open, read.hostFile, setEnvironment o editAllowlist. No permitir que el modelo elija una URL de proxy, nombre de red Docker, imagen arbitraria, mount, UID, variables de entorno del host o parámetros de privilegio.

## Políticas por fase y rol

- **Arquitecto / Coordinador:** puede inspeccionar estructura y pedir perfiles de validación; no tiene permisos para ampliar red ni cambiar configuración del host.
- **Desarrollador:** puede editar archivos del workspace y solicitar ejecuciones; no puede leer secretos del servicio ni editar la allowlist.
- **Validador / Escéptico:** recibe snapshot de la revisión y puede lanzar pruebas independientes; los resultados deben etiquetarse por job/commit para evitar confundir ejecuciones.
- **Árbitro:** consume resultados, fallos y checkpoints; no puede convertir una prueba no ejecutada en aprobada.
- **Operador administrador:** cualquier cambio de allowlist, imagen, límites de seguridad o host de ejecución queda fuera del control de los agentes y requiere revisión explícita del operador.

La identidad de rol no es un límite de seguridad suficiente por sí sola: el Worker debe validar permisos, propietario de tarea, IDs de jobs y límites en el servidor para cada llamada.

## Protocolo de trabajo

1. El Worker crea un workspace efímero asociado a la tarea y un ID estable.
2. El agente modifica archivos mediante operaciones de workspace; las rutas se validan en servidor.
3. Para dependencias, el Worker elige un perfil de preparación revisado y ejecuta un job separado con red restricted. No pasa secretos, tokens de repositorios privados ni variables del host.
4. Tras preparar, el Worker ejecuta los tests en un nuevo contenedor con red none.
5. Cada ejecución usa idempotencia, timeout, estado persistido y cancelación. Los reintentos reutilizan la clave solo si el cuerpo de la solicitud no cambia; para contenido diferente se crea otra clave.
6. El Worker recoge los artefactos del snapshot, limita bytes y cantidad de archivos, rechaza symlinks/rutas inseguras y aplica filtros de credenciales antes de que el agente vea el resultado.
7. Los agentes reciben un resultado estructurado: jobId, status, exitCode, timedOut, stdout, stderr, artifacts, durationMs e infraError. Los resultados de infraestructura se distinguen de fallos del código del proyecto.

## Recuperación, concurrencia y UX

- La API usa polling autenticado; el Worker debe persistir jobId y checkpoint antes de esperar. El cold start del host puede tardar, así que readiness y polling tienen ventanas mayores que el primer intento HTTP.
- Un workspace no admite jobs concurrentes. La concurrencia global del host permanece en 1 mientras los trabajos restricted compartan el proxy. Para aumentar paralelismo, cada job necesita su propia red y política de egress, o un host/pool separado.
- La interfaz del agente debe mostrar estados reales: queued, running, succeeded, failed, timed_out, cancelled; no mostrar “probado” hasta que un job termine con código 0.
- La salida se presenta por fragmentos resumidos y artefactos, no volcando logs ilimitados en el prompt. Guardar logs completos acotados y referencias de artefactos en el checkpoint; incluir solo el fragmento relevante en el siguiente turno del modelo.
- El usuario debe poder ver qué perfil se ejecutó, qué archivos se cambiaron y por qué se rechazó una ejecución. No incluir secretos ni variables de entorno en la UI o los logs.

## Pruebas de aceptación antes de habilitar agentes

- La API rechaza peticiones sin secreto, rutas inseguras, payloads demasiado grandes, credenciales detectables y claves de idempotencia reutilizadas con cuerpos distintos.
- El runner puede crear/modificar/borrar archivos y devolver artefactos correctos, además de reutilizar un workspace secuencialmente.
- El contenedor no puede escribir en su raíz ni acceder a la red normal; el modo restricted solo alcanza hosts allowlisted mediante el proxy.
- Timeout y cancelación terminan procesos y no dejan contenedores o procesos secundarios activos.
- Un reinicio del Worker no duplica jobs ni pierde el vínculo entre checkpoint, job y artefactos.
- La ejecución de pruebas corre con red desactivada incluso si la preparación de dependencias usó egress restringido.
- No habilitar la integración de producción hasta que el CI de esta rama pase y un host aislado dedicado supere la prueba completa. El Render Free del Worker no se considera un host Docker disponible.
