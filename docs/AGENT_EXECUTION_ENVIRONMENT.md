# Entorno de ejecución aislado para agentes

Este entorno se desarrolla en la rama `feature/agent-execution-sandbox`. No se ha desplegado ningún servicio ni se han cambiado los servicios de producción. El Worker tiene una integración optativa que permanece desactivada por defecto; la API de ejecución requiere un host aislado con Docker y no debe asumirse disponible dentro del contenedor Render Free.

## Qué incorpora

`apps/runner/Dockerfile` crea una imagen local/CI con toolchains comunes:

| Área | Herramientas incluidas |
|---|---|
| JavaScript / TypeScript | Node.js 22, npm; ejecutar tests y scripts de proyecto |
| Python | Python 3, venv, pytest del sistema y herramientas de compilación |
| Java | JDK headless, Maven, compilación y tests que ya tengan sus dependencias |
| Godot | Godot 4.4.1 fijado por versión y checksum; importación headless, análisis de scripts y arranque de escena |
| Go | compilador y toolchain de Go |
| PHP / Ruby | intérpretes y herramientas de proyecto |
| C / C++ / Rust | GCC, G++, make, rustc y cargo |
| Web UI | Chromium, Xvfb, xauth, fuentes básicas y `/opt/swarm-runner/browser-smoke.mjs` |
| Operación | git, bash, coreutils, findutils, pkg-config |

La API `apps/runner-api` proporciona el plano de control autenticado y asíncrono; `apps/worker/services/runnerClient.js` es el cliente privado del Worker. Tras las comprobaciones estáticas, el Worker ejecuta perfiles de toolchain y pruebas de navegador dentro del runner; los fallos reales se convierten en hallazgos del ciclo correctivo. El modelo no recibe todavía un shell libre: la interfaz de herramientas directa para agentes queda como una capa futura sobre este cliente, con acciones nombradas y políticas controladas por el servidor. El protocolo usa idempotencia, polling, cancelación, resultados inmutables acotados, filtrado de credenciales conocidas y workspaces por tarea que se pueden reutilizar secuencialmente sin permitir ejecuciones concurrentes sobre el mismo directorio. Una preparación de dependencias puede ejecutarse en un job `restricted`; el siguiente job debe usar `none` para pruebas offline. No pasa las claves de IA ni el entorno del Worker al contenedor.

### Perfiles de ejecución automática

- JavaScript: `node --check` y validación JSON.
- Python: `py_compile`; cuando hay tests, prepara `requirements.txt` con egress limitado y ejecuta `pytest` sin red.
- Node.js: si hay script `test` o `build`, instala desde `package-lock.json`/shrinkwrap con egress limitado y ejecuta tests/build sin red.
- Go: valida sintaxis; con `go.mod` y `go.sum`, descarga módulos por el proxy y ejecuta `go test` offline.
- Rust: `rustc`/comprobaciones estáticas y, con `Cargo.toml` + `Cargo.lock`, `cargo fetch` restringido y `cargo test --offline`.
- Java/Maven: compila fuentes simples o resuelve dependencias con Maven bajo egress limitado y ejecuta `mvn -o test`.
- Gradle: usa el wrapper del proyecto para resolver/compilar con proxy y después ejecuta `test` offline.
- PHP/Composer y Ruby/Bundler: cuando hay lockfile y scripts de test, prepara dependencias con egress restringido y ejecuta tests offline.
- C/C++ y shell: comprobación sintáctica.
- Godot: cuando hay `project.godot`, importa el proyecto en modo headless, detecta errores comunes de parseo y arranca la escena principal durante 10 frames.
- HTML: Chromium/Xvfb ejecuta una copia temporal y detecta excepciones JavaScript; no se evalúa el HTML generado dentro del Worker.

