import { randomUUID } from 'node:crypto';
import { consultarGemini } from './geminiProvider.js';
import { assertUserAccountActive, currentUserProviders } from './userProviders.js';
import { getProviderRetryDelayMs } from './providerRetryPolicy.js';
import { safeProviderFetch } from './safeProviderFetch.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const KNOWN_PROVIDER_HOSTS = new Set([
  'api.openai.com', 'api.groq.com', 'openrouter.ai', 'generativelanguage.googleapis.com',
  'api.together.xyz', 'api.deepseek.com', 'api.mistral.ai', 'api.fireworks.ai',
  'api.perplexity.ai', 'api.cohere.com'
]);
async function fetchProviderEndpoint(url, options, baseUrl) {
  const target = new URL(url);
  const localDevelopmentEndpoint = process.env.NODE_ENV !== 'production' && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(String(baseUrl || ''));
  // The reserved .test TLD is used by mocked provider fixtures, never as a production custom host.
  const testFixtureEndpoint = process.env.NODE_ENV !== 'production' && /\.test$/i.test(target.hostname);
  if (KNOWN_PROVIDER_HOSTS.has(target.hostname.toLowerCase()) || localDevelopmentEndpoint || testFixtureEndpoint) {
    return fetch(url, { ...options, redirect: 'error' });
  }
  return safeProviderFetch(url, options);
}
// Feature branch: bounded continuation support.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryableStatus = status => status === 408 || status === 425 || status === 429 || status >= 500;
const configuredRetries = Number.parseInt(process.env.MAX_PROVIDER_RETRIES || '4', 10);
const MAX_PROVIDER_RETRIES = Number.isFinite(configuredRetries) ? Math.min(8, Math.max(1, configuredRetries)) : 4;
function deferredProviderError(model, retry, wait, reason, providerName = null) {
  const error = new Error(`Proveedor temporalmente no disponible (${reason}); se reanudará en ${Math.ceil(wait / 1000)} s.`);
  error.code = 'PROVIDER_TEMPORARY'; error.retryAfterMs = wait; error.providerModel = model; error.providerRetry = retry; error.providerName = providerName;
  return error;
}
export function retryDelay(retry, retryAfter, bodyText = '') {
  const configuredBase = Number(process.env.RETRY_BASE_MS || 3000);
  const base = Number.isFinite(configuredBase) ? Math.min(60000, Math.max(250, configuredBase)) : 3000;
  return getProviderRetryDelayMs({ retry, retryAfter, bodyText, baseMs: base, random: Math.random });
}
export function estimateInputTokens(messages) {
  const characters = (Array.isArray(messages) ? messages : []).reduce((sum, message) => sum + String(message?.content ?? '').length, 0);
  // Conservative estimate for Spanish and source code; provider-reported usage remains authoritative.
  return Math.ceil(characters / 2.5) + (Array.isArray(messages) ? messages.length * 8 : 0);
}


function isFailoverEligible(error) {
  if (error?.code === 'PROVIDER_TEMPORARY') return true;
  const status = Number(error?.providerStatus || error?.status);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function providerModelForSlot(provider, requestedModel, maxTokens) {
  const requested = String(requestedModel || '').trim();
  const slots = ['reasoning', 'coding', 'validation'];
  const exactSlot = slots.find(slot => String(provider.models?.[slot] || '').trim() === requested && requested);
  const slot = exactSlot || (Number(maxTokens) >= 5000 ? 'coding' : (/20b|validation/i.test(requested) ? 'validation' : 'reasoning'));
  return String(provider.models?.[slot] || provider.model || provider.models?.reasoning || provider.models?.coding || provider.models?.validation || '').trim();
}

export function configuredOpenAIProviders(requestedModel, maxTokens, env = process.env) {
  const providers = [];
  if (env.GROQ_API_KEY) {
    providers.push({
      name: 'Groq', baseUrl: GROQ_BASE_URL, apiKey: env.GROQ_API_KEY,
      model: Number(maxTokens) >= 5000
        ? (env.GROQ_MODEL_CODING || 'openai/gpt-oss-120b')
        : (env.GROQ_MODEL_REASONING || 'openai/gpt-oss-120b')
    });
  }
  let custom = [];
  try {
    const parsed = JSON.parse(env.AI_FALLBACK_PROVIDERS || '[]');
    if (Array.isArray(parsed)) custom = parsed.slice(0, 10);
    else console.warn('[worker][provider_config_invalid] AI_FALLBACK_PROVIDERS debe ser un array JSON.');
  } catch {
    if (env.AI_FALLBACK_PROVIDERS) console.warn('[worker][provider_config_invalid] AI_FALLBACK_PROVIDERS no contiene JSON válido.');
  }
  for (const entry of custom) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim().slice(0, 80);
    const baseUrl = String(entry.baseUrl || '').trim().replace(/\/+$/, '');
    const apiKeyEnv = String(entry.apiKeyEnv || '').trim();
    const apiKey = /^[A-Z][A-Z0-9_]{1,79}$/.test(apiKeyEnv) ? env[apiKeyEnv] : '';
    const validUrl = /^https:\/\//i.test(baseUrl) || (env.NODE_ENV !== 'production' && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(baseUrl));
    if (!name || !validUrl || !apiKey || providers.some(provider => provider.baseUrl === baseUrl)) continue;
    const model = providerModelForSlot(entry, requestedModel, maxTokens);
    if (!model) {
      console.warn('[worker][provider_config_invalid]', JSON.stringify({ name, reason: 'falta model o models.reasoning/coding/validation' }));
      continue;
    }
    providers.push({ name, baseUrl, apiKey, model });
  }
  return providers;
}

