#!/usr/bin/env python3
"""Read-only, sanitized audit of Render env vars for Multi Agent Swarm.

Never prints raw values, credentials, tokens, or hashes. Requires RENDER_API_KEY.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API_BASE = "https://api.render.com/v1"
SERVICES = {
    "swarm-bridge": "srv-db5ajh2jnfac739qae00",
    "swarm-worker": "srv-db5ajfijnfac739qa64g",
    "swarm-desktop-viewer-live": "srv-db9v0qbrjlhs73895ngg",
    "swarm-desktop-viewer": "srv-db9v08nbtjjs73d5e39g",
}
SHARED_KEYS = ("WORKER_SHARED_SECRET", "SWARM_API_ENCRYPTION_KEY", "SWARM_DATABASE_URL")
EXPECTED_KEYS = {
    "swarm-bridge": ("NODE_ENV", "WORKER_BASE_URL", "WORKER_SHARED_SECRET", "APP_ACCESS_KEY", "SWARM_DATABASE_URL", "SWARM_API_ENCRYPTION_KEY"),
    "swarm-worker": ("NODE_ENV", "PORT", "WORKER_SHARED_SECRET", "GROQ_API_KEY", "GEMINI_API_KEY", "AI_FALLBACK_PROVIDERS", "HISTORY_ENCRYPTION_KEY", "DATABASE_URL", "SWARM_DATABASE_URL", "SWARM_API_ENCRYPTION_KEY", "DATABASE_PATH"),
    "swarm-desktop-viewer-live": (),
    "swarm-desktop-viewer": (),
}
SENSITIVE_WORDS = ("SECRET", "KEY", "TOKEN", "PASSWORD", "CREDENTIAL", "AUTH")


class AuditError(Exception):
    pass


def api_get(path: str, token: str):
    request = urllib.request.Request(
        API_BASE + path,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "User-Agent": "multi-agent-swarm-readonly-audit"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise AuditError(f"Render rechazó la API key (HTTP {exc.code}). Revisa su validez y permisos.") from None
        raise AuditError(f"Render devolvió HTTP {exc.code} al consultar la API.") from None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        raise AuditError("No se pudo completar la consulta a Render (conexión, timeout o respuesta no válida).") from None


def unpack_env_items(payload):
    if isinstance(payload, dict):
        # Be tolerant of an API envelope while never assuming values are safe to display.
        for key in ("envVars", "items", "data", "results"):
            if isinstance(payload.get(key), list):
                payload = payload[key]
                break
        else:
            raise AuditError("Formato de respuesta inesperado en el endpoint de variables.")
    if not isinstance(payload, list):
        raise AuditError("Formato de respuesta inesperado en el endpoint de variables.")
    result = {}
    for item in payload:
        if not isinstance(item, dict):
            continue
        env = item.get("envVar", item)
        if isinstance(env, dict) and isinstance(env.get("key"), str):
            result[env["key"]] = "" if env.get("value") is None else str(env.get("value"))
    return result


def get_service_env(service_id, token):
    # Render's list endpoint is cursor-paginated; keep each page bounded.
    cursor = None
    collected = {}
    for _ in range(30):
        query = "?limit=100"
        if cursor:
            query += "&cursor=" + urllib.parse.quote(cursor, safe="")
        payload = api_get(f"/services/{service_id}/env-vars{query}", token)
        collected.update(unpack_env_items(payload))
        if not isinstance(payload, list) or not payload:
            break
        next_cursor = payload[-1].get("cursor") if isinstance(payload[-1], dict) else None
        if not next_cursor or len(payload) < 100:
            break
        cursor = str(next_cursor)
    else:
        raise AuditError("Se alcanzó el límite de páginas al leer variables de entorno.")
    return collected


def url_destination(value):
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in ("postgres", "postgresql", "http", "https"):
            return "configurado; destino no interpretable"
        host = parsed.hostname or "(host ausente)"
        database = urllib.parse.unquote(parsed.path.lstrip("/").split("/")[0]) if parsed.path else ""
        # Only host and database name are reported; never userinfo, query params, or passwords.
        return f"host={host}" + (f"; database={database}" if database else "")
    except Exception:
        return "configurado; no se pudo interpretar el destino"


def main():
    token = os.environ.get("RENDER_API_KEY", "").strip()
    if not token:
        print("Falta RENDER_API_KEY. Configúrala como secreto del entorno de ejecución; no la pongas en el código.", file=sys.stderr)
        return 2

    audit = {}
    try:
        for name, service_id in SERVICES.items():
            audit[name] = get_service_env(service_id, token)
    except AuditError as exc:
        print(f"Auditoría incompleta: {exc}", file=sys.stderr)
        return 1

    lines = [
        "# Auditoría sanitizada de variables Render — Multi Agent Swarm",
        "",
        f"- Fecha UTC: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}",
        "- Método: solo lectura (GET).",
        "- Seguridad: los valores secretos, tokens, hashes y cadenas de conexión completas no se incluyen en este informe.",
        "",
        "## Servicios y variables",
        "",
    ]
    for service, values in audit.items():
        lines += [f"### {service}", "", f"- Variables directas encontradas: {len(values)}"]
        expected = EXPECTED_KEYS[service]
        if expected:
            for key in expected:
                lines.append(f"- `{key}`: " + ("PRESENTE" if key in values and values[key] != "" else "AUSENTE/VACÍA"))
        else:
            lines.append("- No hay una lista de variables esperadas definida para este servicio; se reporta solo el recuento.")
        for key in ("WORKER_BASE_URL", "DATABASE_URL", "SWARM_DATABASE_URL"):
            if key in values and values[key]:
                lines.append(f"- Destino de `{key}`: {url_destination(values[key])}")
        if "DATABASE_PATH" in values and values["DATABASE_PATH"]:
            lines.append(f"- `DATABASE_PATH`: ruta configurada (valor omitido)")
        lines.append("")

    lines += ["## Comparación de variables compartidas", ""]
    for key in SHARED_KEYS:
        bridge = audit.get("swarm-bridge", {}).get(key)
        worker = audit.get("swarm-worker", {}).get(key)
        if not bridge or not worker:
            status = "NO VERIFICABLE: falta en uno o ambos servicios"
        else:
            status = "COINCIDE" if bridge == worker else "NO COINCIDE"
        lines.append(f"- `{key}`: **{status}**")
    lines += [
        "",
        "## Límites de esta auditoría",
        "",
        "- El endpoint de variables de servicio no incluye valores heredados de Environment Groups; revisa esos grupos por separado.",
        "- La presencia o coincidencia de una variable no demuestra que el servicio remoto la esté usando correctamente.",
        "- No se realizan escrituras, cambios de configuración, reinicios ni despliegues.",
        "",
    ]
    output = Path(os.environ.get("AUDIT_OUTPUT", "swarm-render-env-audit.md"))
    output.write_text("\n".join(lines), encoding="utf-8")
    print(f"Informe sanitizado generado: {output}")
    print("No se imprimieron valores de variables ni credenciales.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AuditError as exc:
        print(f"Auditoría incompleta: {exc}", file=sys.stderr)
        raise SystemExit(1)
