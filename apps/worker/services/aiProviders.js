const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryableStatus = status => status === 408 || status === 425 || status === 429 || status >= 500;
const configuredRetries = Number.parseInt(process.env.MAX_PROVIDER_RETRIES || '4', 10);
const MAX_PROVIDER_RETRIES = Number.isFinite(configuredRetries) ? Math.min(8, Math.max(1, configuredRetries)) : 4;
function deferredProviderError(model, retry, wait, reason) {
  const error = new Error(`Proveedor temporalmente no disponible (${reason}); se reanudará en ${Math.ceil(wait / 1000)} s.`);
  error.code = 'PROVIDER_TEMPORARY'; error.retryAfterMs = wait; error.providerModel = model; error.providerRetry = retry;
  return error;
}
export function retryDelay(retry, retryAfter) {
  const configuredBase = Number(process.env.RETRY_BASE_MS || 3000);
  const base = Number.isFinite(configuredBase) ? Math.min(60000, Math.max(250, configuredBase)) : 3000;
  const numericRetryAfter = Number(retryAfter);
  let delay; let authoritative = false;
  if (Number.isFinite(numericRetryAfter) && numericRetryAfter > 0) { delay = Math.min(numericRetryAfter * 1000, 604800000); authoritative = true; }
  else {
    const dateRetryAfter = Date.parse(String(retryAfter || ''));
    if (Number.isFinite(dateRetryAfter)) { delay = Math.min(Math.max(0, dateRetryAfter - Date.now()), 604800000); authoritative = true; }
    else delay = Math.min(base * (2 ** Math.min(retry - 1, 8)), 900000);
  }
  return Math.max(250, Math.round(authoritative ? delay : delay * (0.8 + Math.random() * 0.4)));
}
export async function consultarModelo({ model, messages, temperature = 0.3, maxTokens = 1200, reasoningEffort = 'low', responseFormat, onRetry = () => {} }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Falta configurar GROQ_API_KEY en el motor externo.');
  let retry = 0; let emptyRetries = 0;
  const outputBudget = Number.parseInt(process.env.MAX_OUTPUT_TOKENS_PER_CALL || '6000', 10);
  const safeMaxTokens = Math.min(Math.max(256, Number.isFinite(outputBudget) ? outputBudget : 3200), Math.max(256, Number(maxTokens) || 1200));
  while (true) {
    let response;
    try { response = await fetch(GROQ_URL, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages, temperature, max_completion_tokens: safeMaxTokens, reasoning_effort: reasoningEffort, include_reasoning: false, ...(responseFormat ? { response_format: responseFormat } : {}) }) }); }
    catch (error) {
      retry++; const wait = retryDelay(retry); const reason = `error de red: ${String(error?.message || error).slice(0, 180)}`;
      onRetry({ retry, wait, reason });
      if (retry >= MAX_PROVIDER_RETRIES) throw deferredProviderError(model, retry, wait, reason);
      await sleep(wait); continue;
    }
    if (response.ok) {
      const data = await response.json(); const choice = data?.choices?.[0]; const message = choice?.message; const content = message?.content;
      const usage = data?.usage || {};
      onRetry({ usage: true, model, promptTokens: Number(usage.prompt_tokens) || 0, completionTokens: Number(usage.completion_tokens) || 0, totalTokens: Number(usage.total_tokens) || (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0) });
      if (typeof content !== 'string' || !content.trim()) {
        emptyRetries++;
        const diagnostic = `finish_reason=${String(choice?.finish_reason || 'desconocido')}; campos_mensaje=${Object.keys(message || {}).join(',') || 'ninguno'}; tokens_salida=${String(data?.usage?.completion_tokens ?? 'desconocido')}; razonamiento_oculto=${typeof message?.reasoning === 'string' ? message.reasoning.length : 0}`;
        console.warn('[worker][provider_empty_response]', JSON.stringify({ model, attempt: emptyRetries, diagnostic }));
        if (emptyRetries <= 2) { const wait = retryDelay(emptyRetries); onRetry({ retry: emptyRetries, wait, reason: `respuesta vacía del modelo (${diagnostic})` }); await sleep(wait); continue; }
        throw deferredProviderError(model, emptyRetries, retryDelay(emptyRetries), `respuesta vacía del modelo (${diagnostic})`);
      }
      if (content.length > 250000) throw new Error(`El modelo ${model} devolvió una respuesta demasiado grande (límite de seguridad: 250.000 caracteres).`);
      return content;
    }
    const body = await response.text().catch(() => '');
    if (retryableStatus(response.status)) {
      retry++; const wait = retryDelay(retry, response.headers.get('retry-after')); const reason = `HTTP ${response.status}`;
      onRetry({ retry, wait, reason });
      if (retry >= MAX_PROVIDER_RETRIES) throw deferredProviderError(model, retry, wait, reason);
      await sleep(wait); continue;
    }
    throw new Error(`Error permanente de Groq (${response.status}, modelo ${model}): ${body.slice(0, 800)}`);
  }
}
const sys = (role, instructions) => ({ role: 'system', content: `Sos el agente ${role} de un comité de ingeniería. Respondé en español salvo que el objetivo requiera otro idioma. Sé específico y no afirmes haber ejecutado pruebas que no ejecutaste. ${instructions}` });
const reasoningModel = () => process.env.GROQ_MODEL_REASONING || 'openai/gpt-oss-120b';
const codingModel = () => process.env.GROQ_MODEL_CODING || 'openai/gpt-oss-120b';
const validationModel = () => process.env.GROQ_MODEL_VALIDATION || 'openai/gpt-oss-20b';
function boundContext(value, maxChars, label) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.72);
  const tail = Math.floor(maxChars * 0.23);
  return `${text.slice(0, head)}\n\n[...${label} recortado para respetar el límite de tokens; se conserva el inicio y el final...]\n\n${text.slice(-tail)}`;
}
export async function agenteArquitecto(objetivo, onRetry) {
  return consultarModelo({ model: reasoningModel(), maxTokens: 1200, onRetry, messages: [sys('Arquitecto', 'Diseñá una solución modular, concreta y mantenible. Enumerá supuestos, componentes, riesgos y criterios de aceptación.'), { role: 'user', content: boundContext(objetivo, 6500, 'objetivo') }] });
}
export async function agenteEsceptico(objetivo, propuesta, onRetry) {
  return consultarModelo({ model: reasoningModel(), maxTokens: 1000, onRetry, messages: [sys('Escéptico/Auditor', 'Buscá fallos lógicos, amenazas, casos límite, dependencias y costos ocultos. Intentá refutar la propuesta de forma útil.'), { role: 'user', content: `OBJETIVO:\n${boundContext(objetivo, 1800, 'objetivo')}\n\nPROPUESTA DEL ARQUITECTO:\n${boundContext(propuesta, 5200, 'propuesta')}` }] });
}
export async function agenteArbitro(objetivo, propuesta, critica, onRetry) {
  return consultarModelo({ model: reasoningModel(), maxTokens: 1200, onRetry, messages: [sys('Árbitro técnico', 'Sintetizá una estrategia final y accionable. Resolvé explícitamente las objeciones válidas y señalá las incertidumbres restantes.'), { role: 'user', content: `OBJETIVO:\n${boundContext(objetivo, 1500, 'objetivo')}\n\nPROPUESTA:\n${boundContext(propuesta, 3000, 'propuesta')}\n\nAUDITORÍA ESCÉPTICA:\n${boundContext(critica, 3000, 'auditoría')}` }] });
}
export async function agenteDesarrollador(objetivo, estrategia, errores = '', onRetry, entregaActual = '') {
  const repairing = Boolean(errores && String(errores).trim());
  return consultarModelo({
    model: codingModel(), temperature: 0.15, maxTokens: repairing ? 2200 : 3000, onRetry,
    messages: [
      sys('Desarrollador sénior', repairing
        ? 'Corregí la entrega existente con el mínimo cambio necesario. No regeneres archivos que no están afectados. Revisá el código previo, corregí todos los hallazgos concretos y devolvé COMPLETOS solo los archivos que cambian, cada uno con encabezado exacto ### Archivo: ruta/archivo.ext y un bloque de código. Nunca recortes un archivo ni reemplaces su contenido por puntos suspensivos. Si un archivo es demasiado grande, priorizá un archivo por respuesta y declaralo explícitamente.'
        : 'Producí una solución utilizable. Si el objetivo requiere archivos, cada archivo debe aparecer por separado con un encabezado exacto ### Archivo: ruta/archivo.ext y debajo un bloque de código con su lenguaje; incluí el contenido completo, no fragmentos ni pseudocódigo. Usá rutas relativas seguras, sin .., y no mezcles archivos en un mismo bloque. No afirmes que pasó pruebas si no hay resultados reales.'),
      { role: 'user', content: 'OBJETIVO:\n' + boundContext(objetivo, 1200, 'objetivo') + '\n\nESTRATEGIA APROBADA:\n' + boundContext(estrategia, 2200, 'estrategia') + '\n\n' +
        (repairing ? 'HALLAZGOS QUE DEBÉS CORREGIR:\n' + boundContext(errores, 1600, 'hallazgos') + '\n\nENTREGA ACTUAL; conservá todo lo correcto y reemplazá solo los archivos afectados:\n' + boundContext(entregaActual, 6200, 'entrega actual') : 'Generá la primera versión completa.') }
    ]
  });
}
export function parseValidationResponse(rawValue) {
  const raw = String(rawValue ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { verdict: 'NEEDS_CHANGES', findings: ['El validador no devolvió JSON válido.'], summary: raw.slice(0, 1200), raw: raw.slice(0, 12000) };
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!['APPROVED', 'NEEDS_CHANGES'].includes(parsed.verdict) || !Array.isArray(parsed.findings) || typeof parsed.summary !== 'string') throw new Error('esquema inválido');
    return {
      verdict: parsed.verdict,
      findings: parsed.findings.slice(0, 30).map(value => String(value).slice(0, 2000)),
      summary: parsed.summary.slice(0, 5000),
      raw: raw.slice(0, 12000)
    };
  } catch {
    return { verdict: 'NEEDS_CHANGES', findings: ['El validador devolvió un formato inválido; no se aprueba automáticamente.'], summary: raw.slice(0, 1200), raw: raw.slice(0, 12000) };
  }
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
        sys('Validador independiente', 'Auditá SOLO los archivos del lote actual. Devolvé ÚNICAMENTE JSON válido con el esquema exacto: {"verdict":"APPROVED" o "NEEDS_CHANGES","findings":["..."],"summary":"..."}. Buscá truncamiento, errores lógicos y referencias a archivos faltantes. No afirmes haber revisado otros lotes.'),
        { role: 'user', content: 'LOTE ' + (i + 1) + '/' + batches.length + '\nOBJETIVO:\n' + boundContext(objetivo, 700, 'objetivo') + '\nESTRATEGIA:\n' + boundContext(estrategia, 1000, 'estrategia') + '\nARCHIVOS:\n' + batches[i] }
      ]
    });
    results.push(parseValidationResponse(raw));
  }
  const findings = [];
  results.forEach((result, index) => { if (result.verdict !== 'APPROVED') result.findings.forEach(finding => findings.push('Lote ' + (index + 1) + ': ' + finding)); });
  return {
    verdict: results.every(result => result.verdict === 'APPROVED') ? 'APPROVED' : 'NEEDS_CHANGES',
    findings: findings.slice(0, 30),
    summary: results.map((result, index) => 'Lote ' + (index + 1) + '/' + results.length + ': ' + result.summary).join('\n').slice(0, 5000),
    raw: results.map(result => result.raw || '').join('\n').slice(0, 12000),
    batchesReviewed: results.length
  };
}
