import { createHash, randomUUID } from 'node:crypto';
import { getProviderRetryDelayMs } from './providerRetryPolicy.js';
import { normalizeProviderResponse, parseProviderResponseBody, validateGeminiResponse } from './providerResponse.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryableStatus = status => status === 408 || status === 425 || status === 429 || status >= 500;

const configuredRetries = Number.parseInt(process.env.MAX_PROVIDER_RETRIES || '4', 10);
const MAX_PROVIDER_RETRIES = Number.isFinite(configuredRetries) ? Math.min(8, Math.max(1, configuredRetries)) : 4;

function deferredProviderError(model, retry, wait, reason) {
  const error = new Error(`Gemini temporalmente no disponible (${reason}); se reanudará en ${Math.ceil(wait / 1000)} s.`);
  error.code = 'PROVIDER_TEMPORARY';
  error.retryAfterMs = wait;
  error.providerModel = model;
  error.providerRetry = retry;
  return error;
}

function retryDelay(retry, retryAfter, bodyText = '') {
  const configuredBase = Number(process.env.RETRY_BASE_MS || 3000);
  const base = Number.isFinite(configuredBase) ? Math.min(60000, Math.max(250, configuredBase)) : 3000;
  return getProviderRetryDelayMs({ retry, retryAfter, bodyText, baseMs: base, random: Math.random });
}

function estimateInputTokens(messages) {
  const characters = (Array.isArray(messages) ? messages : []).reduce((sum, message) => sum + String(message?.content ?? '').length, 0);
  return Math.ceil(characters / 2.5) + (Array.isArray(messages) ? messages.length * 8 : 0);
}

function geminiSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'OBJECT', properties: {} };
  const output = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['additionalProperties', 'minItems', 'maxItems', 'minimum', 'maximum'].includes(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      output.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, geminiSchema(child)]));
    } else if (key === 'items') output.items = geminiSchema(value);
    else if (key === 'type' && typeof value === 'string') output.type = value.toUpperCase();
    else output[key] = value;
  }
  return output;
}

function toGeminiContents(messages) {
  const contents = [];
  const systemParts = [];
  for (const item of Array.isArray(messages) ? messages : []) {
    if (item.role === 'system') {
      const text = String(item?.content ?? '');
      if (text) systemParts.push({ text });
      continue;
    }
    let role = item.role === 'assistant' ? 'model' : 'user';
    let parts = [];
    if (role === 'model' && Array.isArray(item?.geminiParts) && item.geminiParts.length) {
      // Gemini 3 requires provider-returned thought signatures to round-trip with the exact parts.
      // Preserve all original parts rather than rebuilding only functionCall blocks.
      parts = structuredClone(item.geminiParts);
    } else if (role === 'model' && Array.isArray(item?.tool_calls)) {
      parts = item.tool_calls.map((call, callIndex) => {
        let args = {};
        try { args = JSON.parse(String(call?.function?.arguments || '{}')); } catch {}
        const thoughtSignature = String(call?.thought_signature || call?.thoughtSignature || call?.function?.thought_signature || call?.function?.thoughtSignature || '');
        // Cross-provider or legacy tool calls have no Gemini signature. Google documents this
        // sentinel for imported calls; only the first parallel call needs a signature.
        const signature = thoughtSignature || (callIndex === 0 ? 'skip_thought_signature_validator' : '');
        return { functionCall: { name: String(call?.function?.name || ''), args, id: String(call.id || '') }, ...(signature ? { thoughtSignature: signature } : {}) };
      });
      if (item.content) parts.unshift({ text: String(item.content) });
    } else if (item.role === 'tool') {
      let response = {};
      try { response = JSON.parse(String(item.content || '{}')); } catch { response = { result: String(item.content || '') }; }
      parts = [{ functionResponse: { name: String(item.name || 'tool'), id: String(item.tool_call_id || ''), response } }];
    } else {
      const text = String(item?.content ?? '');
      if (!text) continue;
      parts = [{ text }];
    }
    const previous = contents[contents.length - 1];
    if (previous?.role === role && previous.parts.every(part => part.text !== undefined) && parts.every(part => part.text !== undefined)) previous.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return { contents, ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}) };
}


