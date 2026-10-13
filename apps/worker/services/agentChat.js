import { consultarModelo } from './aiProviders.js';
import { getPayload, updateJob } from './store.js';

const allowedAgents = new Set(['Arquitecto', 'Escéptico', 'Árbitro', 'Desarrollador', 'Validador', 'Coordinador de coherencia']);
const clip = (value, max = 5000) => String(value ?? '').slice(0, max);
const append = (list, item) => [...(Array.isArray(list) ? list : []), item].slice(-150);

export async function replyToAgent(jobId, requestedAgent, message) {
  const agent = allowedAgents.has(requestedAgent) ? requestedAgent : null;
  const text = String(message || '').trim();
  if (!agent) throw Object.assign(new Error('Elegí un agente válido.'), { status: 400 });
  if (!text) throw Object.assign(new Error('Escribí un mensaje para el agente.'), { status: 400 });
  if (text.length > 6000) throw Object.assign(new Error('El mensaje supera los 6.000 caracteres.'), { status: 413 });
  const record = getPayload(jobId);
  if (!record) throw Object.assign(new Error('No existe esa tarea.'), { status: 404 });
  const payload = record.payload;
  const now = () => new Date().toISOString();
  const userEntry = { at: now(), agent: 'Usuario', type: 'message', content: text };
  updateJob(jobId, { payload: { transcript: append(payload.transcript, userEntry) } });

  const context = [
    `OBJETIVO ORIGINAL:\n${clip(payload.objective, 1800)}`,
    `ESTRATEGIA:\n${clip(payload.strategy, 2200)}`,\n    `MAPA DE COHERENCIA:\n${clip(payload.coherence, 3000)}`,\n    `ÚLTIMA AUDITORÍA DE COHERENCIA:\n${clip(JSON.stringify(payload.coherenceReview || {}), 1500)}`,
    `ENTREGA ACTUAL (extracto):\n${clip(payload.delivery, 2600)}`,
    `DIAGNÓSTICO DEL VALIDADOR:\n${clip(JSON.stringify(payload.validation || {}), 1800)}`,
    `SINTAXIS:\n${clip(JSON.stringify(payload.syntax || {}), 900)}`,
    `MENSAJE DEL USUARIO:\n${text}`
  ].join('\n\n');
  const role = {
    Arquitecto: 'Arquitecto técnico: aclará decisiones, arquitectura y riesgos; no inventes cambios ya aplicados.',
    Escéptico: 'Auditor escéptico: respondé con pruebas de refutación, riesgos concretos y formas de verificarlos.',
    Árbitro: 'Árbitro técnico: resolvé desacuerdos y proponé el siguiente paso más útil.',
    Desarrollador: 'Desarrollador sénior: diagnosticá y proponé cambios concretos. Si te piden corregir código, devolvé los archivos completos afectados usando ### Archivo: ruta y bloques de código; no afirmes haberlos aplicado.',
    Validador: 'Validador independiente: evaluá los hallazgos y separá errores demostrados de sospechas. No apruebes algo que no inspeccionaste.',\n    'Coordinador de coherencia': 'Coordinador de coherencia: explicá los contratos entre archivos, dependencias y posibles incompatibilidades del mapa compartido. No afirmes que aplicaste cambios; indicá qué agente y qué archivo deberían cambiarse.'
  }[agent];
  const current = getPayload(jobId)?.payload || payload;
  const prior = current.tokenUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, byModel: {} };
  const onRetry = info => {
    const fresh = getPayload(jobId);
    if (!fresh) return;
    const p = fresh.payload.tokenUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, byModel: {} };
    if (info.usage) {
      const model = String(info.model || 'desconocido');
      const promptTokens = Number(info.promptTokens) || 0;
      const completionTokens = Number(info.completionTokens) || 0;
      const totalTokens = Number(info.totalTokens) || promptTokens + completionTokens;
      const modelPrior = p.byModel?.[model] || { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
      const byModel = { ...(p.byModel || {}), [model]: { promptTokens: modelPrior.promptTokens + promptTokens, completionTokens: modelPrior.completionTokens + completionTokens, totalTokens: modelPrior.totalTokens + totalTokens, calls: modelPrior.calls + 1 } };
      const tokenUsage = { promptTokens: p.promptTokens + promptTokens, completionTokens: p.completionTokens + completionTokens, totalTokens: p.totalTokens + totalTokens, calls: p.calls + 1, byModel };
      const transcript = append(fresh.payload.transcript, { at: now(), agent: 'sistema', type: 'usage', content: JSON.stringify({ model, promptTokens, completionTokens, totalTokens }) });
      updateJob(jobId, { payload: { tokenUsage, transcript } });
    } else {
      const transcript = append(fresh.payload.transcript, { at: now(), agent: 'sistema', type: 'retry', content: `Chat directo · reintento ${info.retry}; espera ${Math.ceil((info.wait || 0) / 1000)} s; motivo: ${clip(info.reason, 180)}` });
      updateJob(jobId, { payload: { transcript } });
    }
  };
  const model = agent === 'Validador' ? (process.env.GROQ_MODEL_VALIDATION || 'openai/gpt-oss-20b') : (process.env.GROQ_MODEL_CODING || 'openai/gpt-oss-120b');
  const response = await consultarModelo({
    model, temperature: agent === 'Validador' ? 0 : 0.2, maxTokens: 1800, onRetry,
    messages: [
      { role: 'system', content: `Sos el agente ${agent} del comité Swarm. ${role} Respondé en español, breve pero útil. Esta es una conversación directa dentro de una tarea existente, no crees otra tarea. Sé honesto sobre lo que podés verificar.` },
      { role: 'user', content: context }
    ]
  });
  const fresh = getPayload(jobId);
  if (fresh) {
    const transcript = append(fresh.payload.transcript, { at: now(), agent, type: 'message', content: clip(response, 12000) });
    updateJob(jobId, { payload: { transcript } });
  }
  return { ok: true, taskId: jobId, agent, response };
}
