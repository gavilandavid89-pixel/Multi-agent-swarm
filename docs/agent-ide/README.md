# Entorno IDE y runner privado para agentes

## Estado real

El servicio `apps/desktop-viewer` ya ejecuta Chromium dentro de Xvfb y publica el escritorio mediante noVNC detrás de autenticación de administrador. Su herramienta interna permite navegar, inspeccionar DOM, hacer clic, introducir texto, pulsar teclas, desplazarse, volver atrás y capturar pantalla. **Todavía no es un IDE con editor de archivos, terminal, extensiones, depurador ni ejecución aislada por tarea.** No se debe describir como VS Code ni ejecutar código arbitrario dentro del contenedor compartido del visor.

## Prototipo de imagen IDE

`apps/agent-ide/Dockerfile` crea una imagen basada en Node 22 con code-server, Git, Python y herramientas de compilación. `start-agent-ide.sh` exige una variable `PASSWORD` de al menos 24 caracteres y arranca el editor en `/workspace`, con extensiones y datos de usuario temporales.

**Esto es una imagen preparada, no un servicio desplegado ni integrado todavía.** No agregarla a `render.yaml` ni exponer el puerto 8080 públicamente hasta implementar y probar un gateway de autenticación, tickets de sesión de corta duración y políticas de workspace. La contraseña de code-server por sí sola no sustituye el aislamiento por tarea ni una política de red de salida. El workspace dentro del contenedor es temporal; no guardar allí checkpoints como única copia.

## Arquitectura objetivo

1. **IDE web**: code-server/VS Code web en un servicio privado separado, con editor Monaco, explorador de archivos, búsqueda global, terminal, extensiones controladas, formato, lint, depuración y Git. Solo el administrador accede al escritorio humano; los agentes usan APIs internas específicas, no la sesión de navegador del administrador.
2. **Workspace efímero por tarea**: checkout de una revisión concreta, directorio de trabajo aislado, caché de dependencias limitada y artefactos versionados por `taskId`. Nunca montar el repositorio de producción ni compartir el workspace entre agentes no coordinados.
3. **Runner de pruebas separado**: imagen con Node 22, npm, Git, Chromium, Xvfb, herramientas de compilación mínimas y utilidades por proyecto. Sin privilegios, sin socket Docker, sin credenciales del Bridge/Worker, filesystem temporal y límites estrictos de CPU, memoria, procesos, tiempo y salida.
4. **Ejecución declarativa**: `install`, `check`, `test`, `build`, `browser-test`; allowlist de comandos, directorio de trabajo fijo, argumentos separados (sin shell interpolado), timeout por paso y cancelación. No ejecutar texto del agente como comando shell directo.
5. **Internet controlado**: salida denegada por defecto salvo proxy; validar DNS y redirecciones contra loopback, redes privadas, link-local, metadata y destinos de producción. Limitar tamaño, tipo y duración de descargas; no basta con validar la URL antes de navegar.
6. **Observabilidad**: cada ejecución emite `taskId`, `checkpoint`, `runId`, estado, código de salida, duración, logs truncados y referencias a artefactos. Errores se envían al inbox persistente descrito en `docs/diagnostics/README.md`.
7. **Recuperación**: cada paso tiene ID idempotente; reintentar solo fallos transitorios. Ante timeout ambiguo, consultar el estado de ejecución antes de volver a lanzar comandos con efectos secundarios. Persistir checkpoints fuera del contenedor efímero.

## Criterios de aceptación antes de habilitar ejecución general

- Dos tareas simultáneas no pueden leer ni modificar archivos de la otra.
- Pruebas que intentan acceder a `127.0.0.1`, IPv6 loopback, RFC1918, link-local/metadata, redirecciones privadas y DNS rebinding son bloqueadas por la capa de red, no solo por la UI.
- El runner no recibe `WORKER_SHARED_SECRET`, claves de proveedor, `DATABASE_URL` ni secretos de producción.
- Un proceso que consume CPU/memoria, crea procesos o produce salida ilimitada termina dentro de límites definidos.
- `npm run check`, pruebas unitarias, build y prueba de navegador real pasan antes de marcar un resultado como correcto.
- El agente puede guardar un checkpoint, reanudarse tras reinicio del servicio y no repetir acciones no idempotentes automáticamente.

## Próximos pasos de implementación

1. Añadir pruebas unitarias e integración del colector de diagnósticos y activar el CI para las rutas modificadas.
2. Crear el runner Docker efímero y un protocolo interno firmado para crear/consultar/cancelar ejecuciones.
3. Implementar workspace por tarea, comandos allowlisted y límites de recursos.
4. Desplegar el IDE web como servicio privado independiente; integrar SSO/tickets de corta duración y no exponer el puerto del editor directamente.
5. Añadir UI de diagnósticos y cola de investigación IA que convierta los errores en análisis, pruebas sugeridas y estado persistente. No permitir auto-merge ni despliegue por una recomendación generada por IA.