export async function consultarGemini({
  model,
  messages,
  temperature = 0.3,
  maxTokens = 1200,
  responseFormat,
  onRetry = () => {},
  continueOnLength = false,
  maxContinuations = 4,
  canContinue = () => true,
  onPartialOutput = () => {},
  tools,
  onToolCall,
  maxToolRounds = 8,
  failoverOnRetryable = false,
  beforeProviderRequest,
  apiKey: suppliedApiKey,
  conversationStore = null
}) {
  const apiKey = suppliedApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Falta configurar GEMINI_API_KEY en el servicio swarm-worker.');

  const configuredOutput = Number.parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS_PER_CALL || '60000', 10);
  const maxSafeOutputTokens = Math.min(60000, Math.max(256, Number.isFinite(configuredOutput) ? configuredOutput : 60000));
  const requestedMaxTokens = Math.max(256, Number(maxTokens) || 1200);
  let safeMaxTokens = Math.min(maxSafeOutputTokens, requestedMaxTokens);
  let retry = 0;
  let emptyRetries = 0;
  const baseHash = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  const savedConversation = typeof conversationStore?.loadConversation === 'function'
    ? await conversationStore.loadConversation(baseHash) : null;
  if (savedConversation?.baseHash === baseHash && savedConversation.status === 'completed' && typeof savedConversation.result === 'string') {
    return savedConversation.result;
  }
  let continuationCount = Number(savedConversation?.continuationCount) || 0;
  let requestMessages = savedConversation?.baseHash === baseHash && Array.isArray(savedConversation.messages) ? savedConversation.messages : messages;
  let toolRounds = requestMessages.filter(item => item?.role === 'assistant' && Array.isArray(item.tool_calls)).length;
  let accumulatedContent = savedConversation?.baseHash === baseHash && typeof savedConversation.accumulatedContent === 'string' ? savedConversation.accumulatedContent : '';
  const saveConversation = async (status = 'active', result = undefined) => {
    if (typeof conversationStore?.saveConversation !== 'function') return;
    const snapshot = { baseHash, messages: requestMessages, toolRounds, accumulatedContent, continuationCount, status,
      ...(typeof result === 'string' ? { result } : {}) };
    if (JSON.stringify(snapshot).length > 900000) {
      const error = new Error('El checkpoint de conversación de Gemini supera el límite seguro de 900 KB.');
      error.code = 'AGENT_CONVERSATION_CHECKPOINT_TOO_LARGE';
      throw error;
    }
    await conversationStore.saveConversation(snapshot);
  };
  const recoverPendingToolCalls = async () => {
    let assistantIndex = -1;
    for (let i = requestMessages.length - 1; i >= 0; i--) {
      if (requestMessages[i]?.role === 'assistant' && Array.isArray(requestMessages[i].tool_calls)) { assistantIndex = i; break; }
    }
    if (assistantIndex < 0) return;
    const calls = requestMessages[assistantIndex].tool_calls.slice(0, 8);
    const completedIds = new Set(requestMessages.slice(assistantIndex + 1).filter(item => item?.role === 'tool').map(item => String(item.tool_call_id || '')));
    if (calls.some(call => !completedIds.has(String(call?.id || ''))) && (!Array.isArray(tools) || !tools.length || typeof onToolCall !== 'function')) {
      const error = new Error('Hay llamadas de herramientas de Gemini pendientes en el checkpoint, pero no hay dispatcher autorizado.');
      error.code = 'AGENT_TOOL_DISPATCH_UNAVAILABLE';
      throw error;
    }
    for (const call of calls) {
      const id = String(call?.id || '');
      if (completedIds.has(id)) continue;
      const name = String(call?.function?.name || '');
      let args;
      try { args = JSON.parse(String(call?.function?.arguments || '{}')); } catch { args = null; }
      let result;
      try {
        if (!name || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Argumentos de herramienta inválidos.');
        result = await onToolCall({ id, name, arguments: args, model, provider: 'Gemini', recovered: true });
      } catch (toolError) {
        result = { ok: false, error: String(toolError?.message || 'La herramienta falló.').slice(0, 1000), code: String(toolError?.code || 'AGENT_TOOL_FAILED').slice(0, 80) };
      }
      let serialized;
      try { serialized = JSON.stringify(result ?? { ok: true }); } catch { serialized = JSON.stringify({ ok: false, error: 'Resultado no serializable.' }); }
      requestMessages.push({ role: 'tool', tool_call_id: id, name, content: serialized.slice(0, 12000) });
      completedIds.add(id);
      await saveConversation();
    }
  };
  await recoverPendingToolCalls();

  while (true) {
    if (beforeProviderRequest) await beforeProviderRequest();
    const usageId = randomUUID();
    const converted = toGeminiContents(requestMessages);
    if (!converted.contents.length) throw new Error('Gemini recibió una conversación vacía.');
    const body = {
      ...converted,
      generationConfig: {
        temperature,
        maxOutputTokens: safeMaxTokens,
        ...(responseFormat ? { responseMimeType: 'application/json' } : {})
      },
      ...(Array.isArray(tools) && tools.length ? {
        tools: [{ functionDeclarations: tools.map(item => ({
          name: String(item?.function?.name || ''),
          description: String(item?.function?.description || ''),
          parameters: geminiSchema(item?.function?.parameters || { type: 'object', properties: {} })
        })).filter(item => item.name) }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
      } : {})
    };

    let response;
    try {
      const endpoint = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (error) {
      retry++;
      const wait = retryDelay(retry);
      const reason = `error de red: ${String(error?.message || error).slice(0, 180)}`;
      if (failoverOnRetryable) throw deferredProviderError(model, retry, wait, reason);
      await onRetry({ retry, wait, reason });
      if (retry >= MAX_PROVIDER_RETRIES) throw deferredProviderError(model, retry, wait, reason);
      await sleep(wait);
      continue;
    }

    if (response.ok) {
      let data;
      let responseBody = '';
      try {
        if (typeof response.text === 'function') {
          responseBody = await response.text();
          data = parseProviderResponseBody(responseBody);
        } else data = await response.json();
        data = validateGeminiResponse(data);
      } catch (parseError) {
        retry++;
        const wait = retryDelay(retry);
        const reason = parseError?.code === 'PROVIDER_UNSUPPORTED_RESPONSE' ? 'formato de respuesta Gemini no compatible' : 'respuesta Gemini con JSON inválido';
        console.warn('[worker][gemini_invalid_response]', JSON.stringify({ model, attempt: retry, code: parseError?.code || 'PROVIDER_INVALID_JSON', bodyLength: responseBody.length }));
        if (failoverOnRetryable || retry >= MAX_PROVIDER_RETRIES) throw deferredProviderError(model, retry, wait, reason);
        await onRetry({ retry, wait, reason }); await sleep(wait); continue;
      }
      const candidate = data?.candidates?.[0];
      const translated = normalizeProviderResponse(data, { provider: 'Gemini', model });
      const content = translated.content;
      const usage = translated.usage;
      if (Array.isArray(translated.toolCalls) && translated.toolCalls.length) {
        if (!Array.isArray(tools) || !tools.length || typeof onToolCall !== 'function') {
          const error = new Error('Gemini solicitó herramientas sin un dispatcher autorizado.');
          error.code = 'AGENT_TOOL_DISPATCH_UNAVAILABLE';
          throw error;
        }
        if (toolRounds >= Math.max(1, Math.min(12, Number(maxToolRounds) || 8))) {
          const error = new Error('Gemini superó el máximo de rondas de herramientas permitido.');
          error.code = 'AGENT_TOOL_ROUND_LIMIT';
          throw error;
        }
        const calls = translated.toolCalls.slice(0, 8);
        requestMessages = [...requestMessages, { role: 'assistant', content, ...(Array.isArray(translated.providerData) ? { geminiParts: structuredClone(translated.providerData) } : {}), tool_calls: calls.map(call => ({
          id: String(call.id || randomUUID()), type: 'function',
          function: { name: String(call.name || ''), arguments: JSON.stringify(call.arguments ?? call.input ?? {}) },
          ...(call.thoughtSignature ? { thought_signature: String(call.thoughtSignature) } : {})
        })) }];
        toolRounds++;
        await saveConversation();
        await recoverPendingToolCalls();
        continue;
      }
      await onRetry({
        usage: true,
        usageId,
        model,
        promptTokens: Number(usage.inputTokens) || 0,
        completionTokens: Number(usage.outputTokens) || 0,
        totalTokens: Number(usage.totalTokens) || (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0)
      });

      if (!content.trim()) {
        emptyRetries++;
        const reason = `respuesta vacía (finishReason=${String(translated.finishReason || 'desconocido')})`;
        console.warn('[worker][gemini_empty_response]', JSON.stringify({ model, attempt: emptyRetries, reason }));
        if (emptyRetries <= 2) {
          const wait = retryDelay(emptyRetries);
          await onRetry({ retry: emptyRetries, wait, reason });
          await sleep(wait);
          continue;
        }
        throw deferredProviderError(model, emptyRetries, retryDelay(emptyRetries), reason);
      }

      if (content.length + accumulatedContent.length > 1000000) {
        throw new Error(`Gemini ${model} superó el límite acumulado de seguridad (1.000.000 caracteres).`);
      }
      accumulatedContent += content;
      const finishReason = translated.finishReason || null;
      await onPartialOutput({ content: accumulatedContent, finishReason, continuation: continuationCount });

      const truncated = finishReason === 'length';
      if (truncated && continueOnLength && !responseFormat && continuationCount < Math.max(0, Math.min(8, Number(maxContinuations) || 0))) {
        const allowance = await canContinue(safeMaxTokens, estimateInputTokens(requestMessages));
        if (!allowance || (typeof allowance === 'number' && allowance < 256)) {
          const error = new Error('Se alcanzó el presupuesto de tokens de esta tarea durante la continuación. El checkpoint previo se conserva; el motor ampliará el presupuesto o abrirá otra tanda automáticamente.');
          error.code = 'TASK_TOKEN_BUDGET';
          throw error;
        }
        if (typeof allowance === 'number') safeMaxTokens = Math.min(safeMaxTokens, Math.floor(allowance));
        continuationCount++;
        requestMessages = [
          ...requestMessages,
          { role: 'assistant', content },
          { role: 'user', content: 'Tu respuesta anterior se cortó por el límite de salida. Continuá EXACTAMENTE desde el último carácter, sin repetir ni resumir nada de lo anterior. Mantené el formato y completá la entrega. Si estás escribiendo un archivo, seguí el mismo archivo hasta terminarlo y marcá claramente cuándo finaliza.' }
        ];
        await saveConversation();
        console.info('[worker][gemini_continuation]', JSON.stringify({ model, continuation: continuationCount, maxContinuations }));
        continue;
      }
      if (truncated && continueOnLength) {
        const error = new Error(`La respuesta de Gemini ${model} sigue truncada tras ${continuationCount} continuaciones; dividí la entrega en módulos más pequeños o aumentá GEMINI_MAX_OUTPUT_TOKENS_PER_CALL.`);
        error.code = 'OUTPUT_TRUNCATED';
        throw error;
      }
      await saveConversation('completed', accumulatedContent);
      return accumulatedContent;
    }

    const bodyText = await response.text().catch(() => '');
    if (retryableStatus(response.status)) {
      retry++;
      const wait = retryDelay(retry, response.headers.get('retry-after'), bodyText);
      const reason = `HTTP ${response.status}`;
      // When another provider is configured, try it immediately instead of sleeping
      // through a quota/rate-limit window on this provider.
      if (failoverOnRetryable) throw deferredProviderError(model, retry, wait, reason);
      await onRetry({ retry, wait, reason });
      if (retry >= MAX_PROVIDER_RETRIES) throw deferredProviderError(model, retry, wait, reason);
      await sleep(wait);
      continue;
    }

    // Do not include the request URL in errors: the API key is passed as a query parameter.
    throw new Error(`Error de Gemini (${response.status}, modelo ${model}): ${bodyText.slice(0, 800)}`);
  }
}
