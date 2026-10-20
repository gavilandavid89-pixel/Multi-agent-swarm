# Ejecución de código generado: frontera de seguridad

## Decisión

El worker de agentes no ejecuta código generado dentro de su propio proceso. El worker conserva acceso a PostgreSQL, claves de proveedores y orquestación; el código generado se considera no confiable incluso si lo produjo un agente del sistema.

La comprobación actual de sintaxis (node --check) no es ejecución funcional y no debe presentarse como tal.

## Arquitectura objetivo

1. El worker empaqueta una entrega inmutable con jobId, artifactDigest, lenguaje/runtime solicitado y una lista de pruebas.
2. El Worker usa `apps/worker/services/runnerClient.js` para enviar trabajos a `apps/runner-api`, un plano de control privado que no comparte DATABASE_URL, claves de IA, credenciales de usuario ni permisos de escritura sobre el repositorio.
3. El ejecutor inicia un entorno efímero no privilegiado, con sistema de archivos temporal, límites de CPU/memoria/procesos/tamaño de salida y tiempo máximo.
4. La red de la ejecución está deshabilitada por defecto. La preparación de dependencias puede usar una red separada con proxy de salida y allowlist de dominios; la fase de pruebas debe volver a ejecutarse sin red. No se permite que el modelo pida libremente una URL arbitraria. El proxy de desarrollo no sustituye una política de egress/DNS del host para código hostil.
5. La API acepta tareas asíncronas autenticadas, con idempotencia, polling, cancelación, límites de cola y TTL de resultados. Se capturan código de salida, salida estándar/error truncada, duración y artefactos acotados. El Worker guarda el resultado de ejecución en el checkpoint de validación y usa los fallos como hallazgos del ciclo correctivo.
6. El Validador distingue explícitamente NO_EJECUTADO, FALLO, APROBADO y ERROR_DE_INFRAESTRUCTURA. Una prueba que no arrancó no es una prueba aprobada.
7. El agente corrector recibe errores concretos y puede producir una nueva versión; cada iteración vuelve a ejecutarse contra un hash nuevo. La integración automática ya está conectada al ciclo de validación, pero el servicio remoto sigue optativo y no se habilita hasta configurar el host privado.

## Runtimes iniciales

- JavaScript/Node: node --test, scripts declarados permitidos y sintaxis.
- Python: python -m compileall y tests de proyecto cuando existan.
- HTML/CSS: chequeos estáticos y pruebas de navegador en un runtime dedicado cuando esté disponible.
- Godot: validar el proyecto y ejecutar pruebas headless con una versión fijada del motor. Xvfb solo es necesario para herramientas que requieren un servidor X; no sustituye Godot ni verifica escenas por sí mismo.

## Controles que bloquean el lanzamiento

- No ejecutar mediante eval, node:vm o child_process dentro del worker como si eso fuera un sandbox.
- No montar el socket Docker ni usar contenedores privilegiados.
- No pasar variables de entorno del servicio padre al proceso generado.
- No habilitar salida restringida para una tarea arbitraria: reservarla a preparación de dependencias sin secretos y en copia descartable.
- El modo de red restringida debe fallar cerrado si falta la red interna o la allowlist; nunca caer a bridge/host.
- No aceptar nombres de imágenes, comandos, rutas, volúmenes o URLs arbitrarios del modelo.
- Limitar el tamaño de los artefactos y validar rutas contra traversal.
- Aislar trabajos y usuarios; nunca reutilizar un directorio mutable entre tareas.
- Registrar auditoría sin incluir claves, cadenas de conexión ni contenido secreto.
- Si el runner no está configurado, marcar ejecución como no disponible y conservar la validación estática; nunca simular una ejecución exitosa.

## Despliegue y validación

La API y su contrato están implementados en `apps/runner-api`, y el Worker ya consume el cliente cuando se configura. Antes de habilitarlo, debe provisionarse un host privado con Docker (preferentemente rootless), firewall y sin secretos de producción. Un servicio web en Render Free no garantiza un daemon Docker apto para ejecutar contenedores hermanos. La CI debe probar límites, timeout, limpieza, red restringida, ausencia de secretos, autenticación y recuperación ante caída del runner.
