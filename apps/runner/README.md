# Swarm Agent Runner

Servicio HTTP interno para ejecutar pruebas de agentes en un contenedor separado del worker y de la vista previa del usuario. Incluye Chromium y Xvfb; no expone una sesión gráfica.

## Seguridad obligatoria

- Desplegar como servicio separado, accesible solo por red privada.
- La imagen ejecuta como usuario `node`; no montar el socket Docker, volúmenes de producción ni secretos del worker.
- `RUNNER_SHARED_SECRET` debe ser aleatorio y tener al menos 32 caracteres. No reutilizar secretos del bridge.
- Denegar salida de red por defecto mediante la política de red de la plataforma. El código Node no es un firewall.
- Si se habilita Internet, hacerlo solo a través de un proxy de salida que bloquee loopback, redes privadas, link-local, metadata cloud y redes internas; validar DNS y redirecciones.
- Imponer límites de CPU, memoria, PIDs y disco en la plataforma. El timeout de la aplicación no sustituye estos límites.
- No exponer `/v1/run` a Internet pública: ejecuta código enviado por agentes.

## Configuración

- `RUNNER_SHARED_SECRET`: obligatorio, 32+ caracteres.
- `PORT`: puerto HTTP, por defecto 3200.
- `RUNNER_WORKDIR`: raíz temporal de tareas.
- `RUNNER_MAX_BODY_BYTES`: límite de entrada (2 MB).
- `RUNNER_MAX_FILES`: máximo de archivos (100).
- `RUNNER_MAX_FILE_BYTES`: máximo por archivo (1 MB).
- `RUNNER_MAX_RUNTIME_MS`: timeout (60 s).
- `RUNNER_MAX_OUTPUT_BYTES`: límite de salida por stream (200 KB).
- `RUNNER_CONCURRENCY`: concurrencia (1–4, por defecto 2).

## API

`GET /healthz` devuelve estado sin secretos.

`POST /v1/run` requiere `x-swarm-runner-secret` y un JSON como:

```json
{
  "files": [{"path": "test.mjs", "content": "console.log('ok')"}],
  "command": {"program": "node", "args": ["test.mjs"]}
}
```

No usa shell, rechaza rutas que escapen del workspace, restringe los programas permitidos, limita el tiempo y la salida, y borra el workspace al terminar.

## Estado

Esta es la primera implementación del servicio de ejecución, todavía no conectada al flujo de trabajos del swarm ni desplegada. La lista de comandos reduce superficie, pero no sustituye un sandbox de kernel. Antes de ejecutar código de agentes, desplegar con aislamiento de red y recursos y probarlo en un entorno desechable. El acceso a Internet requiere configurar y verificar el proxy de salida primero.