/**
 * Tries Gemini first when configured, then each configured OpenAI-compatible endpoint.
 * AI_FALLBACK_PROVIDERS contains endpoint/key-env/model metadata only, never API secrets.
 */
export async function consultarModelo(options) {
  return consultarWithProviderContext(options, currentUserProviders(), process.env);
}

export async function consultarWithProviderContext(options, userContext = null, env = process.env) {
  const { model, maxTokens = 1200 } = options;
  const beforeProviderRequest = userContext?.userId
    ? () => assertUserAccountActive(userContext.userId)
    : undefined;
  const providers = userContext
    ? userContext.providers.map(provider => ({ ...provider, model: providerModelForSlot(provider, model, maxTokens) })).filter(provider => provider.model)
    : configuredOpenAIProviders(model, maxTokens, env);
  const geminiProviders = userContext
    ? (Array.isArray(userContext.geminiProviders) ? userContext.geminiProviders : (userContext.gemini ? [userContext.gemini] : []))
    : (env.GEMINI_API_KEY ? [{
        name: 'Gemini',
        apiKey: env.GEMINI_API_KEY,
        models: {
          reasoning: env.GEMINI_MODEL_REASONING || 'gemini-3.8-flash',
          coding: env.GEMINI_MODEL_CODING || 'gemini-3.8-flash',
          validation: env.GEMINI_MODEL_VALIDATION || 'gemini-3.8-flash'
        }
      }] : []);
  for (let index = 0; index < geminiProviders.length; index++) {
    const gemini = geminiProviders[index];
    const hasNext = index < geminiProviders.length - 1 || providers.length > 0;
    try {
      return await consultarGemini({
        ...options,
        model: providerModelForSlot(gemini, model, maxTokens),
        apiKey: gemini.apiKey,
        beforeProviderRequest,
        failoverOnRetryable: hasNext
      });
    } catch (error) {
      if (!isFailoverEligible(error) || !hasNext) throw error;
      const nextGemini = geminiProviders[index + 1];
      const next = nextGemini
        ? { name: nextGemini.name || 'Gemini', model: providerModelForSlot(nextGemini, model, maxTokens) }
        : providers[0];
      console.warn('[worker][provider_failover]', JSON.stringify({
        from: gemini.name || 'Gemini', to: next.name,
        reason: error.code || 'provider unavailable', model: next.model
      }));
    }
  }
  if (!providers.length) throw new Error(userContext ? 'Esta cuenta no tiene proveedores de IA configurados. Abrí API 🔐 y agregá una clave.' : 'No hay proveedores de IA configurados. Configurá GEMINI_API_KEY, GROQ_API_KEY o AI_FALLBACK_PROVIDERS.');
  const errors = [];
  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];
    try {
      return await consultarOpenAICompatible({
        ...options, model: provider.model, apiKey: provider.apiKey,
        baseUrl: provider.baseUrl, providerName: provider.name,
        beforeProviderRequest,
        failoverAvailable: index < providers.length - 1
      });
    } catch (error) {
      errors.push({ provider: provider.name, reason: String(error?.message || error).slice(0, 220) });
      if (!isFailoverEligible(error) || index === providers.length - 1) throw error;
      console.warn('[worker][provider_failover]', JSON.stringify({
        from: provider.name, to: providers[index + 1].name,
        reason: error.code || 'provider unavailable', model: providers[index + 1].model
      }));
    }
  }
  const error = new Error('Todos los proveedores configurados están temporalmente limitados; la tarea se reanudará con el checkpoint guardado.');
  error.code = 'PROVIDER_TEMPORARY';
  error.retryAfterMs = 30000;
  error.providerModel = model;
  error.providerRetry = MAX_PROVIDER_RETRIES;
  error.providerErrors = errors;
  throw error;
}

