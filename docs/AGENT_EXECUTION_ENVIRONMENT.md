# Entorno de ejecución aislado para agentes

Este entorno se desarrolla en la rama `feature/agent-execution-sandbox`. No cambia Render, no despliega servicios y no ejecuta código generado contra producción.

## Qué incorpora

`apps/runner/Dockerfile` crea una imagen local/CI con toolchains comunes:

| Área | Herramientas incluidas |
|---|---|
| JavaScript / TypeScript | Node.js 22, npm; ejecutar tests y scripts de proyecto |
| Python | Python 3, venv, pytest del sistema y herramientas de compilación |
| Java | JDK headless, compilación y tests que ya tengan sus dependencias |
| Go | compilador y toolchain de Go |
| PHP / Ruby | intérpretes y herramientas de proyecto |
| C / C++ / Rust | GCC, G++, make, rustc y cargo |
| Web UI | Chromium, Xvfb, xauth y fuentes básicas |
| Operación | git, bash, coreutils, findutils, pkg-config |

La imagen es intencionalmente amplia para un entorno de desarrollo. No significa que todos los frameworks o SDK estén instalados. Para motores o SDK grandes (por ejemplo Godot, Android, .NET, CUDA, iOS/macOS), se deben crear imágenes de perfil versionadas y separadas, no inflar el runner general sin límite.

## Uso local

Requisitos: Docker Engine o Docker Desktop en Linux, macOS o Windows con WSL2; `sh` y `timeout` disponibles en el host.

1. Construí la imagen una vez:

   ```sh
   docker build -t swarm-agent-runner:local -f apps/runner/Dockerfile apps/runner
   ```

2. Prepará el proyecto y sus dependencias con una etapa de preparación confiable. La ejecución de pruebas ocurre después y sin red.

3. Ejecutá un comando dentro del sandbox:

   ```sh
   sh scripts/run-agent-sandbox.sh ./ruta/al/proyecto npm test
   sh scripts/run-agent-sandbox.sh ./ruta/al/proyecto python3 -m pytest
   sh scripts/run-agent-sandbox.sh ./ruta/al/proyecto go test ./...
   sh scripts/run-agent-sandbox.sh ./ruta/al/proyecto cargo test --offline
   ```

   Para dependencias que necesitan red, arrancá el proxy de salida restringida (ver sección **Red limitada**) y ejecutá explícitamente con `SWARM_RUNNER_NETWORK=restricted`. El modo normal continúa sin red.

4. Para ajustar límites, configurá solo estos parámetros del wrapper:

   - `SWARM_RUNNER_IMAGE`: imagen local aprobada; predeterminado `swarm-agent-runner:local`.
   - `SWARM_RUNNER_TIMEOUT_SECONDS`: timeout total; predeterminado 120.
   - `SWARM_RUNNER_MEMORY`: límite Docker de memoria; predeterminado `1g`.
   - `SWARM_RUNNER_CPUS`: límite CPU; predeterminado `2`.
   - `SWARM_RUNNER_PIDS`: límite de procesos; predeterminado 128.
   - `SWARM_RUNNER_NETWORK`: solo `none` (predeterminado) o `restricted`; este último requiere la topología de proxy descrita abajo y valida que la red Docker sea interna.

## Frontera de seguridad

El wrapper aplica, por ejecución:

- red deshabilitada por defecto (`--network none`);
- sistema de archivos raíz de solo lectura;
- capacidades Linux eliminadas y `no-new-privileges`;
- límites de CPU, RAM, PIDs y tiempo;
- `/tmp` temporal y limitado;
- un único montaje escribible: el directorio del proyecto;
- usuario numérico no root;
- solo variables de entorno explícitas; no hereda las credenciales del host;
- ningún socket Docker, credencial, archivo del repositorio completo ni conexión a PostgreSQL.

El código puede modificar o borrar los archivos dentro del directorio montado. Usá una copia de trabajo descartable por tarea y no montes tu checkout principal si necesitás conservarlo. El wrapper rechaza rutas raíz y directorios del sistema conocidos, pero no reemplaza la revisión de la ruta por quien lo invoca.

**Importante:** un contenedor no equivale a una VM reforzada frente a escapes del kernel. Para ejecutar código hostil en un servicio multiusuario se requiere una frontera adicional (VM/microVM o sandbox especializado), aislamiento por usuario/tarea, política de red a nivel de infraestructura y auditoría. No se debe conectar este runner a secretos de producción ni ejecutarlo privilegiado.

## Dependencias y red

**La red normal sigue desactivada.** `npm install`, `pip install`, `go get`, `cargo fetch` y descargas de navegadores deben preferir dependencias preparadas, archivos de lock revisados y cachés/imágenes aprobadas. Nunca habilites una red Docker normal como atajo.

### Modo opcional de salida limitada

Se agregó un proxy Squid con denegación por defecto y una lista explícita de hosts permitidos:

