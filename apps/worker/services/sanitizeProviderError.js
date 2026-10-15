const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-or-v1-[A-Za-z0-9_-]{8,}\b/g,
  /\bgsk_[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g
];

/**
 * Provider error payloads are untrusted. Redact the credential for the active
 * request plus recognizable provider-key formats before errors are exposed or saved.
 */
export function sanitizeProviderErrorBody(body, activeApiKey, maxLength = 800) {
  let safe = String(body ?? '');
  if (typeof activeApiKey === 'string' && activeApiKey.length >= 4) {
    safe = safe.split(activeApiKey).join('[REDACTED_API_KEY]');
  }
  for (const pattern of SECRET_PATTERNS) safe = safe.replace(pattern, '[REDACTED_API_KEY]');
  safe = safe.replace(/((?:api[_ -]?key|authorization|bearer|access[_ -]?token|secret)\s*[:=]\s*)([^\s"'\x27,}]{8,})/gi, '$1[REDACTED]');
  return safe.slice(0, Math.max(0, Math.min(2000, Number(maxLength) || 800)));
}
