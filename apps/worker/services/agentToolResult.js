/**
 * Serialize a tool result without ever cutting JSON mid-token.
 * The preview budget accounts for JSON escaping when the provider wraps this
 * string in its own tool-result message.
 */
export function serializeAgentToolResult(result, maxChars = 16000) {
  const limit = Number.isInteger(maxChars) ? Math.max(256, Math.min(maxChars, 64000)) : 16000;
  let serialized;
  try {
    serialized = JSON.stringify(result ?? { ok: true });
  } catch {
    serialized = null;
  }
  if (typeof serialized !== 'string') serialized = JSON.stringify({ ok: false, error: 'Resultado no serializable.' });
  if (serialized.length <= limit) return serialized;

  const summary = JSON.stringify({
    ok: false,
    truncated: true,
    serializedChars: serialized.length,
    preview: serialized.slice(0, Math.max(0, Math.floor((limit - 256) / 3))),
    message: 'La salida de herramienta se resumió para preservar un JSON válido.'
  });
  if (summary.length <= limit) return summary;
  return JSON.stringify({
    ok: false,
    truncated: true,
    serializedChars: serialized.length,
    message: 'Salida de herramienta omitida por exceder el límite seguro.'
  });
}
