import { getProviderRetryDelayMs } from './providerRetryPolicy.js';

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

function toGeminiContents(messages) {
  const contents = [];
  const systemParts = [];
  for (const item of Array.isArray(messages) ? messages : []) {
    const text = String(item?.content ?? '');
    if (!text) continue;
    if (item.role === 'system') {
      systemParts.push({ text });
      continue;
    }
    const role = item.role === 'assistant' ? 'model' : 'user';
    const previous = contents[contents.length - 1];
    if (previous?.role === role) previous.parts.push({ text });
    else contents.push({ role, parts: [{ text }] });
  }
  return {
    contents,
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {})
  };
}

function extractText(candidate) {
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(part => typeof part?.text === 'string' ? part.text : '').join('');
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
  onPartialOutput = () => {}
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Falta configurar GEMINI_API_KEY en el servicio swarm-worker.');

  const configuredOutput = Number.parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS_PER_CALL || '60000', 10);
  const maxSafeOutputTokens = Math.min(60000, Math.max(256, Number.isFinite(configuredOutput) ? configuredOutput : 60000));
  const requestedMaxTokens = Math.max(256, Number(maxTokens) || 1200);
  let safeMaxTokens = Math.min(maxSafeOutputTokens, requestedMaxTokens);
  let retry = 0;
  let emptyRetries = 0;
  let continuationCount = 0;
  let accumulatedContent = '';
  let requestMessages = messages;

  while (true) {
    const converted = toGeminiContents(requestMessages);
    if (!converted.contents.length) throw new Error('Gemini recibió una conversación vacía.');
    const body = {
      ...converted,
      generationConfig: {
        temperature,
        maxOutputTokens: safeMaxTokens,
        ...(responseFormat ? { responseMimeType: 'application/json' } : {})
      }
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
      await onRetry({ retry, wait, reason });
      if (retry >= MAX_PROVIDER_RETRIES) throw deferredProviderError(model, retry, wait, reason);
      await sleep(wait);
      continue;
    }

    if (response.ok) {
      const data = await response.json();
      const candidate = data?.candidates?.[0];
      const content = extractText(candidate);
      const usage = data?.usageMetadata || {};
      await onRetry({
        usage: true,
        model,
        promptTokens: Number(usage.promptTokenCount) || 0,
        completionTokens: Number(usage.candidatesTokenCount) || 0,
        totalTokens: Number(usage.totalTokenCount) || (Number(usage.promptTokenCount) || 0) + (Number(usage.candidatesTokenCount) || 0)
      });

      if (!content.trim()) {
        emptyRetries++;
        const reason = `respuesta vacía (finishReason=${String(candidate?.finishReason || 'desconocido')})`;
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
      const finishReason = candidate?.finishReason || null;
      await onPartialOutput({ content: accumulatedContent, finishReason, continuation: continuationCount });

      const truncated = finishReason === 'MAX_TOKENS' || finishReason === 'LENGTH';
      if (truncated && continueOnLength && !responseFormat && continuationCount < Math.max(0, Math.min(8, Number(maxContinuations) || 0))) {
        if (!(await canContinue())) {
          const error = new Error('Se alcanzó el presupuesto de tokens de esta tarea durante la continuación. El checkpoint previo se conserva; ampliá el límite desde la interfaz para reanudar.');
          error.code = 'TASK_TOKEN_BUDGET';
          throw error;
        }
        continuationCount++;
        requestMessages = [
          ...requestMessages,
          { role: 'assistant', content },
          { role: 'user', content: 'Tu respuesta anterior se cortó por el límite de salida. Continuá EXACTAMENTE desde el último carácter, sin repetir ni resumir nada de lo anterior. Mantené el formato y completá la entrega. Si estás escribiendo un archivo, seguí el mismo archivo hasta terminarlo y marcá claramente cuándo finaliza.' }
        ];
        console.info('[worker][gemini_continuation]', JSON.stringify({ model, continuation: continuationCount, maxContinuations }));
        continue;
      }
      if (truncated && continueOnLength) {
        const error = new Error(`La respuesta de Gemini ${model} sigue truncada tras ${continuationCount} continuaciones; dividí la entrega en módulos más pequeños o aumentá GEMINI_MAX_OUTPUT_TOKENS_PER_CALL.`);
        error.code = 'OUTPUT_TRUNCATED';
        throw error;
      }
      return accumulatedContent;
    }

    const bodyText = await response.text().catch(() => '');
    if (retryableStatus(response.status)) {
      retry++;
      const wait = retryDelay(retry, response.headers.get('retry-after'), bodyText);
      const reason = `HTTP ${response.status}`;
      // A very long Gemini 429 cooldown usually indicates exhausted quota, not a short transient.
      // If Groq is configured, fail over immediately instead of sleeping for many hours.
      if (response.status === 429 && wait >= 5 * 60 * 1000 && process.env.GROQ_API_KEY) {
        throw deferredProviderError(model, retry, wait, reason);
      }
      await onRetry({ retry, wait, reason });
      if (retry >= MAX_PROVIDER_RETRIES) throw deferredProviderError(model, retry, wait, reason);
      await sleep(wait);
      continue;
    }

    // Do not include the request URL in errors: the API key is passed as a query parameter.
    throw new Error(`Error de Gemini (${response.status}, modelo ${model}): ${bodyText.slice(0, 800)}`);
  }
}
