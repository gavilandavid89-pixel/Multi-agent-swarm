# Auditoría de variables de Render para Multi Agent Swarm

El script `scripts/auditar_render_env_swarm.py` consulta variables de entorno de los servicios de Swarm mediante la API oficial de Render, en modo solo lectura.

## Ejecución recomendada desde GitHub Actions

1. En GitHub, abre **Settings → Secrets and variables → Actions** del repositorio.
2. Crea un **Repository secret** llamado `RENDER_API_KEY` con una API key de Render que tenga permisos suficientes para leer los servicios.
3. Abre **Actions → Auditoría de variables Render (solo lectura) → Run workflow**.
4. Al terminar, descarga el artefacto `swarm-render-env-audit`.

No añadas la API key al código, a un archivo `.env` versionado, a logs ni a los valores de configuración de los servicios de la aplicación. No la pegues en conversaciones.

## Alcance y seguridad

- Solo se hacen solicitudes HTTP GET; no se actualizan variables ni se despliega nada.
- El informe enumera variables esperadas, indica presencia/ausencia y compara en memoria algunos valores compartidos.
- No muestra valores secretos, tokens, hashes ni cadenas de conexión completas.
- Solo inspecciona variables directas de cada servicio; las variables heredadas de Render Environment Groups no aparecen en el endpoint por servicio y requieren una comprobación aparte.
- La API key debe tratarse como una credencial sensible. Usa una clave con el alcance mínimo disponible y revócala si se expone.


## Interpretación de las claves de proveedores en el modelo multiusuario

El Swarm está pensado para que **cada usuario configure sus propias APIs desde el panel web `APIs`**. Las credenciales de cada cuenta se almacenan en `user_api_keys`, vinculadas al `user_id` y cifradas con `SWARM_API_ENCRYPTION_KEY`.

Por eso, que la auditoría encuentre `GROQ_API_KEY` o `GEMINI_API_KEY` en el entorno de `swarm-worker` solo confirma que hay credenciales de proveedor configuradas a nivel de despliegue (herencia de la beta/fallback); **no significa que sean las claves personales de los usuarios ni que deban compartirse entre ellos**. Del mismo modo, que `AI_FALLBACK_PROVIDERS` aparezca ausente no demuestra por sí solo un fallo del flujo normal de APIs por usuario.

La auditoría actual enumera esas variables porque existen en la configuración histórica del Worker. No valida si el código aún necesita las claves globales para fallback, ni comprueba que una API configurada desde el panel funcione de extremo a extremo. Antes de retirar o cambiar las variables globales, revisar las rutas de selección de proveedor y fallback en el Worker. Esta nota documenta el modelo multiusuario y evita interpretar la auditoría de presencia como requisito de compartir claves globales.
