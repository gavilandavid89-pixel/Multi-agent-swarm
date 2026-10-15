/** Provider response translation boundary.
 * Converts supported vendor payloads into a versioned, provider-neutral envelope.
 * Unknown structures fail closed; never guess a field path or execute provider content.
 */
function invalidResponse(message, code = 'PROVIDER_INVALID_JSON') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function parseProviderResponseBody(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(String(bodyText ?? ''));
  } catch {
    throw invalidResponse('El proveedor devolvió un cuerpo que no es JSON válido.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidResponse('El proveedor devolvió una respuesta JSON con una estructura inesperada.');
  }
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

function normalizeUsage(raw = {}) {
  const inputTokens = raw.input_tokens ?? raw.prompt_tokens ?? raw.promptTokenCount ?? raw.inputTokens;
  const outputTokens = raw.output_tokens ?? raw.completion_tokens ?? raw.candidatesTokenCount ?? raw.outputTokens;
  const explicitTotal = raw.total_tokens ?? raw.totalTokenCount ?? raw.totalTokens;
  const totalTokens = explicitTotal ?? ((inputTokens != null || outputTokens != null)
    ? (Number(inputTokens) || 0) + (Number(outputTokens) || 0)
    : null);
  return {
    inputTokens: inputTokens == null ? null : Number(inputTokens) || 0,
    outputTokens: outputTokens == null ? null : Number(outputTokens) || 0,
    totalTokens: totalTokens == null ? null : Number(totalTokens) || 0
  };
}

function normalizeFinishReason(reason) {
  if (reason == null || reason === '') return null;
  const value = String(reason).toLowerCase();
  if (['stop', 'end_turn', 'stop_sequence', 'completed'].includes(value)) return 'stop';
  if (['length', 'max_tokens', 'max_output_tokens', 'model_length'].includes(value)) return 'length';
  if (['content_filter', 'refusal', 'safety', 'blocked'].includes(value)) return 'content_filter';
  if (['tool_calls', 'tool_use', 'function_call'].includes(value)) return 'tool_calls';
  return String(reason);
}

function canonical(content, { provider = 'unknown', model = null, status = 'success', usage = {}, finishReason = null, toolCalls = [], warnings = [] } = {}) {
  return {
    schemaVersion: 1,
    status,
    provider: String(provider || 'unknown'),
    model: typeof model === 'string' && model ? model : null,
    content: String(content ?? ''),
    toolCalls,
    usage: normalizeUsage(usage),
    finishReason: normalizeFinishReason(finishReason),
    warnings
  };
}

function fromAnthropic(data, options) {
  if (data.type !== 'message' || !Array.isArray(data.content)) return null;
  const textBlocks = data.content.filter(block => block?.type === 'text' && typeof block.text === 'string');
  const toolBlocks = data.content.filter(block => block?.type === 'tool_use');
  const unknownBlocks = data.content.filter(block => !['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(block?.type));
  const toolCalls = toolBlocks.map(block => ({
    id: String(block.id || ''),
    name: String(block.name || ''),
    input: block.input ?? null
  }));
  const warnings = [];
  if (unknownBlocks.length) warnings.push('ANTHROPIC_NON_TEXT_BLOCKS_OMITTED');
  if (data.stop_reason === 'refusal') warnings.push('PROVIDER_REFUSAL');
  return canonical(textBlocks.map(block => block.text).join(''), {
    ...options,
    provider: options.provider || 'Anthropic',
    model: data.model || options.model,
    status: data.stop_reason === 'refusal' ? 'blocked' : 'success',
    usage: data.usage,
    finishReason: data.stop_reason,
    toolCalls,
    warnings
  });
}

function fromGemini(data, options) {
  if (!Array.isArray(data.candidates) && !(data.promptFeedback && typeof data.promptFeedback === 'object')) return null;
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const content = textFromParts(parts);
  const blocked = !candidate && Boolean(data.promptFeedback?.blockReason);
  return canonical(content, {
    ...options,
    provider: options.provider || 'Gemini',
    model: data.modelVersion || options.model,
    status: blocked ? 'blocked' : 'success',
    usage: data.usageMetadata || {},
    finishReason: blocked ? 'content_filter' : candidate?.finishReason,
    warnings: blocked ? ['GEMINI_PROMPT_BLOCKED'] : []
  });
}

function fromOpenAIChat(data, options) {
  if (!Array.isArray(data.choices)) return null;
  const choice = data.choices[0] || {};
  const message = choice.message && typeof choice.message === 'object' ? choice.message : {};
  let content = typeof message.content === 'string' ? message.content : textFromParts(message.content);
  if (!content && typeof message.refusal === 'string') content = message.refusal;
  if (!content && typeof choice.text === 'string') content = choice.text;
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map(call => ({
    id: String(call?.id || ''),
    name: String(call?.function?.name || call?.name || ''),
    arguments: call?.function?.arguments ?? call?.arguments ?? null
  })) : [];
  return canonical(content, {
    ...options,
    model: data.model || options.model,
    usage: data.usage || {},
    finishReason: choice.finish_reason ?? choice.finishReason,
    status: message.refusal ? 'blocked' : 'success',
    toolCalls,
    warnings: message.refusal ? ['PROVIDER_REFUSAL'] : []
  });
}

function fromResponsesApi(data, options) {
  if (typeof data.output_text !== 'string' && !Array.isArray(data.output)) return null;
  const items = Array.isArray(data.output) ? data.output : [];
  const text = typeof data.output_text === 'string'
    ? data.output_text
    : items.flatMap(item => Array.isArray(item?.content) ? item.content : [])
      .filter(part => ['output_text', 'text'].includes(part?.type) && typeof part.text === 'string')
      .map(part => part.text).join('');
  const toolCalls = items.filter(item => ['function_call', 'tool_call'].includes(item?.type)).map(item => ({
    id: String(item.call_id || item.id || ''),
    name: String(item.name || ''),
    arguments: item.arguments ?? null
  }));
  return canonical(text, {
    ...options,
    model: data.model || options.model,
    usage: data.usage || {},
    finishReason: data.status === 'incomplete' ? 'length' : data.status,
    status: data.status === 'failed' ? 'error' : 'success',
    toolCalls
  });
}

/** Translate supported provider-native response payloads to the canonical envelope. */
export function normalizeProviderResponse(data, options = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw invalidResponse('El proveedor devolvió una respuesta con una estructura inesperada.');
  }
  const translated = fromAnthropic(data, options)
    || fromGemini(data, options)
    || fromOpenAIChat(data, options)
    || fromResponsesApi(data, options);
  if (translated) return translated;

  if (typeof data.response === 'string' || typeof data.result === 'string') {
    return canonical(data.response ?? data.result, {
      ...options,
      model: data.model || options.model,
      usage: data.usage || data.usageMetadata || {},
      finishReason: data.finish_reason ?? data.finishReason ?? data.status
    });
  }
  throw invalidResponse('El proveedor devolvió un formato de respuesta no compatible con el motor.', 'PROVIDER_UNSUPPORTED_RESPONSE');
}

/** Legacy adapter for the existing worker engine contract; canonical metadata is retained. */
export function normalizeOpenAICompatibleResponse(data) {
  const normalized = normalizeProviderResponse(data);
  if (normalized.status === 'error') {
    throw invalidResponse('El proveedor informó un error en su respuesta.', 'PROVIDER_RESPONSE_ERROR');
  }
  return {
    ...data,
    choices: [{
      message: {
        content: normalized.content,
        ...(normalized.toolCalls.length ? { tool_calls: normalized.toolCalls } : {}),
        ...(normalized.status === 'blocked' ? { refusal: normalized.content || 'Respuesta bloqueada por el proveedor.' } : {})
      },
      finish_reason: normalized.finishReason
    }],
    usage: {
      ...(data.usage || {}),
      prompt_tokens: normalized.usage.inputTokens,
      completion_tokens: normalized.usage.outputTokens,
      total_tokens: normalized.usage.totalTokens
    },
    _normalized: normalized
  };
}

export function validateGeminiResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw invalidResponse('Gemini devolvió una respuesta con una estructura inesperada.');
  }
  if (Array.isArray(data.candidates)) return data;
  if (data.promptFeedback && typeof data.promptFeedback === 'object') return data;
  throw invalidResponse('Gemini devolvió un formato de respuesta no compatible con el motor.', 'PROVIDER_UNSUPPORTED_RESPONSE');
}