async function consultarOpenAICompatible({ model, messages, temperature = 0.3, maxTokens = 1200, reasoningEffort = 'low', responseFormat, onRetry = () => {}, continueOnLength = false, maxContinuations = 4, canContinue = () => true, onPartialOutput = () => {}, apiKey: suppliedApiKey, baseUrl = GROQ_BASE_URL, providerName = 'OpenAI-compatible', beforeProviderRequest, failoverAvailable = false }) {
  const requestedOutputTokens = Math.max(256, Number(maxTokens) || 1200);
  const estimatedInputTokens = estimateInputTokens(messages);
  if (typeof onRetry.getMaxOutputTokens === 'function') {
    const allowance = Number(await onRetry.getMaxOutputTokens(requestedOutputTokens, estimatedInputTokens));
    if (!Number.isFinite(allowance) || allowance < 256) {
      const error = new Error('Presupuesto de tokens insuficiente para iniciar otra llamada. El checkpoint se conserva; el motor ampliará el presupuesto automáticamente o abrirá otra tanda.');
      error.code = 'TASK_TOKEN_BUDGET';
      throw error;
    }
    maxTokens = Math.min(requestedOutputTokens, Math.floor(allowance));
  } else {
    maxTokens = requestedOutputTokens;
  }
  const apiKey = suppliedApiKey;
  if (!apiKey) throw new Error(`Falta la credencial configurada para ${providerName}.`);
  let retry = 0; let emptyRetries = 0; let formatRetries = 0; let jsonFormatFallbacks = 0; let sizeRetries = 0; let continuationCount = 0; let accumulatedContent = ''; let requestMessages = messages;
  const outputBudget = Number.parseInt(process.env.MAX_OUTPUT_TOKENS_PER_CALL || '6000', 10);
  const maxSafeOutputTokens = Math.max(256, Number.isFinite(outputBudget) ? outputBudget : 3200);
  const requestedMaxTokens = Math.max(256, Number(maxTokens) || 1200);
  let safeMaxTokens = Math.min(maxSafeOutputTokens, requestedMaxTokens);
  while (true) {
    const currentInputEstimate = estimateInputTokens(requestMessages);
    if (typeof onRetry.getMaxOutputTokens === 'function') {
      const allowedNow = Number(await onRetry.getMaxOutputTokens(safeMaxTokens, currentInputEstimate));
      if (!Number.isFinite(allowedNow) || allowedNow < 256) { const error = new Error('Presupuesto insuficiente para la entrada y salida estimadas de esta llamada; se conserva el checkpoint.'); error.code = 'TASK_TOKEN_BUDGET'; throw error; }
      safeMaxTokens = Math.min(safeMaxTokens, Math.floor(allowedNow));
    }
    const usageId = randomUUID();
    if (beforeProviderRequest) await beforeProviderRequest();
    let response;
    try { response = await fetchProviderEndpoint(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: requestMessages, temperature, ...(providerName === 'Groq' ? { max_completion_tokens: safeMaxTokens, reasoning_effort: reasoningEffort, include_reasoning: false } : { max_tokens: safeMaxTokens }), ...(responseFormat && jsonFormatFallbacks === 0 ? { response_format: responseFormat } : {}) }) }, baseUrl); }
    catch (error) {
      const reason = `error de red: ${String(error?.message || error).slice(0, 180)}`;
      if (failoverAvailable) throw deferredProviderError(model, 1, retryDelay(1), reason, providerName);
      retry++; const wait = retryDelay(retry); await onRetry({ retry, wait, reason });
      if (retry >= MAX_PROVIDER_RETRIES) throw deferredProviderError(model, retry, wait, reason);
      await sleep(wait); continue;
    }
    if (response.ok) {
      const data = await response.json(); const choice = data?.choices?.[0]; const message = choice?.message; const content = message?.content;
      const usage = data?.usage || {};
      await onRetry({ usage: true, usageId, model, promptTokens: Number(usage.prompt_tokens) || 0, completionTokens: Number(usage.completion_tokens) || 0, totalTokens: Number(usage.total_tokens) || (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0) });
      if (typeof content !== 'string' || !content.trim()) {
        emptyRetries++;
        const diagnostic = `finish_reason=${String(choice?.finish_reason || 'desconocido')}; campos_mensaje=${Object.keys(message || {}).join(',') || 'ninguno'}; tokens_salida=${String(data?.usage?.completion_tokens ?? 'desconocido')}; razonamiento_oculto=${typeof message?.reasoning === 'string' ? message.reasoning.length : 0}`;
        console.warn('[worker][provider_empty_response]', JSON.stringify({ provider: providerName, model, attempt: emptyRetries, diagnostic }));
        if (emptyRetries <= 2) { const wait = retryDelay(emptyRetries); await onRetry({ retry: emptyRetries, wait, reason: `respuesta vacía del modelo (${diagnostic})` }); await sleep(wait); continue; }
        throw deferredProviderError(model, emptyRetries, retryDelay(emptyRetries), `respuesta vacía del modelo (${diagnostic})`);
      }
      if (content.length + accumulatedContent.length > 1000000) throw new Error(`El modelo ${model} superó el límite acumulado de seguridad (1.000.000 caracteres).`);
      accumulatedContent += content;
      await onPartialOutput({ content: accumulatedContent, finishReason: choice?.finish_reason || null, continuation: continuationCount });
      const truncated = choice?.finish_reason === 'length';
      if (truncated && continueOnLength && !responseFormat && continuationCount < Math.max(0, Math.min(8, Number(maxContinuations) || 0))) {
        const allowance = await canContinue(safeMaxTokens, estimateInputTokens(requestMessages));
        if (!allowance || (typeof allowance === 'number' && allowance < 256)) { const error = new Error('Se alcanzó el presupuesto de tokens de esta tarea durante la continuación. El checkpoint previo se conserva; el motor ampliará el presupuesto o abrirá otra tanda automáticamente.'); error.code = 'TASK_TOKEN_BUDGET'; throw error; }
        if (typeof allowance === 'number') safeMaxTokens = Math.min(safeMaxTokens, Math.floor(allowance));
        continuationCount++;
        requestMessages = [...requestMessages, { role: 'assistant', content }, { role: 'user', content: 'Tu respuesta anterior se cortó por el límite de salida. Continuá EXACTAMENTE desde el último carácter, sin repetir ni resumir nada de lo anterior. Mantené el formato y completá la entrega. Si estás escribiendo un archivo, seguí el mismo archivo hasta terminarlo y marcá claramente cuándo finaliza.' }];
        console.info('[worker][provider_continuation]', JSON.stringify({ provider: providerName, model, continuation: continuationCount, maxContinuations }));
        continue;
      }
      if (truncated && continueOnLength) { const error = new Error(`La respuesta de ${model} sigue truncada tras ${continuationCount} continuaciones; no se considera una entrega completa. Reducí el tamaño por módulo o aumentá MAX_CONTINUATION_CALLS.`); error.code = 'OUTPUT_TRUNCATED'; throw error; }
      return accumulatedContent;
    }
    const body = await response.text().catch(() => '');
    // Groq puede devolver 413 cuando entrada + salida solicitada exceden el TPM disponible.
    // Reducimos la salida y reintentamos; la solicitud rechazada no genera tokens de respuesta.
    if (response.status === 413) {
      const tpm = body.match(/\bLimit\s+(\d+)\s*,?\s*Requested\s+(\d+)/i);
      const limit = tpm ? Number(tpm[1]) : 0;
      const requested = tpm ? Number(tpm[2]) : 0;
      const excess = requested > limit ? requested - limit : 0;
      if (limit > 0 && excess > 0 && safeMaxTokens > 256 && sizeRetries < 4) {
        const previousMaxTokens = safeMaxTokens;
        safeMaxTokens = Math.max(256, safeMaxTokens - excess - 64);
        if (safeMaxTokens < previousMaxTokens) {
          sizeRetries++;
          const reason = `Solicitud 413 por límite TPM; se reduce la salida de ${previousMaxTokens} a ${safeMaxTokens} tokens (intento ${sizeRetries}/4)`;
          await onRetry({ retry: sizeRetries, wait: 0, reason });
          console.warn('[worker][provider_request_shrunk]', JSON.stringify({ provider: providerName, model, limit, requested, previousMaxTokens, maxCompletionTokens: safeMaxTokens, retry: sizeRetries }));
          continue;
        }
      }
      const error = new Error(limit > 0
        ? `El proveedor rechazó la solicitud por tamaño (HTTP 413; límite TPM ${limit}, solicitud ${requested}). Incluso reduciendo la salida no queda margen suficiente; dividí el trabajo o acortá el contexto.`
        : 'El proveedor rechazó la solicitud por tamaño (HTTP 413). Dividí el trabajo en módulos más pequeños o acortá el contexto.');
      error.code = 'PROVIDER_INPUT_TOO_LARGE'; error.providerModel = model; error.providerStatus = 413;
      throw error;
    }
    const jsonFormatRejected = response.status === 400 && /json_validate_failed|failed to generate json/i.test(body);
    const incompleteJsonGeneration = jsonFormatRejected && /max completion tokens reached before generating a valid document/i.test(body);
    if (jsonFormatRejected && responseFormat && jsonFormatFallbacks < 1 && (!incompleteJsonGeneration || safeMaxTokens >= maxSafeOutputTokens || formatRetries >= 2)) {
      jsonFormatFallbacks++;
      const reason = 'El proveedor rechazó el modo JSON estricto; se reintenta una sola vez con salida JSON validada por el motor.';
      await onRetry({ retry: jsonFormatFallbacks, wait: 250, reason });
      console.warn('[worker][provider_json_mode_fallback]', JSON.stringify({ provider: providerName, model, retry: jsonFormatFallbacks }));
      await sleep(250);
      continue;
    }
    if (incompleteJsonGeneration && responseFormat && formatRetries < 2 && safeMaxTokens < maxSafeOutputTokens) {
      formatRetries++;
      const previousMaxTokens = safeMaxTokens;
      safeMaxTokens = Math.min(maxSafeOutputTokens, Math.max(safeMaxTokens + 512, Math.ceil(safeMaxTokens * 1.75)));
      const wait = 250;
      const reason = `JSON incompleto por límite de salida; se amplía el límite de ${previousMaxTokens} a ${safeMaxTokens} tokens`;
      await onRetry({ retry: formatRetries, wait, reason });
      console.warn('[worker][provider_json_budget_retry]', JSON.stringify({ provider: providerName, model, retry: formatRetries, previousMaxTokens, maxCompletionTokens: safeMaxTokens }));
      await sleep(wait);
      continue;
    }
    // Algunos modelos/proveedores rechazan el JSON generado con HTTP 400 incluso después
    // de desactivar response_format. En validación esto debe convertirse en una respuesta
    // no aprobada que el motor pueda corregir, no en un fallo fatal que pierda la ejecución.
    if (jsonFormatRejected && responseFormat && jsonFormatFallbacks >= 1) {
      let failedGeneration = '';
      try { failedGeneration = JSON.parse(body)?.error?.failed_generation || ''; } catch {}
      const fallbackText = typeof failedGeneration === 'string' && failedGeneration.trim() ? failedGeneration : body;
      console.warn('[worker][provider_json_generation_rejected]', JSON.stringify({ provider: providerName, model, recoveredGeneratedText: Boolean(failedGeneration), fallback: 'validator-parser' }));
      return fallbackText;
    }
    if (retryableStatus(response.status)) {
      retry++; const wait = retryDelay(retry, response.headers.get('retry-after'), body); const reason = `HTTP ${response.status}`;
      if (failoverAvailable || wait > 5000) throw deferredProviderError(model, retry, wait, reason, providerName);
      await onRetry({ retry, wait, reason });
      if (retry >= MAX_PROVIDER_RETRIES) throw deferredProviderError(model, retry, wait, reason, providerName);
      // Brief transient limits can be retried in place; longer cooldowns are persisted
      // by the worker scheduler so one blocked provider cannot occupy a worker slot.
      await sleep(wait); continue;
    }
    throw new Error(`Error permanente de ${providerName} (${response.status}, modelo ${model}): ${body.slice(0, 800)}`);
  }
}
const sys = (role, instructions) => ({ role: 'system', content: `Sos el agente ${role} de un comité de ingeniería. Respondé en español salvo que el objetivo requiera otro idioma. Sé específico y no afirmes haber ejecutado pruebas que no ejecutaste. ${instructions}` });
function userModel(slot) {
  const context = currentUserProviders();
  if (!context) return null;
  if (context.gemini?.models?.[slot]) return context.gemini.models[slot];
  const provider = context.providers[0];
  return provider?.models?.[slot] || provider?.models?.reasoning || 'gpt-4o-mini';
}
const reasoningModel = () => userModel('reasoning') || (currentUserProviders() ? 'gpt-4o-mini' : process.env.GEMINI_API_KEY ? (process.env.GEMINI_MODEL_REASONING || 'gemini-3.8-flash') : (process.env.GROQ_MODEL_REASONING || 'openai/gpt-oss-120b'));
const codingModel = () => userModel('coding') || (currentUserProviders() ? 'gpt-4o-mini' : process.env.GEMINI_API_KEY ? (process.env.GEMINI_MODEL_CODING || 'gemini-3.8-flash') : (process.env.GROQ_MODEL_CODING || 'openai/gpt-oss-120b'));
const validationModel = () => userModel('validation') || (currentUserProviders() ? 'gpt-4o-mini' : process.env.GEMINI_API_KEY ? (process.env.GEMINI_MODEL_VALIDATION || 'gemini-3.8-flash') : (process.env.GROQ_MODEL_VALIDATION || 'openai/gpt-oss-20b'));
function boundContext(value, maxChars, label) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.72);
  const tail = Math.floor(maxChars * 0.23);
  return `${text.slice(0, head)}\n\n[...${label} recortado para respetar el límite de tokens; se conserva el inicio y el final...]\n\n${text.slice(-tail)}`;
}
export async function agenteCoordinador(objetivo, estrategia, propuesta, critica, onRetry) {
  return consultarModelo({
    model: reasoningModel(), temperature: 0.1, maxTokens: 1800, onRetry,
    messages: [
      sys('Coordinador de coherencia', 'Fijá un contrato de equipo conciso: alcance y decisiones invariables; inventario de módulos con responsable lógico; dependencias en orden; exportaciones/importaciones, rutas, esquemas y eventos compartidos; límites de seguridad; compatibilidad y criterios de coherencia. Distinguí archivos confirmados de propuestos. Evitá definir dos veces la misma responsabilidad. Indicá qué otros módulos hay que revisar si cambia un contrato. No inventes archivos ni presentes supuestos como hechos; cada agente debe avisar antes de romper un contrato.'),
      { role: 'user', content: 'OBJETIVO:\n' + boundContext(objetivo, 2200, 'objetivo') + '\n\nESTRATEGIA APROBADA:\n' + boundContext(estrategia, 2600, 'estrategia') + '\n\nPROPUESTA:\n' + boundContext(propuesta, 1400, 'propuesta') + '\n\nAUDITORÍA ESCÉPTICA:\n' + boundContext(critica, 1400, 'auditoría') }
    ]
  });
}
export async function agenteAuditorCoherencia(objetivo, mapaCoherencia, entrega, onRetry) {
  const source = String(entrega ?? '');
  const maxChars = 8500;
  const sections = source.split(/(?=^#{1,6}\s+(?:Archivo|File|Ruta)\s*:)/gim).filter(part => part.trim());
  const batches = [];
  if (source.length <= maxChars) batches.push(source);
  else if (sections.length > 1) {
    let current = '';
    for (const section of sections) {
      if (section.length > maxChars) return { verdict: 'NEEDS_CHANGES', findings: ['Un archivo supera el tamaño que el coordinador puede revisar completo. Dividilo en archivos o módulos más pequeños antes de aprobar la entrega.'], summary: 'Auditoría de coherencia incompleta: se rechazó un archivo demasiado grande para inspeccionarlo íntegramente.', raw: '' };
      if (current && current.length + section.length > maxChars) { batches.push(current); current = section; }
      else current += (current ? '\n\n' : '') + section;
    }
    if (current) batches.push(current);
  } else {
    return { verdict: 'NEEDS_CHANGES', findings: ['La entrega es demasiado larga y no tiene encabezados ### Archivo: para dividirla sin perder contenido.'], summary: 'Auditoría de coherencia incompleta; no se aprobó contenido que no pudo inspeccionarse íntegramente.', raw: '' };
  }
  if (batches.length > 8) return { verdict: 'NEEDS_CHANGES', findings: ['La entrega excede ocho lotes de auditoría. Agrupá o dividí los módulos para revisar todos los archivos completos.'], summary: 'Auditoría de coherencia detenida por límite de cobertura.', raw: '' };
  const manifestText = sections.map(section => section.split('\n', 1)[0].replace(/^#{1,6}\s+/, '').trim()).join('\n');
  const results = [];
  for (let i = 0; i < batches.length; i++) {
    const raw = await consultarModelo({
      model: validationModel(), temperature: 0, maxTokens: 1200, reasoningEffort: 'low',
      responseFormat: { type: 'json_object' }, onRetry,
      messages: [
        sys('Coordinador de coherencia · auditor', 'Auditá SOLO los archivos del lote actual contra el mapa de coherencia. Usá internamente tres alter egos y combiná sus hallazgos sin repetirlos: (1) Detective de contratos: nombres de funciones/clases, importaciones/exportaciones, rutas, formatos, configuración y dependencias; (2) Abogado del diablo: supuestos falsos, casos límite, errores lógicos, seguridad y comportamiento ante interrupciones; (3) Guardián de entrega: archivos completos, objetivo/criterios de aceptación y ausencia de contradicciones. Cada hallazgo debe incluir ruta concreta, evidencia textual verificable, impacto y corrección mínima; separá bloqueos reales de mejoras opcionales. Usá el mapa para comprobar contratos con otros lotes. El mensaje incluye el INVENTARIO COMPLETO de archivos: uno fuera de este lote puede existir en otro. PROHIBIDO afirmar que falta un archivo si figura en el inventario. No inventes incompatibilidades, no supongas pruebas ejecutadas y no marques como error algo no verificable. Devolvé ÚNICAMENTE JSON válido con el esquema exacto: {"verdict":"APPROVED" o "NEEDS_CHANGES","findings":["..."],"summary":"..."}. Si falta contexto crítico o la entrega está truncada, usá NEEDS_CHANGES. No afirmes haber ejecutado código.'),
        { role: 'user', content: 'LOTE ' + (i + 1) + '/' + batches.length + '\nOBJETIVO:\n' + boundContext(objetivo, 700, 'objetivo') + '\nMAPA DE COHERENCIA:\n' + boundContext(mapaCoherencia, 2200, 'mapa de coherencia') + '\nINVENTARIO COMPLETO DE ARCHIVOS DE LA ENTREGA (pueden estar distribuidos en otros lotes):\n' + manifestText + '\nARCHIVOS COMPLETOS DEL LOTE:\n' + batches[i] }
      ]
    });
    results.push(parseValidationResponse(raw));
  }
  const findings = [];
  results.forEach((result, index) => { if (result.verdict !== 'APPROVED') { const batchFindings = result.findings.length ? result.findings : ['El lote no fue aprobado, pero el validador no dio hallazgos concretos; hace falta una revisión verificable.']; batchFindings.forEach(finding => findings.push('Lote ' + (index + 1) + ': ' + finding)); } });
  return {
    verdict: results.every(result => result.verdict === 'APPROVED') ? 'APPROVED' : 'NEEDS_CHANGES',
    findings: findings.slice(0, 30),
    summary: results.map((result, index) => 'Lote ' + (index + 1) + '/' + results.length + ': ' + result.summary).join('\n').slice(0, 5000),
    raw: results.map(result => result.raw || '').join('\n').slice(0, 12000),
    batchesReviewed: results.length
  };
}
export async function agenteArquitecto(objetivo, onRetry) {
  return consultarModelo({ model: reasoningModel(), maxTokens: 1200, onRetry, messages: [sys('Arquitecto', 'Entregá una propuesta compacta con OBJETIVO/ALCANCE, decisiones e invariantes, módulos afectados, orden de etapas, criterios de aceptación observables, pruebas y riesgos/supuestos. Favorecé la solución mínima que satisfaga el objetivo; distinguí requisitos obligatorios de mejoras opcionales. No inventes infraestructura disponible ni prometas pruebas ejecutadas.'), { role: 'user', content: boundContext(objetivo, 6500, 'objetivo') }] });
}
export async function agenteEsceptico(objetivo, propuesta, onRetry) {
  return consultarModelo({ model: reasoningModel(), maxTokens: 1000, onRetry, messages: [sys('Escéptico/Auditor', 'Intentá refutar la propuesta con escenarios concretos de fallo, no con opiniones de estilo. Priorizá como BLOQUEANTE/ALTO/MEDIO; por cada hallazgo incluye condición que lo dispara, impacto y cómo comprobarlo. Máximo cinco riesgos distintos, eliminá duplicados y reconocé explícitamente los supuestos que no podés verificar.'), { role: 'user', content: `OBJETIVO:\n${boundContext(objetivo, 1800, 'objetivo')}\n\nPROPUESTA DEL ARQUITECTO:\n${boundContext(propuesta, 5200, 'propuesta')}` }] });
}
export async function agenteArbitro(objetivo, propuesta, critica, onRetry) {
  return consultarModelo({ model: reasoningModel(), maxTokens: 1200, onRetry, messages: [sys('Árbitro técnico', 'Resolvé cada hallazgo del Escéptico con decisión ACEPTAR/RECHAZAR/APLAZAR y una razón breve; no copies la crítica entera. Convertí los riesgos aceptados en controles verificables y producí un plan mínimo ordenado, criterios de aceptación y dudas que requieren decisión humana. No escondas desacuerdos sin resolver.'), { role: 'user', content: `OBJETIVO:\n${boundContext(objetivo, 1500, 'objetivo')}\n\nPROPUESTA:\n${boundContext(propuesta, 3000, 'propuesta')}\n\nAUDITORÍA ESCÉPTICA:\n${boundContext(critica, 3000, 'auditoría')}` }] });
}
export async function agenteDesarrollador(objetivo, estrategia, errores = '', onRetry, entregaActual = '', mapaCoherencia = '', canContinue = () => true, onPartialOutput = () => {}) {
  const repairing = Boolean(errores && String(errores).trim());
  return consultarModelo({
    model: codingModel(), temperature: 0.15, maxTokens: (currentUserProviders() ? Boolean(currentUserProviders().gemini) : Boolean(process.env.GEMINI_API_KEY)) ? (repairing ? 50000 : 60000) : (repairing ? 5000 : 6000), onRetry, continueOnLength: true, maxContinuations: Number.parseInt(process.env.MAX_CONTINUATION_CALLS || '4', 10), canContinue, onPartialOutput,
    messages: [
      sys('Desarrollador sénior', repairing
        ? 'Corregí la entrega existente con el mínimo cambio necesario. No regeneres archivos que no están afectados. Revisá el código previo, corregí todos los hallazgos concretos y devolvé COMPLETOS solo los archivos que cambian, cada uno con encabezado exacto ### Archivo: ruta/archivo.ext y un bloque de código. Nunca recortes un archivo ni reemplaces su contenido por puntos suspensivos. Si un archivo es demasiado grande, priorizá un archivo por respuesta y declaralo explícitamente.'
        : 'Producí una solución utilizable. Si el objetivo requiere archivos, cada archivo debe aparecer por separado con un encabezado exacto ### Archivo: ruta/archivo.ext y debajo un bloque de código con su lenguaje; incluí el contenido completo, no fragmentos ni pseudocódigo. Usá rutas relativas seguras, sin .., y no mezcles archivos en un mismo bloque. No afirmes que pasó pruebas si no hay resultados reales.'),
      { role: 'user', content: 'OBJETIVO:\n' + boundContext(objetivo, 1200, 'objetivo') + '\n\nESTRATEGIA APROBADA:\n' + boundContext(estrategia, 2200, 'estrategia') + '\n\n' +
        (mapaCoherencia ? 'MAPA COMPARTIDO DE COHERENCIA; respetá estos contratos entre archivos:\n' + boundContext(mapaCoherencia, 4200, 'mapa de coherencia') + '\n\n' : '') + (repairing ? 'HALLAZGOS QUE DEBÉS CORREGIR:\n' + boundContext(errores, 1600, 'hallazgos') + '\n\nENTREGA ACTUAL; conservá todo lo correcto y reemplazá solo los archivos afectados:\n' + boundContext(entregaActual, 6200, 'entrega actual') : 'Generá la primera versión completa.') }
    ]
  });
}
export function parseValidationResponse(rawValue) {
  const raw = String(rawValue ?? '');
  // Algunos endpoints OpenAI-compatibles codifican corchetes como entidades HTML o
  // escapan guiones bajos al degradar JSON estricto. Normalizamos solo estas variantes
  // comunes antes de analizar; la respuesta original se conserva en el diagnóstico.
  const normalizedRaw = raw.replace(/&#91;|&lbrack;/gi, '[').replace(/&#93;|&rbrack;/gi, ']').replace(/\\_/g, '_');
  const candidates = [];
  // Find balanced JSON objects rather than concatenating unrelated braces from code fences,
  // truncated prose, or multiple objects in a model response.
  for (let start = 0; start < normalizedRaw.length; start++) {
    if (normalizedRaw[start] !== '{') continue;
    let depth = 0; let quoted = false; let escaped = false;
    for (let end = start; end < normalizedRaw.length; end++) {
      const char = normalizedRaw[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { candidates.push(normalizedRaw.slice(start, end + 1)); break; }
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!['APPROVED', 'NEEDS_CHANGES'].includes(parsed?.verdict) || !Array.isArray(parsed.findings) || typeof parsed.summary !== 'string') continue;
      return {
        verdict: parsed.verdict,
        findings: parsed.findings.slice(0, 30).map(value => String(value).slice(0, 2000)),
        summary: parsed.summary.slice(0, 5000),
        raw: raw.slice(0, 12000)
      };
    } catch { /* Try the next balanced object; never approve malformed output. */ }
  }
  // Si el proveedor truncó el objeto, recuperá solo hallazgos completos o parcialmente visibles
  // cuando el veredicto explícito es NEEDS_CHANGES. Nunca se rescata APPROVED de JSON incompleto.
  const verdictMatch = normalizedRaw.match(/"verdict"\s*:\s*"(APPROVED|NEEDS_CHANGES)"/);
  const findingsStart = normalizedRaw.match(/"findings"\s*:\s*\[/);
  if (verdictMatch?.[1] === 'NEEDS_CHANGES' && findingsStart) {
    let cursor = findingsStart.index + findingsStart[0].length;
    const recovered = [];
    while (cursor < normalizedRaw.length && recovered.length < 30) {
      while (cursor < normalizedRaw.length && /[\s,]/.test(normalizedRaw[cursor])) cursor++;
      if (cursor >= normalizedRaw.length || normalizedRaw[cursor] === ']') break;
      if (normalizedRaw[cursor] !== '"') { cursor++; continue; }
      const start = cursor++;
      let escaped = false;
      let closed = false;
      while (cursor < normalizedRaw.length) {
        const char = normalizedRaw[cursor++];
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') { closed = true; break; }
      }
      const token = normalizedRaw.slice(start, cursor);
      let value = '';
      try { value = JSON.parse(closed ? token : token + '"'); }
      catch { value = token.slice(1).replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
      value = String(value).trim();
      if (value) recovered.push(value.slice(0, 2000));
      if (!closed) break;
    }
    if (recovered.length) {
      const summaryMatch = normalizedRaw.match(/"summary"\s*:\s*"((?:\\.|[^"\\])*)"/);
      let summary = 'El JSON del validador llegó truncado; se rescataron hallazgos visibles y no se aprobó automáticamente.';
      if (summaryMatch) { try { summary = JSON.parse('"' + summaryMatch[1] + '"').slice(0, 5000); } catch {} }
      return { verdict: 'NEEDS_CHANGES', findings: recovered, summary, raw: raw.slice(0, 12000) };
    }
  }
  return {
    verdict: 'NEEDS_CHANGES',
    findings: [candidates.length ? 'El validador devolvió JSON sin el esquema requerido; no se aprueba automáticamente.' : 'El validador no devolvió JSON válido.'],
    summary: raw.slice(0, 1200),
    raw: raw.slice(0, 12000)
  };
}
export async function agenteValidador(objetivo, estrategia, entrega, onRetry) {
  const source = String(entrega ?? '');
  const maxChars = 8500;
  const sections = source.split(/(?=^#{1,6}\s+(?:Archivo|File|Ruta)\s*:)/gim).filter(part => part.trim());
  const batches = [];
  if (source.length <= maxChars) batches.push(source);
  else if (sections.length > 1) {
    let current = '';
    for (const section of sections) {
      if (section.length > maxChars) {
        if (current) { batches.push(current); current = ''; }
        batches.push(section);
      } else if (current && current.length + section.length > maxChars) {
        batches.push(current); current = section;
      } else current += (current ? '\n\n' : '') + section;
    }
    if (current) batches.push(current);
  } else {
    return { verdict: 'NEEDS_CHANGES', findings: ['La entrega excede el tamaño revisable y no se puede dividir con seguridad por encabezados de archivo. Separá cada archivo con un encabezado ### Archivo: ruta y volvé a validar.'], summary: 'Revisión incompleta: no se aprueba una entrega que no pudo inspeccionarse por completo.', raw: '' };
  }
  if (batches.length > 8) return { verdict: 'NEEDS_CHANGES', findings: ['La entrega contiene más de ocho lotes; dividila en grupos más pequeños para garantizar una revisión completa.'], summary: 'La revisión se detuvo por un límite explícito de seguridad, no por falta de criterio del agente.', raw: '' };
  const results = [];
  for (let i = 0; i < batches.length; i++) {
    const raw = await consultarModelo({
      model: validationModel(), temperature: 0, maxTokens: 1000, reasoningEffort: 'low',
      responseFormat: { type: 'json_object' }, onRetry,
      messages: [
        sys('Validador independiente', 'Actuá como validador independiente con tres alter egos internos: (1) probador de aceptación, compara el objetivo con el código visible; (2) revisor adversarial, intenta refutar que funcione y busca casos límite/seguridad; (3) auditor de integración, busca imports y contratos inconsistentes. Auditá SOLO los archivos del lote actual. Los hallazgos deben citar ruta y evidencia, explicar impacto y proponer corrección mínima. No declares que el código se ejecutó: la sintaxis determinista se informa por separado. No rechaces por preferencias de estilo ni inventes archivos faltantes. Devolvé ÚNICAMENTE un objeto JSON válido con el esquema exacto: {"verdict":"APPROVED" o "NEEDS_CHANGES","findings":["..."],"summary":"..."}. No uses Markdown, bloques de código ni texto antes/después del objeto. No reemplaces corchetes por entidades HTML (&#91; o &#93;). Escapá las comillas dobles dentro de las cadenas y no uses comas finales. Limitá findings a 10 elementos y summary a 600 caracteres. Buscá truncamiento y errores lógicos. No afirmes haber revisado otros lotes.'),
        { role: 'user', content: 'LOTE ' + (i + 1) + '/' + batches.length + '\nOBJETIVO:\n' + boundContext(objetivo, 700, 'objetivo') + '\nESTRATEGIA:\n' + boundContext(estrategia, 1000, 'estrategia') + '\nARCHIVOS:\n' + batches[i] }
      ]
    });
    results.push(parseValidationResponse(raw));
  }
  const findings = [];
  results.forEach((result, index) => { if (result.verdict !== 'APPROVED') { const batchFindings = result.findings.length ? result.findings : ['El lote no fue aprobado, pero el validador no dio hallazgos concretos; hace falta una revisión verificable.']; batchFindings.forEach(finding => findings.push('Lote ' + (index + 1) + ': ' + finding)); } });
  return {
    verdict: results.every(result => result.verdict === 'APPROVED') ? 'APPROVED' : 'NEEDS_CHANGES',
    findings: findings.slice(0, 30),
    summary: results.map((result, index) => 'Lote ' + (index + 1) + '/' + results.length + ': ' + result.summary).join('\n').slice(0, 5000),
    raw: results.map(result => result.raw || '').join('\n').slice(0, 12000),
    batchesReviewed: results.length
  };
}
