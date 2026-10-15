const MAX_AGENT_DOCUMENT_CHARS = 18000;
const MAX_SHARED_DOCUMENT_CHARS = 24000;
const MAX_AGENT_ENTRIES = 40;
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

  const sharedSection = [
    '## ' + entry.stage + ' — ' + clip(agent || 'Agente', 80),
    '',
    '- Fecha: ' + at,
    '',
    body || '_Sin resumen disponible._'
  ].join('\n');
  const sharedDocument = appendDocument(
    previous.sharedDocument || '# SWARM-STATE — Memoria compartida\n\nEsta memoria resume checkpoints persistidos. Confirmá los resultados de pruebas por separado.',
    sharedSection,
    MAX_SHARED_DOCUMENT_CHARS
  );
  return {
    agentDocuments: documents,
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