La comprobación de HTML se ejecuta en el runner aislado con Chromium/Xvfb y una copia temporal del proyecto; el Worker no evalúa JavaScript HTML generado dentro de su propio contenedor. La detección automática está pensada para manifiestos de la raíz del proyecto; monorepos con varios gestores, SDK de Android/.NET/CUDA y builds que superan el tmpfs necesitan perfiles/imágenes específicas. El límite de 256 MiB por workspace hace que proyectos de dependencias pesadas fallen de forma explícita en vez de consumir disco del host.

La imagen es intencionalmente amplia para un entorno de desarrollo. No significa que todos los frameworks o SDK estén instalados. Para motores o SDK grandes (por ejemplo Android, .NET, CUDA, iOS/macOS), se deben crear imágenes de perfil versionadas y separadas, no inflar el runner general sin límite.

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
- en el wrapper local, una copia de proyecto montada como único volumen escribible; en la API, entrada montada de solo lectura y workspace en tmpfs limitado a 256 MiB;
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

Los instaladores de paquetes pueden ejecutar scripts de ciclo de vida, plugins y backends de compilación; el runner los ejecuta dentro del contenedor aislado, sin secretos y con salida de red limitada a la allowlist. Después de preparar dependencias, las pruebas funcionales se ejecutan en un contenedor nuevo con la red deshabilitada. Usá copias descartables y nunca expongas credenciales o datos privados al sandbox.

El modo restringido **falla cerrado** si no existe la red fija. No cambia a una red abierta como fallback. Para sumar un dominio, revisá primero por qué lo necesita el lockfile o el framework, agregalo a `allowed-domains.txt` y repetí la prueba de red. No agregues comodines amplios como `*`, dominios de almacenamiento genéricos o proveedores de túneles.

**Límites honestos:** Squid restringe los destinos HTTP/HTTPS que pasan por el proxy; la variable `HTTP_PROXY` por sí sola no obliga a programas maliciosos a usarlo. La red Docker interna evita la ruta IP directa habitual, pero el DNS embebido de Docker y la configuración de red del host deben evaluarse en la plataforma final. Para código realmente hostil o multiusuario, bloqueá DNS directo y cualquier salida adicional mediante firewall de host/política de egress, o usá una VM/microVM con política de red aplicada fuera del contenedor. La prueba CI verifica un host permitido y uno denegado, pero no sustituye una auditoría de escape o de exfiltración DNS.

La API no acepta una imagen Docker, comando de host, volumen adicional ni variables de entorno elegidas por el modelo. Recibe un arreglo argv, lo pasa como argumentos al contenedor y aplica una política fija. El comando no se ejecuta en un shell del host. La API tiene acceso al daemon Docker, por lo que debe ejecutarse en un host dedicado y no exponerse a la web pública.

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
- `npm run check` ejecuta las comprobaciones unitarias, las pruebas estáticas del runner API y la política de integración del Worker.
- `sh scripts/agent-sandbox-smoke.sh` construye el runner y el proxy, prueba Xvfb/Chromium con timeout, autentica la API real, ejecuta un comando dentro del contenedor, verifica que no herede secretos, recupera artefactos y prueba red deshabilitada/restringida, timeout y raíz de solo lectura.
- `docker build ...` construye la imagen local; no despliega nada.
- La prueba de extremo a extremo contra Render sigue siendo independiente y no debe ejecutarse desde cada rama experimental.

## Próximas etapas antes de integrarlo

1. Probar construcción de imagen y comandos de ejemplo en CI aislado.
2. Mantener las pruebas de timeout, límites de recursos, rutas sensibles y red: modo `none` y proxy con allowlist.
3. Crear perfiles versionados para runtimes pesados que realmente necesitemos.
4. Revisar el protocolo runner/worker ya implementado y ampliar los perfiles de ejecución según proyectos reales.
5. Provisionar el host privado de ejecución, generar un secreto independiente y configurar el firewall antes de habilitar `AGENT_RUNNER_BASE_URL`.
6. Mantener `AGENT_RUNNER_REQUIRED=false` hasta pasar pruebas en el host real; luego probar el flujo de corrección completo con tareas de ejemplo.
7. Integrar solo tras revisión del PR y pruebas; no desplegar automáticamente la API en Render Free.