- Configuración: `apps/runner/egress-proxy/squid.conf`.
- Lista revisable por humanos: `apps/runner/egress-proxy/allowed-domains.txt`.
- Topología: `docker-compose.runner-egress.yml`. La red `swarm-agent-egress` está configurada con `internal: true`; el sandbox no se conecta a la red externa. Solo el proxy tiene una segunda interfaz en `swarm-egress-outbound`.
- Se permiten únicamente los hosts enumerados y los puertos HTTP/HTTPS seguros definidos por Squid; destinos privados, loopback y link-local se bloquean y todo lo demás se deniega. La lista inicial cubre registros comunes de paquetes; no garantiza que todas las dependencias usen esos hosts.
- No se publican puertos del proxy en el host y no se permiten destinos elegidos arbitrariamente por el modelo.

Preparación local:

```sh
docker compose -f docker-compose.runner-egress.yml up --build -d
SWARM_RUNNER_NETWORK=restricted sh scripts/run-agent-sandbox.sh ./copia-descartable npm ci --ignore-scripts
docker compose -f docker-compose.runner-egress.yml down
```

Los comandos que respetan `HTTP_PROXY`/`HTTPS_PROXY` usan el proxy automáticamente. Chromium no siempre respeta esas variables en todos los entornos; si una prueba de navegador requiere red restringida, pasale explícitamente `--proxy-server=http://172.30.0.2:3128` y mantené la allowlist activa. No uses este modo para páginas arbitrarias sin revisar primero los dominios permitidos.

Los instaladores de paquetes pueden ejecutar scripts de ciclo de vida o backends de compilación. Preferí `--ignore-scripts` cuando sea compatible, usá una copia descartable y no expongas secretos ni datos privados durante esta fase. Las pruebas funcionales posteriores deben correr sin red.

El modo restringido **falla cerrado** si no existe la red fija. No cambia a una red abierta como fallback. Para sumar un dominio, revisá primero por qué lo necesita el lockfile o el framework, agregalo a `allowed-domains.txt` y repetí la prueba de red. No agregues comodines amplios como `*`, dominios de almacenamiento genéricos o proveedores de túneles.

**Límites honestos:** Squid restringe los destinos HTTP/HTTPS que pasan por el proxy; la variable `HTTP_PROXY` por sí sola no obliga a programas maliciosos a usarlo. La red Docker interna evita la ruta IP directa habitual, pero el DNS embebido de Docker y la configuración de red del host deben evaluarse en la plataforma final. Para código realmente hostil o multiusuario, bloqueá DNS directo y cualquier salida adicional mediante firewall de host/política de egress, o usá una VM/microVM con política de red aplicada fuera del contenedor. La prueba CI verifica un host permitido y uno denegado, pero no sustituye una auditoría de escape o de exfiltración DNS.

El runner no acepta una imagen Docker, comando de host, volumen adicional o URL de red elegida por el modelo. El comando dentro del contenedor lo elige quien invoca el wrapper; en una futura API del Swarm, el servidor debe mapear perfiles y comandos a una lista permitida, no aceptar argumentos Docker arbitrarios.

## Xvfb y pruebas de navegador

La imagen incluye Chromium y Xvfb. Xvfb ofrece un servidor X virtual para software que necesita display; no prueba por sí solo que una aplicación sea correcta. Las pruebas deben verificar resultados observables (DOM, consola, interacción, capturas, salida y código de salida). Para HTML no confiable, usar navegador sin red y perfil temporal. El aislamiento del contenedor es la frontera principal; no confiar únicamente en flags de Chromium.

## Resultado de ejecución requerido en Swarm

Cada ejecución futura debería persistir un informe estructurado, unido a `jobId`, `artifactDigest` y checkpoint:

- `status`: `NOT_RUN`, `PASSED`, `FAILED`, `INFRA_ERROR` o `TIMED_OUT`;
- comando/perfil aprobado, runtime y versión de imagen;
- código de salida y duración;
- stdout/stderr truncados con límites;
- pruebas ejecutadas y resultado por prueba;
- límites aplicados y motivo de cualquier omisión;
- timestamp y referencia al artefacto inmutable.

Una ejecución no disponible no puede convertirse en éxito. El agente corrector recibe evidencia saneada, genera un nuevo artefacto y la nueva versión se vuelve a probar. El runner no debe escribir directamente en el repositorio ni aprobar su propio resultado.

## Verificación sin despliegue

- `sh -n scripts/run-agent-sandbox.sh` comprueba sintaxis del wrapper.
- `npm run check` ejecuta las comprobaciones unitarias existentes y el test de política del wrapper.
- `sh scripts/agent-sandbox-smoke.sh` construye el runner y el proxy, prueba workspace, Chromium/Xvfb, red deshabilitada, un destino permitido, uno denegado, timeout y raíz de solo lectura.
- `docker build ...` construye la imagen local; no despliega nada.
- La prueba de extremo a extremo contra Render sigue siendo independiente y no debe ejecutarse desde cada rama experimental.

## Próximas etapas antes de integrarlo

1. Probar construcción de imagen y comandos de ejemplo en CI aislado.
2. Mantener las pruebas de timeout, límites de recursos, rutas sensibles y red: modo `none` y proxy con allowlist.
3. Crear perfiles versionados para runtimes pesados que realmente necesitemos.
4. Diseñar un protocolo runner/worker con cola, identidad de artefacto, resultados estructurados y autenticación de servicio a servicio.
5. Elegir una plataforma de ejecución reforzada antes de permitir código hostil multiusuario.
6. Integrar solo tras revisión del PR y pruebas; no desplegar automáticamente el runner en Render Free.
