const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryableStatus = status => status === 408 || status === 425 || status === 429 || status >= 500;
export function retryDelay(retry, retryAfter) {
  const configuredBase = Number(process.env.RETRY_BASE_MS || 3000);
  const base = Number.isFinite(configuredBase) ? Math.min(60000, Math.max(250, configuredBase)) : 3000;
  const numericRetryAfter = Number(retryAfter);
  let delay;
  if (Number.isFinite(numericRetryAfter) && numericRetryAfter > 0) delay = Math.min(numericRetryAfter * 1000, 900000);
  else { const dateRetryAfter = Date.parse(String(retryAfter || '')); delay = Number.isFinite(dateRetryAfter) ? Math.min(Math.max(0, dateRetryAfter - Date.now()), 900000) : Math.min(base * (2 ** Math.min(retry - 1, 8)), 900000); }
  return Math.max(250, Math.round(delay * (0.8 + Math.random() * 0.4)));
}
export async function consultarModelo({ model, messages, temperature = 0.3, onRetry = () => {} }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Falta configurar GROQ_API_KEY en el motor externo.');
  let retry = 0;
  while (true) {
    let response;
    try { response = await fetch(GROQ_URL, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages, temperature }) }); }
    catch (error) { retry++; const wait = retryDelay(retry); onRetry({ retry, wait, reason: `error de red: ${error.message}` }); await sleep(wait); continue; }
    if (response.ok) {
      const data = await response.json(); const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error(`El modelo ${model} devolvió una respuesta vacía.`);
      if (content.length > 250000) throw new Error(`El modelo ${model} devolvió una respuesta demasiado grande (límite de seguridad: 250.000 caracteres).`);
      return content;
    }
    const body = await response.text().catch(() => '');
    if (retryableStatus(response.status)) { retry++; const wait = retryDelay(retry, response.headers.get('retry-after')); onRetry({ retry, wait, reason: `HTTP ${response.status}` }); await sleep(wait); continue; }
    throw new Error(`Error permanente de Groq (${response.status}, modelo ${model}): ${body.slice(0, 800)}`);
  }
}
const sys = (role, instructions) => ({ role: 'system', content: `Sos el agente ${role} de un comité de ingeniería. Respondé en español salvo que el objetivo requiera otro idioma. Sé específico y no afirmes haber ejecutado pruebas que no ejecutaste. ${instructions}` });
const reasoningModel = () => process.env.GROQ_MODEL_REASONING || 'llama-3.3-70b-versatile';
const codingModel = () => process.env.GROQ_MODEL_CODING || 'llama-3.3-70b-versatile';
const validationModel = () => process.env.GROQ_MODEL_VALIDATION || 'llama-3.1-8b-instant';
export async function agenteArquitecto(objetivo, onRetry) { return consultarModelo({ model: reasoningModel(), onRetry, messages: [sys('Arquitecto', 'Diseñá una solución modular, concreta y mantenible. Enumerá supuestos, componentes, riesgos y criterios de aceptación.'), { role: 'user', content: objetivo }] }); }
export async function agenteEsceptico(objetivo, propuesta, onRetry) { return consultarModelo({ model: reasoningModel(), onRetry, messages: [sys('Escéptico/Auditor', 'Buscá fallos lógicos, amenazas, casos límite, dependencias y costos ocultos. Intentá refutar la propuesta de forma útil.'), { role: 'user', content: `OBJETIVO:\n${objetivo}\n\nPROPUESTA DEL ARQUITECTO:\n${propuesta}` }] }); }
export async function agenteArbitro(objetivo, propuesta, critica, onRetry) { return consultarModelo({ model: reasoningModel(), onRetry, messages: [sys('Árbitro técnico', 'Sintetizá una estrategia final y accionable. Resolvé explícitamente las objeciones válidas y señalá las incertidumbres restantes.'), { role: 'user', content: `OBJETIVO:\n${objetivo}\n\nPROPUESTA:\n${propuesta}\n\nAUDITORÍA ESCÉPTICA:\n${critica}` }] }); }
export async function agenteDesarrollador(objetivo, estrategia, errores = '', onRetry) { return consultarModelo({ model: codingModel(), temperature: 0.2, onRetry, messages: [sys('Desarrollador sénior', 'Producí una solución utilizable. Para código, devolvé archivos con rutas y bloques de código etiquetados con su lenguaje. No afirmes que pasó pruebas si no hay resultados reales. Si recibís errores, corregilos directamente.'), { role: 'user', content: `OBJETIVO:\n${objetivo}\n\nESTRATEGIA APROBADA:\n${estrategia}\n\n${errores ? `ERRORES QUE DEBÉS CORREGIR:\n${errores}` : 'Generá la primera versión.'}` }] }); }
export function parseValidationResponse(rawValue) {
  const raw = String(rawValue ?? ''); const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { verdict: 'NEEDS_CHANGES', findings: ['El validador no devolvió JSON válido.'], summary: raw.slice(0, 1200), raw: raw.slice(0, 12000) };
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!['APPROVED', 'NEEDS_CHANGES'].includes(parsed.verdict) || !Array.isArray(parsed.findings) || typeof parsed.summary !== 'string') throw new Error('esquema inválido');
    return { verdict: parsed.verdict, findings: parsed.findings.slice(0, 30).map(value => String(value).slice(0, 2000)), summary: parsed.summary.slice(0, 5000), raw: raw.slice(0, 12000) };
  } catch { return { verdict: 'NEEDS_CHANGES', findings: ['El validador devolvió un formato inválido; no se aprueba automáticamente.'], summary: raw.slice(0, 1200), raw: raw.slice(0, 12000) }; }
}
export async function agenteValidador(objetivo, estrategia, entrega, onRetry) {
  const raw = await consultarModelo({ model: validationModel(), temperature: 0, onRetry, messages: [sys('Validador independiente', 'Auditá la entrega y devolvé ÚNICAMENTE JSON válido con este esquema exacto: {"verdict":"APPROVED" o "NEEDS_CHANGES","findings":["..."],"summary":"..."}. Usá APPROVED solo si no encontrás defectos relevantes. No incluyas APPROVED en summary/findings si el veredicto es NEEDS_CHANGES.'), { role: 'user', content: `OBJETIVO:
${objetivo}

ESTRATEGIA:
${estrategia}

ENTREGA A REVISAR:
${entrega}` }] });
  return parseValidationResponse(raw);
}