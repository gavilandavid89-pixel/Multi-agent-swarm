/** Parse a provider's successful HTTP response without letting malformed JSON crash a task. */
export function parseProviderResponseBody(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(String(bodyText ?? ''));
  } catch {
    const error = new Error('El proveedor devolvió un cuerpo que no es JSON válido.');
    error.code = 'PROVIDER_INVALID_JSON';
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('El proveedor devolvió una respuesta JSON con una estructura inesperada.');
    error.code = 'PROVIDER_INVALID_JSON';
    throw error;
  }
  return parsed;
}
