# Mapa de integración entre sistemas del Swarm

Este documento registra los puntos de acoplamiento entre el runner y los PR anteriores. La rama experimental no debe tratar los PR abiertos como si ya estuvieran integrados en `main`: GitHub no combina automáticamente sus ramas ni resuelve conflictos semánticos.

## Inventario de PRs abiertos revisados

| PR | Sistema | Archivos compartidos con otros PR | Regla de integración |
|---|---|---:|---|
| [#92](https://github.com/gavilandavid89-pixel/Multi-agent-swarm/pull/92) | Runner aislado y smoke Xvfb | 5 con #98; 3 con #103; 1 con #102 | Comparar su runner y sus tests con la API nueva antes de cerrar o integrar. |
| [#98](https://github.com/gavilandavid89-pixel/Multi-agent-swarm/pull/98) | Deliberación/votación y runner previo | 5 con #92; 2 con #99; 4 con #102; 7 con #103 | No sobrescribir `multiAiEngine.js`, `server.js`, CI ni UI sin reconciliar ambos cambios. |
| [#99](https://github.com/gavilandavid89-pixel/Multi-agent-swarm/pull/99) | Visor de escritorio Chromium autenticado | 2 con #100; 2 con #98 | El visor sigue siendo una UI independiente; no se debe confundir con el navegador headless del runner. |
| [#100](https://github.com/gavilandavid89-pixel/Multi-agent-swarm/pull/100) | Controles seguros de navegador | 2 con #99 | Integrar sobre el mismo servidor del visor con revisión de autenticación y pruebas; no crear un segundo camino de ejecución arbitraria. |
| [#102](https://github.com/gavilandavid89-pixel/Multi-agent-swarm/pull/102) | Bandeja de diagnósticos e imagen IDE | 4 con #98; 3 con #103; 1 con #92 | Conservar sus cambios de almacenamiento/rutas diagnósticas al reconciliar `server.js`, `package.json`, CI y README. |
| [#103](https://github.com/gavilandavid89-pixel/Multi-agent-swarm/pull/103) | Sandbox multi-lenguaje, herramientas y coordinación de agentes | 3 con #92; 7 con #98; 3 con #102 | Mantener draft. Integrar por cambios pequeños y pruebas contractuales; no fusionar ni desplegar como parte de esta rama. |

El recuento refleja intersecciones de rutas modificadas, no una conclusión automática de que el código sea incompatible. Los PRs citados permanecen abiertos; por eso, cada integración futura debe comprobar el estado real de sus ramas antes de aplicar cambios.

### Dependencias reales entre ramas

- #98 (`feature/live-committee-debate`) parte de `main`.
- #99 (`feature/live-agent-desktop-viewer`) está basado en el head de #98.
- #100 (`feature/browser-environment-toolkit`) está basado en el head de #99.
- #102 (`feature/diagnostic-inbox-and-agent-ide`) está basado en el head de #100.
- #103 (`feature/agent-execution-sandbox`) parte de `main` y **no incluye automáticamente** los cambios de esa cadena.
- #92 usa una base más antigua e independiente; sus cambios de runner deben compararse con las implementaciones posteriores, no asumirse compatibles por compartir nombres.

Por tanto, #98 → #99 → #100 → #102 es una cadena de PRs apilados. No conviene integrar #99/#100/#102 contra `main` ignorando sus bases, ni fusionar #103 encima de una copia vieja de `multiAiEngine.js`, `server.js` o CI. Antes de una integración final hay que actualizar/reconciliar las bases y repetir CI; esta rama solo registra el mapa y no rebasea ni fusiona esos PRs.

## Contratos que deben permanecer alineados

1. **Worker → Runner API:** el Worker es el único cliente autenticado. El catálogo, la creación de jobs, el polling, la cancelación y los artefactos deben usar los mismos endpoints y contrato de idempotencia.
2. **Permisos por rol → catálogo:** `agentToolDispatcher.js` es la autoridad ejecutable para permisos. `apps/runner/capabilities.json` es metadato de descubrimiento y documentación, no una concesión de permisos; su inventario de roles/herramientas debe reflejar al dispatcher.
3. **Runner → contenedor:** el modelo no elige imagen, mounts, secretos, política de red ni límites. La ejecución normal usa `network=none`; la preparación de dependencias es una operación distinta y limitada.
4. **Entorno de navegador:** Chromium/Xvfb headless sirve para smoke tests automatizados. El visor noVNC es una interfaz separada y no debe presentarse como la sesión real del agente hasta que exista una integración explícita y segura.
5. **Feed/tablero/hallazgos/checkpoints:** son estado de coordinación del Worker y no se deben duplicar en el runner. El runner emite resultados/evidencia; el agente responsable decide el estado de su tarea.
6. **Diagnósticos/IDE:** los reportes y el IDE son superficies de soporte; no deben recibir secretos del runner ni abrir acceso directo al host o al socket Docker.

## Hallazgo corregido en esta rama

La revisión detectó que `capabilities.json` enumeraba seis roles y solo las herramientas de workspace/runner, mientras el dispatcher ya expone siete roles y también las herramientas de feed, tablero y hallazgos. El catálogo ahora enumera los siete roles y las seis herramientas de coordinación, y el test de la Runner API verifica que no desaparezcan ni se omitan los límites de seguridad. La política real continúa aplicándose en el Worker.

## Orden seguro para la integración final

1. Comparar cambios de cada PR abierto por archivo; no copiar una versión completa de `server.js`, `multiAiEngine.js`, CI o UI encima de otra.
2. Reconciliar la familia del runner (#92, #98, #103) para mantener una API/cliente canónicos y conservar los smoke tests útiles.
3. Reconciliar diagnósticos (#102) y votaciones (#98) con el Worker, comprobando que los checkpoints y la contabilidad transaccional sobrevivan.
4. Reconciliar visor y controles (#99, #100) por separado; mantener el visor fuera de la ruta de ejecución hasta probar el enlace explícito.
5. Ejecutar CI sobre el SHA final, pruebas de contrato entre Worker/API/catálogo, reinicios del runner y pruebas smoke en el host aislado.
6. Mantener el runner remoto optativo y sin despliegue hasta validar un host dedicado, firewall, egress, almacenamiento e idempotencia real.

## Límite de validación

Los tests de contrato y CI pueden verificar rutas, schemas, permisos y comportamiento simulado. No prueban por sí solos un reinicio real entre aceptación del job y persistencia del resultado, ni la seguridad de un host de ejecución que todavía no está provisionado. No declarar producción lista hasta probar esas ventanas y la frontera de infraestructura.
