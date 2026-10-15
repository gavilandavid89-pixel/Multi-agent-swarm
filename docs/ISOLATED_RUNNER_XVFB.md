# Ejecutor aislado del enjambre (Node + Xvfb)

## Diseño y límites de seguridad
- Servicio independiente de Bridge y Worker; no debe recibir DATABASE_URL, claves de proveedores, claves de cifrado ni acceso a Neon.
- El único secreto del API es RUNNER_SHARED_SECRET (32+ caracteres aleatorios). El Worker lo envía como cabecera autenticada; nunca se pasa al proceso de código.
- Cada ejecución recibe archivos de texto limitados, se escribe en un directorio temporal y se elimina al finalizar.
- El código se ejecuta dentro de bubblewrap con namespaces de usuario/proceso/red, sistema base de solo lectura, workspace temporal y red externa aislada. Si bubblewrap no puede iniciar, la ejecución falla cerrada.
- Pruebas de interfaz ejecutan Chromium visible sobre Xvfb; el harness detecta errores JS/console, solicitudes fallidas, HTTP no exitoso y página vacía.
- El servicio no instala dependencias del proyecto ni ejecuta comandos arbitrarios proporcionados por la IA. Node usa `node --test` para archivos de prueba, o un entrypoint inequívoco.
- Los resultados son evidencia de ejecución acotada, no garantía universal de corrección.

## Configuración Render
Crear un servicio separado con el Blueprint `render-runner.yaml` después de revisar el coste del plan privado. El Blueprint principal `render.yaml` permanece intacto para no modificar servicios existentes. Configurar:
- `RUNNER_SHARED_SECRET`: secreto aleatorio de al menos 32 caracteres; debe coincidir con `SANDBOX_RUNNER_SECRET` en Worker.
- `PORT=10000`
- `RUNNER_XVFB_ENABLED=true`
- `RUNNER_TIMEOUT_MS=30000`

En Worker:
- `SANDBOX_RUNNER_URL`: URL interna del servicio Runner.
- `SANDBOX_RUNNER_SECRET`: mismo secreto de Runner.
- `SANDBOX_RUNNER_REQUIRED=true` solo después de comprobar que el servicio está desplegado y que `/healthz` responde correctamente. Antes de eso, las pruebas runtime son opcionales.

No añadas credenciales de proveedores ni variables de base de datos al Runner. No publiques el Runner abiertamente si puede configurarse como servicio privado.

## Modos
- `auto`: Chromium/Xvfb para entregas HTML; tests Node para archivos `*.test.js/mjs/cjs`; ejecución de scripts Python estándar o `unittest`; o un entrypoint claro.
- `node`: pruebas Node o entrypoint permitido por el selector determinista.
- `browser`: carga el HTML local bajo Chromium/Xvfb y comprueba errores visibles.

La red está aislada durante la ejecución. Apps que dependan de APIs externas, instalación de paquetes en runtime o servicios externos fallarán de forma esperada; deben usar mocks/fixtures. El runner no se debe considerar un contenedor multi-tenant de alta seguridad hasta que el proveedor confirme soporte de user namespaces/bubblewrap y se realicen pruebas de escape dedicadas.
