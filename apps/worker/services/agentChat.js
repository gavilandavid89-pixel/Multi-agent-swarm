import { consultarModelo } from './aiProviders.js';
import { getPayload, updateJob, recordTokenUsage } from './store.js';

const allowedAgents = new Set(['Arquitecto', 'Escéptico', 'Árbitro', 'Desarrollador', 'Validador', 'Coordinador de coherencia']);
const clip = (value, max = 5000) => String(value ?? '').slice(0, max);
const append = (list, item) => [...(Array.isArray(list) ? list : []), item].slice(-150);

export async function replyToAgent(jobId, requestedAgent, message) {
  const agent = allowedAgents.has(requestedAgent) ? requestedAgent : null;
  const text = String(message || '').trim();
  if (!agent) throw Object.assign(new Error('Elegí un agente válido.'), { status: 400 });
  if (!text) throw Object.assign(new Error('Escribí un mensaje para el agente.'), { status: 400 });
  if (text.length > 6000) throw Object.assign(new Error('El mensaje supera los 6.000 caracteres.'), { status: 413 });
  const record = await getPayload(jobId);
  if (!record) throw Object.assign(new Error('No existe esa tarea.'), { status: 404 });
  const payload = record.payload;
  const now = () => new Date().toISOString();
  const userEntry = { at: now(), agent: 'Usuario', type: 'message', content: text };
  await updateJob(jobId, { payload: { transcript: append(payload.transcript, userEntry) } });

  const context = [
    `OBJETIVO ORIGINAL:\n${clip(payload.objective, 1800)}`,
    `ESTRATEGIA:\n${clip(payload.strategy, 2200)}`,
    `MEMORIA COMPARTIDA SWARM-STATE (checkpoints duraderos):\n${clip(payload.sharedDocument, 2200)}`,
    `MAPA DE COHERENCIA:\n${clip(payload.coherence, 3000)}`,
    `ÚLTIMA AUDITORÍA DE COHERENCIA:\n${clip(JSON.stringify(payload.coherenceReview || {}), 1500)}`,
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
    Validador: 'Validador independiente: evaluá los hallazgos y separá errores demostrados de sospechas. No apruebes algo que no inspeccionaste.',
    'Coordinador de coherencia': 'Coordinador de coherencia: explicá los contratos entre archivos, dependencias y posibles incompatibilidades del mapa compartido. No afirmes que aplicaste cambios; indicá qué agente y qué archivo deberían cambiarse.'
  }[agent];
  const onRetry = async info => {
    if (info.usage) {
      const accounted = await recordTokenUsage(jobId, {
        ...info,
        agent,
        stage: 'Chat directo',
        interaction: 'direct-chat'
      });
      console.info('[worker][provider_usage]', JSON.stringify({
        jobId, model: info.model, agent, stage: 'Chat directo', interaction: 'direct-chat',
        promptTokens: info.promptTokens || 0, completionTokens: info.completionTokens || 0,
        totalTokens: info.totalTokens || 0, duplicateIgnored: Boolean(accounted.duplicate),
        countedAsWaste: Boolean(accounted.event?.countedAsWaste)
      }));
      return;
    }
    const fresh = await getPayload(jobId);
    if (!fresh) return;
    const transcript = append(fresh.payload.transcript, {
      at: now(), agent: 'sistema', type: 'retry',
      content: `[Chat directo · ${agent}] Reintento ${info.retry}; espera ${Math.ceil((info.wait || 0) / 1000)} s; motivo: ${clip(info.reason, 180)}`
    });
    await updateJob(jobId, { payload: { transcript } });
  };
  const geminiEnabled = Boolean(process.env.GEMINI_API_KEY);
  const model = agent === 'Validador'
    ? (geminiEnabled ? (process.env.GEMINI_MODEL_VALIDATION || 'gemini-3.8-flash') : (process.env.GROQ_MODEL_VALIDATION || 'openai/gpt-oss-20b'))
    : (geminiEnabled ? (process.env.GEMINI_MODEL_CODING || 'gemini-3.8-flash') : (process.env.GROQ_MODEL_CODING || 'openai/gpt-oss-120b'));
  const response = await consultarModelo({
    model, temperature: agent === 'Validador' ? 0 : 0.2, maxTokens: 1800, onRetry,
    messages: [
      { role: 'system', content: `Sos el agente ${agent} del comité Swarm. ${role} Respondé en español, breve pero útil. Esta es una conversación directa dentro de una tarea existente, no crees otra tarea. Sé honesto sobre lo que podés verificar.` },
      { role: 'user', content: context }
    ]
  });
  const fresh = await getPayload(jobId);
  if (fresh) {
    const transcript = append(fresh.payload.transcript, { at: now(), agent, type: 'message', content: clip(response, 12000) });
    await updateJob(jobId, { payload: { transcript } });
  }
  return { ok: true, taskId: jobId, agent, response };
}
