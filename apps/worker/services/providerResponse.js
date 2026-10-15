/** Parse provider bodies and normalize response variants the worker can safely consume. */
function invalidResponse(message, code = 'PROVIDER_INVALID_JSON') {
  const error = new Error(message); error.code = code; return error;
}
export function parseProviderResponseBody(bodyText) {
  let parsed;
  try { parsed = JSON.parse(String(bodyText ?? '')); }
  catch { throw invalidResponse('El proveedor devolvió un cuerpo que no es JSON válido.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidResponse('El proveedor devolvió una respuesta JSON con una estructura inesperada.');
  return parsed;
}
function textFromParts(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(part => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.output_text === 'string') return part.output_text;
    if (typeof part.content === 'string') return part.content;
    return '';
  }).join('');
}
/** Canonicalize common OpenAI-compatible Chat Completions and Responses API output. */
export function normalizeOpenAICompatibleResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidResponse('El proveedor devolvió una respuesta con una estructura inesperada.');
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  const message = choice?.message && typeof choice.message === 'object' ? choice.message : {};
  let content = '';
  let finishReason = choice?.finish_reason ?? choice?.finishReason ?? null;
  if (typeof message.content === 'string') content = message.content;
  else if (Array.isArray(message.content)) content = textFromParts(message.content);
  else if (typeof message.refusal === 'string') content = message.refusal;
  else if (typeof choice?.text === 'string') content = choice.text;
  if (!content && typeof data.output_text === 'string') content = data.output_text;
  if (!content && Array.isArray(data.output)) content = data.output.map(item => textFromParts(item?.content)).join('');
  if (!content && typeof data.response === 'string') content = data.response;
  if (!content && typeof data.result === 'string') content = data.result;
  if (!choice && !content) throw invalidResponse('El proveedor devolvió un formato de respuesta no compatible con el motor.', 'PROVIDER_UNSUPPORTED_RESPONSE');
  if (!choice && content) finishReason = data.status === 'incomplete' ? 'length' : (data.status || null);
  const rawUsage = data.usage || data.usageMetadata || {};
  const usage = {
    ...rawUsage,
    prompt_tokens: rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? rawUsage.promptTokenCount,
    completion_tokens: rawUsage.completion_tokens ?? rawUsage.output_tokens ?? rawUsage.candidatesTokenCount,
    total_tokens: rawUsage.total_tokens ?? rawUsage.totalTokenCount
  };
  if (usage.total_tokens == null && (usage.prompt_tokens != null || usage.completion_tokens != null)) usage.total_tokens = (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
  return { ...data, choices: [{ ...(choice || {}), message: { ...message, content }, finish_reason: finishReason }], usage };
}
export function validateGeminiResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidResponse('Gemini devolvió una respuesta con una estructura inesperada.');
  if (Array.isArray(data.candidates)) return data;
  if (data.promptFeedback && typeof data.promptFeedback === 'object') return data;
  throw invalidResponse('Gemini devolvió un formato de respuesta no compatible con el motor.', 'PROVIDER_UNSUPPORTED_RESPONSE');
}
