const MAX_AGENT_DOCUMENT_CHARS = 18000;
const MAX_SHARED_DOCUMENT_CHARS = 24000;
const MAX_AGENT_ENTRIES = 40;
const MAX_SHARED_ENTRIES = 20;
const clip = (value, max) => String(value ?? '').slice(0, max);

function agentKey(name) {
  return clip(name || 'agente-desconocido', 80).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'agente';
}

function appendDocument(existing, section, maxChars) {
  const next = [String(existing || '').trim(), section.trim()].filter(Boolean).join('\n\n---\n\n');
  return next.length <= maxChars ? next : next.slice(next.length - maxChars);
}

/**
 * Keep durable, encrypted-by-store Markdown notes alongside the task checkpoint.
 * This is a compact working memory, not a substitute for the full transcript/artifacts.
 */
export function recordAgentCheckpoint(payload = {}, { at = new Date().toISOString(), agent, stage, content } = {}) {
  const previous = payload && typeof payload === 'object' ? payload : {};
  const documents = { ...(previous.agentDocuments || {}) };
  const key = agentKey(agent);
  const prior = documents[key] || { agent: clip(agent || 'Agente', 80), updatedAt: null, entries: [], markdown: '' };
  const body = clip(content, 5000).trim();
  const entry = { at, stage: clip(stage || 'Etapa sin nombre', 160), summary: body };
  const entries = [...(Array.isArray(prior.entries) ? prior.entries : []), entry].slice(-MAX_AGENT_ENTRIES);
  const section = [
    '# ' + prior.agent,
    '',
    '- Actualizado: ' + at,
    '- Etapa: ' + entry.stage,
    '',
    body || '_El agente no dejó un resumen textual._'
  ].join('\n');
  documents[key] = {
    agent: prior.agent,
    updatedAt: at,
    entries,
    markdown: appendDocument(prior.markdown, section, MAX_AGENT_DOCUMENT_CHARS)
  };

  const sharedEntries = [...(Array.isArray(previous.sharedDocumentEntries) ? previous.sharedDocumentEntries : []), {
    at,
    agent: clip(agent || 'Agente', 80),
    stage: entry.stage,
    summary: clip(body || '_Sin resumen disponible._', 500)
  }].slice(-MAX_SHARED_ENTRIES);
  const context = [
    '# SWARM-STATE — Memoria compartida',
    '',
    '## Objetivo original',
    clip(previous.objective || 'Objetivo no disponible en este checkpoint.', 2500),
    '',
    '## Plan / estrategia vigente',
    clip(previous.strategy || previous.proposal || 'El plan todavía no está definido.', 3000),
    '',
    '## Contratos y coherencia',
    clip(previous.coherence || 'Todavía no hay un mapa de coherencia guardado.', 2500),
    '',
    '## Estado de validación',
    clip(previous.validation?.summary || 'Todavía no hay un resultado de validación guardado.', 1200),
    '',
    '## Checkpoints recientes'
  ].join('\n');
  const history = sharedEntries.map(item => [
    '### ' + item.stage + ' — ' + item.agent,
    '- Fecha: ' + item.at,
    '',
    item.summary
  ].join('\n')).join('\n\n---\n\n');
  const sharedDocument = [context, history].filter(Boolean).join('\n\n').slice(0, MAX_SHARED_DOCUMENT_CHARS);
  return {
    agentDocuments: documents,
    sharedDocumentEntries: sharedEntries,
    sharedDocument,
    memoryUpdatedAt: at,
    memoryLastCheckpoint: { at, agent: clip(agent || 'Agente', 80), stage: clip(stage || '', 160) }
  };
}

export function getAgentMemorySnapshot(payload = {}) {
  const documents = payload?.agentDocuments && typeof payload.agentDocuments === 'object' ? payload.agentDocuments : {};
  return {
    updatedAt: payload?.memoryUpdatedAt || null,
    lastCheckpoint: payload?.memoryLastCheckpoint || null,
    sharedDocument: String(payload?.sharedDocument || ''),
    agents: Object.values(documents).map(item => ({
      agent: clip(item?.agent || 'Agente', 80),
      updatedAt: item?.updatedAt || null,
      entries: Array.isArray(item?.entries) ? item.entries.length : 0,
      markdown: String(item?.markdown || '')
    }))
  };
}
